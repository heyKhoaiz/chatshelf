// Extension test: runs inside a VS Code window started by test/vscode.mjs, against demo data.
// Opens Chatshelf and waits for the webview's own first requests, which proves that the page
// loaded under the CSP, its scripts ran, and the message bridge reaches core.mjs.
const vscode = require('vscode');
const assert = require('node:assert/strict');

const waitFor = (api, route, ms = 20000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { sub.dispose(); reject(new Error(`no ${route} from the webview within ${ms} ms`)); }, ms);
  const sub = api.onDidAnswer((e) => { if (e.route === route) { clearTimeout(timer); sub.dispose(); resolve(e); } });
});

exports.run = async () => {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'chatshelf' && e.extensionPath.endsWith('vscode'));
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const projects = waitFor(api, 'GET /api/projects');
  await vscode.commands.executeCommand('chatshelf.open');
  const r = await projects;
  assert.ok(r.ok, r.error);
  assert.ok(r.data.projects.length > 0, 'no demo projects');
  console.log(`  ok  webview loaded and listed ${r.data.projects.length} projects through the bridge`);

  // The rest sends messages the way the webview does.
  const p = r.data.projects.find((x) => x.source === 'claude' && x.exists && x.sessions.length);
  assert.ok(p, 'no demo Claude project with a folder');
  const id = p.sessions[0].id;
  const newTerminal = (name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sub.dispose(); reject(new Error(`no "${name}" terminal opened`)); }, 10000);
    const sub = vscode.window.onDidOpenTerminal((t) => { if (t.name === name) { clearTimeout(timer); sub.dispose(); resolve(t); } });
  });

  let opened = newTerminal('claude');
  let res = await api.request({ type: 'api', method: 'POST', path: '/api/open-terminal', body: { key: p.key, id } });
  assert.ok(res.ok, res.error);
  let t = await opened;
  assert.equal(t.creationOptions.cwd, p.cwd);
  assert.match(t.creationOptions.shellArgs.join(' '), new RegExp(`^-lc claude --resume ${id}; exec`));
  t.dispose();
  console.log('  ok  "Open in terminal" runs claude --resume in the VS Code terminal, in the project folder');

  opened = newTerminal('Codex');
  res = await api.request({ type: 'api', method: 'POST', path: '/api/handoff', body: { key: p.key, id, target: 'codex', text: '# Handoff\nGo on.' } });
  assert.ok(res.ok, res.error);
  assert.equal(res.data.target, 'Codex');
  t = await opened;
  assert.match(t.creationOptions.shellArgs.join(' '), /^-lc codex "\$\(cat '.+chatshelf-handoff-[0-9a-f]+\.md'\)"; exec/);
  t.dispose();
  console.log('  ok  handoff starts codex in the VS Code terminal');

  const before = await vscode.env.clipboard.readText();
  try {
    res = await api.request({ type: 'copy', text: 'chatshelf clipboard test' });
    assert.ok(res.ok, res.error);
    assert.equal(await vscode.env.clipboard.readText(), 'chatshelf clipboard test');
  } finally {
    await vscode.env.clipboard.writeText(before);
  }
  console.log('  ok  copy uses the VS Code clipboard');

  const chat = JSON.stringify([{ uuid: 'c0ffee00-0000-4000-8000-000000000002', name: 'Hello', created_at: new Date().toISOString(), chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Hi there, how are you today?' }, { uuid: 'm2', sender: 'assistant', text: 'Hello!' }] }]);
  res = await api.request({ type: 'api', method: 'POST', path: '/api/import', file: new TextEncoder().encode(chat).buffer, filename: 'conversations.json' });
  assert.ok(res.ok, res.error);
  assert.equal(res.data.added, 1);
  res = await api.request({ type: 'api', method: 'POST', path: '/api/imports/delete', body: { source: res.data.source } });
  assert.ok(res.ok, res.error);
  console.log('  ok  imports a claude.ai export sent as bytes, and removes it');

  for (const [m, why] of [
    [{ type: 'open-url', url: 'file:///etc/hosts' }, 'a non-web link'],
    [{ type: 'open-url', url: 'command:workbench.action.quit' }, 'a command link'],
    [{ type: 'api', method: 'GET', path: '/index.html' }, 'a path outside /api/'],
    [{ type: 'api', method: 'GET', path: '/api/nope' }, 'an unknown route'],
    [{ type: 'run', cmd: 'ls' }, 'an unknown message type'],
  ]) assert.equal((await api.request(m)).ok, false, `accepted ${why}`);
  console.log('  ok  refuses non-web links, paths outside /api/ and unknown messages');
};
