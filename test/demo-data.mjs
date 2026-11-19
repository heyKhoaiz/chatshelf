// Builds a fake home folder with chats from several tools, for the demo, screenshots and tests.
// Usage: node test/demo-data.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY = 864e5;
const encode = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
const uuid = () => crypto.randomUUID();

// [daysAgo, project, title prompt, follow-ups, assistant reply]
const CLAUDE_CHATS = [
  [0, 'acme-web', 'Add a dark mode toggle to the settings page', ['Remember the choice in localStorage', 'ship it'],
    'I added a **Theme** switch to `SettingsPage.tsx`:\n\n- Light, Dark and System options\n- The choice is saved in `localStorage`\n- No flash on load: a small inline script sets the theme first\n\n```ts\nconst pref = localStorage.getItem("theme") ?? "system";\n```'],
  [0, 'api-server', 'Why does the /orders endpoint return 500 on empty carts?', ['add a test for it'],
    'The handler divides by `cart.items.length` to get the average price. With an empty cart that is `0/0`, which the serializer rejects. I return early for empty carts and added `orders.empty-cart.test.ts`.'],
  [1, 'acme-web', 'Write release notes for version 2.4', ['make it shorter'],
    '## 2.4\n\n- Dark mode\n- Faster search (about 3x on large workspaces)\n- Fixed: export sometimes skipped the last row'],
  [2, 'api-server', 'Set up rate limiting for the public API', ['use a sliding window', 'document the headers'],
    'Requests are now limited to 120 per minute per key with a sliding window. Responses include `RateLimit-Remaining` and `RateLimit-Reset`.'],
  [4, 'mobile', 'Fix the crash when the camera permission is denied', ['also handle "ask every time"'],
    'The crash came from reading `stream.getTracks()` on `null`. I now show a short explanation with a **Open settings** button instead.'],
  [6, 'mobile', 'Plan the offline sync for notes', [],
    'Store edits in a local queue, sync when online, and resolve conflicts by the newest edit per field.'],
  [9, 'acme-web', 'Migrate the date picker to the new design system', ['keep keyboard support'],
    'Done. Arrow keys move by day, Page Up/Down by month, and Home/End jump to the week edges.'],
  [16, 'api-server', 'Add OpenAPI docs for the billing routes', [],
    'I documented `POST /billing/checkout`, `GET /billing/invoices` and the webhook payloads.'],
  [23, 'acme-web', 'Reduce the bundle size of the dashboard', ['which packages are the biggest?'],
    'The three largest are the chart library (41%), the date library (12%) and icons (9%). Lazy-loading the charts cuts the first load by 38%.'],
  [31, 'api-server', 'Investigate slow queries on the reports page', [],
    'Two queries scan the whole `events` table. An index on `(account_id, created_at)` brings them from 2.1 s to 40 ms.'],
];

function writeLines(file, lines, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

export function makeDemoHome(home) {
  const now = Date.now();
  const projects = {
    'acme-web': path.join(home, 'code', 'acme-web'),
    'api-server': path.join(home, 'code', 'api-server'),
    // "mobile" was renamed to "mobile-app", so its sessions show as "folder missing".
    mobile: path.join(home, 'code', 'mobile'),
  };
  fs.mkdirSync(projects['acme-web'], { recursive: true });
  fs.mkdirSync(projects['api-server'], { recursive: true });
  fs.mkdirSync(path.join(home, 'code', 'mobile-app'), { recursive: true });

  // Claude Code
  for (const [daysAgo, proj, first, more, reply] of CLAUDE_CHATS) {
    const cwd = projects[proj];
    const sid = uuid();
    const t0 = now - daysAgo * DAY - 2 * 3600e3;
    const lines = [];
    let parent = null;
    const add = (type, content, i, extra = {}) => {
      const id = uuid();
      lines.push({ type, uuid: id, parentUuid: parent, sessionId: sid, cwd, gitBranch: 'main', timestamp: new Date(t0 + i * 60e3).toISOString(), message: { role: type, content, ...extra } });
      parent = id;
    };
    // Made-up token counts, so the Usage page has something to show.
    const usage = (n) => ({ model: n % 3 ? 'claude-sonnet-5-5' : 'claude-opus-5-5', id: `msg_${uuid()}`, usage: { input_tokens: 40 + n * 7, output_tokens: 600 + n * 90, cache_creation_input_tokens: 4000 + n * 300, cache_read_input_tokens: 18000 + n * 2500 } });
    let i = 0;
    let n = daysAgo;
    for (const prompt of [first, ...more]) {
      add('user', prompt, i++);
      const content = [{ type: 'text', text: i === 1 ? reply : 'Done.' }];
      // The first reply edits a file, for the "Files changed" list.
      if (i === 1) content.push({ type: 'tool_use', id: `toolu_${uuid()}`, name: 'Edit', input: { file_path: path.join(cwd, 'src', `${proj}-${daysAgo}.ts`), old_string: 'a', new_string: 'b' } });
      add('assistant', content, i++, usage(n++));
    }
    writeLines(path.join(home, '.claude', 'projects', encode(cwd), `${sid}.jsonl`), lines, t0 + i * 60e3);
  }

  // Codex
  const codexId = uuid();
  const ct = now - 3 * DAY;
  const day = new Date(ct);
  const codexFile = path.join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'), `rollout-demo-${codexId}.jsonl`);
  const ts = (m) => new Date(ct + m * 60e3).toISOString();
  writeLines(codexFile, [
    { timestamp: ts(0), type: 'session_meta', payload: { id: codexId, cwd: projects['api-server'], timestamp: ts(0) } },
    { timestamp: ts(0), type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## Active file: src/server.ts\n\n## My request for Codex:\nAdd graceful shutdown to the server' }] } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'function_call', id: 'fc_1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "listen(" src' }) } },
    { timestamp: ts(0), type: 'turn_context', payload: { cwd: projects['api-server'], model: 'gpt-5-codex' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'custom_tool_call', id: 'ct_1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/server.ts\n@@\n-listen()\n+listen(); onShutdown()\n*** End Patch' } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'The server now closes on SIGTERM: it stops accepting connections, waits up to 10 s for open requests, then exits.' }] } },
    { timestamp: ts(2), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 52000, cached_input_tokens: 38000, output_tokens: 2400, reasoning_output_tokens: 900, total_tokens: 54400 } } } },
  ], ct + 2 * 60e3);

  // GitHub Copilot Chat (VS Code, older .json format)
  // Same per-platform config folder that sources.mjs reads from.
  const config = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming') : path.join(home, '.config');
  const ws = path.join(config, 'Code', 'User', 'workspaceStorage', 'demo1');
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(projects['acme-web']).href }));
  const pt = now - 5 * DAY;
  const copilotFile = path.join(ws, 'chatSessions', `${uuid()}.json`);
  fs.writeFileSync(copilotFile, JSON.stringify({
    sessionId: uuid(), creationDate: pt, lastMessageDate: pt + 60e3, customTitle: 'Explain the useDebounce hook',
    requests: [{ requestId: 'request_1', responseId: 'response_1', timestamp: pt, message: { text: 'Explain the useDebounce hook' }, response: [{ value: 'It waits until the value stops changing for `delay` ms, then returns it. Each change resets the timer.' }] }],
  }));
  fs.utimesSync(copilotFile, new Date(pt + 60e3), new Date(pt + 60e3));

  return { home, projects };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || 'demo-home');
  makeDemoHome(dir);
  console.log(`Demo data written to ${dir}`);
}
