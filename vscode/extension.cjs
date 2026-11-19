// Chatshelf for VS Code: the same app as `npx chatshelf`, in an editor tab.
// No web server: the page runs in a webview and its API calls arrive here as messages, which go
// straight to core.mjs. The webview can only load its own files (strict CSP, nonce on scripts).
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Packaged, the app files are copied into ./app (scripts/pack-vscode.mjs).
// Running from the repo (F5 or --extensionDevelopmentPath), they're one folder up.
const APP = fs.existsSync(path.join(__dirname, 'app', 'core.mjs')) ? path.join(__dirname, 'app') : path.join(__dirname, '..');
const PUBLIC = path.join(APP, 'public');
const IMPORT_MAX = 600 * 1024 * 1024;

let corePromise;
function core() {
  corePromise ||= import(pathToFileURL(path.join(APP, 'core.mjs')).href).then((m) => {
    m.setTerminalRunner(runInTerminal);
    return m;
  });
  return corePromise;
}

// "Open in terminal" and handoffs run in VS Code's own terminal, the same way the web app runs them:
// the command first, then the user's shell, so the terminal stays open afterwards.
async function runInTerminal({ cwd, command, name }) {
  const t = process.platform === 'win32'
    ? vscode.window.createTerminal({ name, cwd })
    : vscode.window.createTerminal({ name, cwd, shellPath: fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', shellArgs: ['-lc', `${command}; exec "\${SHELL:-bash}"`] });
  if (process.platform === 'win32') t.sendText(command);
  t.show();
  return 'the terminal';
}

let panel;
function open(context) {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('chatshelf', 'Chatshelf', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.file(PUBLIC)],
  });
  panel.iconPath = vscode.Uri.file(path.join(PUBLIC, 'favicon.svg'));
  panel.webview.html = page(panel.webview, context.extension.packageJSON.version);
  panel.webview.onDidReceiveMessage((m) => onMessage(panel.webview, m), null, context.subscriptions);
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

function page(webview, version) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const kind = vscode.window.activeColorTheme.kind;
  const theme = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light';
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace('<html', `<html data-vscode="${theme}"`)
    .replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replaceAll('<script', `<script nonce="${nonce}"`)
    .replace(/(src|href)="\/([\w.-]+\.(?:svg|css|js))"/g, (_, attr, file) => `${attr}="${webview.asWebviewUri(vscode.Uri.file(path.join(PUBLIC, file)))}"`)
    .replace('__TOKEN__', '')
    .replaceAll('__VERSION__', version);
}

// Fires { type, route, ok } after each answered request (used by the extension test).
const answered = new vscode.EventEmitter();

async function onMessage(webview, m) {
  if (!m || typeof m.id !== 'number') return;
  const route = m.type === 'api' ? `${m.method} ${String(m.path).split('?')[0]}` : m.type;
  const reply = (data) => { answered.fire({ route, ok: true, data }); return webview.postMessage({ type: 'reply', id: m.id, ok: true, data }); };
  try {
    switch (m.type) {
      case 'api': {
        const { handle } = await core();
        const url = new URL(String(m.path), 'http://chatshelf');
        if (!url.pathname.startsWith('/api/')) throw new Error('Not found.');
        const method = m.method === 'POST' ? 'POST' : 'GET';
        let body = m.body && typeof m.body === 'object' ? m.body : {};
        if (url.pathname === '/api/import') {
          const buf = Buffer.from(m.file || []);
          if (buf.length > IMPORT_MAX) throw new Error('That file is too large.');
          body = { buf, filename: String(m.filename || '') };
        }
        return reply(await handle(`${method} ${url.pathname}`, url.searchParams, body));
      }
      case 'open-url': {
        const uri = vscode.Uri.parse(String(m.url));
        if (uri.scheme !== 'https' && uri.scheme !== 'http') throw new Error('Only web links can be opened.');
        await vscode.env.openExternal(uri);
        return reply({});
      }
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text));
        return reply({});
      case 'save': {
        const name = String(m.name || 'handoff.md').replace(/[^\w.-]/g, '-');
        const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('node:os').homedir();
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(dir, name)), filters: { Markdown: ['md'] } });
        if (!uri) return reply({ saved: false });
        await vscode.workspace.fs.writeFile(uri, Buffer.from(String(m.text), 'utf8'));
        return reply({ saved: true });
      }
      default:
        throw new Error('Unknown request.');
    }
  } catch (e) {
    answered.fire({ route, ok: false, error: e.message });
    webview.postMessage({ type: 'reply', id: m.id, ok: false, error: e.message || 'Something went wrong.' });
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('chatshelf.open', () => open(context)), answered);
  // For the extension test: send a message exactly as the webview would, and get its reply.
  const request = (m) => new Promise((resolve) => onMessage({ postMessage: resolve }, { id: 0, ...m }));
  return { onDidAnswer: answered.event, request };
}

module.exports = { activate, deactivate() {} };
