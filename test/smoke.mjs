// End-to-end smoke test: starts the server against demo data and exercises the API.
// Run: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeDemoHome } from './demo-data.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatshelf-test-'));
const { projects } = makeDemoHome(home);
const PORT = String(4400 + Math.floor(Math.random() * 400));
const env = { ...process.env, HOME: home, PORT, CHATSHELF_HOST: 'myshelf.localhost', CHATSHELF_NO_SPAWN: '1' };
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CHATSHELF_PORT']) delete env[k];
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.mjs'), '--no-open'], { env, stdio: ['ignore', 'pipe', 'inherit'] });

const base = `http://127.0.0.1:${PORT}`;
let token = '';
const api = async (p, body) => {
  const res = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'X-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
};
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

try {
  for (let i = 0; i < 50; i++) {
    try { const html = await (await fetch(base)).text(); token = (html.match(/CSM_TOKEN = "([a-f0-9]+)"/) || [])[1]; if (token) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(token, 'server did not start');

  let data;
  await test('rejects requests without the token', async () => {
    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 403);
  });
  await test('rejects a foreign Host header', async () => {
    // fetch() won't override Host, so use node:http directly.
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects', headers: { 'X-Token': token, Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  });
  await test('accepts the chatshelf.localhost address', async () => {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects', headers: { 'X-Token': token, Host: `chatshelf.localhost:${PORT}` } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 200);
  });
  await test('accepts a custom .localhost address', async () => {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects', headers: { 'X-Token': token, Host: `myshelf.localhost:${PORT}` } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 200);
  });
  // Runs a second copy and returns { code, out }.
  const runCopy = (extraEnv, args = []) => new Promise((resolve) => {
    const e = { ...env, ...extraEnv };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.mjs'), '--no-open', ...args], { env: e });
    let out = '';
    p.stdout.on('data', (c) => { out += c; if (out.includes('Chatshelf is running at')) p.kill(); });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out }));
    setTimeout(() => p.kill(), 15000);
  });
  await test('refuses an address that is not .localhost', async () => {
    const r = await runCopy({ CHATSHELF_HOST: 'evil.example' });
    assert.equal(r.code, 1);
    assert.match(r.out, /ends in \.localhost/);
  });
  await test('a second start finds the running copy instead of starting again', async () => {
    const r = await runCopy({});
    assert.equal(r.code, 0);
    assert.match(r.out, /already running/);
  });
  await test('a fixed port that is busy gives a clear message', async () => {
    const blocker = http.createServer((q, r) => r.end('not chatshelf'));
    const busy = Number(PORT) + 500;
    await new Promise((res) => blocker.listen(busy, '127.0.0.1', res));
    try {
      const r = await runCopy({ PORT: String(busy) });
      assert.equal(r.code, 1);
      assert.match(r.out, /used by another program/);
    } finally { blocker.close(); }
  });
  await test('without a port setting, a busy port moves to the next free one', async () => {
    const blocker = http.createServer((q, r) => r.end('not chatshelf'));
    const busy = Number(PORT) + 600;
    await new Promise((res) => blocker.listen(busy, '127.0.0.1', res));
    const runFile = path.join(home, '.cache', 'chatshelf', 'running.json');
    const saved = fs.existsSync(runFile) ? fs.readFileSync(runFile) : null;
    if (saved) fs.unlinkSync(runFile); // hide the running copy so a fresh start is tried
    try {
      const r = await runCopy({ PORT: undefined, CHATSHELF_FIRST_PORT: String(busy) });
      assert.match(r.out, new RegExp(`Port ${busy} was busy, so Chatshelf picked ${busy + 1}`));
    } finally {
      blocker.close();
      if (saved) fs.writeFileSync(runFile, saved);
    }
  });
  await test('lists chats from Claude Code, Codex and Copilot', async () => {
    data = (await api('/api/projects')).data;
    const by = {};
    for (const p of data.projects) by[p.source] = (by[p.source] || 0) + p.sessions.length;
    assert.equal(by.claude, 10);
    assert.equal(by.codex, 1);
    assert.equal(by.copilot, 1);
  });
  await test('Codex prompts skip the IDE context', async () => {
    const s = data.projects.find((p) => p.source === 'codex').sessions[0];
    assert.equal(s.title, 'Add graceful shutdown to the server');
  });
  await test('flags the renamed folder as missing', async () => {
    const missing = data.projects.filter((p) => p.missing);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].cwd, projects.mobile);
  });
  await test('reads a transcript', async () => {
    const p = data.projects.find((x) => x.source === 'claude' && x.cwd === projects['api-server']);
    const r = await api(`/api/session?key=${encodeURIComponent(p.key)}&id=${p.sessions[0].id}`);
    assert.equal(r.status, 200);
    assert.ok(r.data.messages.length >= 2);
  });
  await test('suggests the renamed folder', async () => {
    const p = data.projects.find((x) => x.missing);
    const r = await api(`/api/suggest?key=${encodeURIComponent(p.key)}`);
    assert.ok(r.data.suggestions.some((s) => s.path.endsWith(`${path.sep}mobile-app`)));
  });
  await test('moves sessions to the new folder, with a backup', async () => {
    const p = data.projects.find((x) => x.missing);
    const to = path.join(home, 'code', 'mobile-app');
    const r = await api('/api/move', { key: p.key, to });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.moved, 2);
    assert.ok(fs.existsSync(r.data.backup));
    const after = (await api('/api/projects')).data;
    assert.equal(after.projects.filter((x) => x.missing).length, 0);
    const moved = after.projects.find((x) => x.cwd === to);
    assert.equal(moved.sessions.length, 2);
  });
  await test('refuses to move chats from other tools', async () => {
    const p = data.projects.find((x) => x.source === 'codex');
    const r = await api('/api/move', { key: p.key, to: home });
    assert.equal(r.status, 400);
  });
  await test('saves, updates and deletes a bookmark', async () => {
    const s = data.projects.find((x) => x.source === 'claude').sessions[0];
    const a = await api('/api/bookmarks', { kind: 'chat', sessionId: s.id, title: s.title, note: 'keep' });
    assert.equal(a.status, 200);
    await api('/api/bookmarks', { kind: 'chat', sessionId: s.id });
    const list = (await api('/api/bookmarks')).data.bookmarks;
    assert.equal(list.length, 1);
    assert.equal(list[0].note, 'keep', 'a partial update must not wipe the note');
    assert.equal((await api('/api/bookmarks/delete', { id: a.data.bookmark.id })).status, 200);
  });
  await test('hands a chat off to Codex through a private temp file', async () => {
    const p = data.projects.find((x) => x.source === 'claude' && x.cwd === projects['api-server']);
    const r = await api('/api/handoff', { key: p.key, id: p.sessions[0].id, target: 'codex', text: '# Handoff: test\nContinue please.' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.command, /^codex "\$\(cat '.+chatshelf-handoff-[0-9a-f]+\.md'\)"$/);
    assert.equal(fs.readFileSync(r.data.file, 'utf8'), '# Handoff: test\nContinue please.');
    if (process.platform !== 'win32') assert.equal(fs.statSync(r.data.file).mode & 0o777, 0o600);
    assert.equal(r.data.cwd, projects['api-server']);
    fs.rmSync(r.data.file);
    assert.equal((await api('/api/handoff', { key: p.key, id: p.sessions[0].id, target: 'notepad', text: 'x' })).status, 400);
    assert.equal((await api('/api/handoff', { key: p.key, id: p.sessions[0].id, target: 'codex', text: '   ' })).status, 400);
    assert.equal((await api('/api/handoff/targets')).status, 200);
  });
  await test('imports a claude.ai export and removes it', async () => {
    const body = JSON.stringify([{ uuid: 'c0ffee00-0000-4000-8000-000000000001', name: 'Hello', created_at: new Date().toISOString(), chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Hi there, how are you today?' }, { uuid: 'm2', sender: 'assistant', text: 'Hello!' }] }]);
    const res = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'X-Token': token, 'Content-Type': 'application/octet-stream' }, body });
    const r = await res.json();
    assert.equal(r.source, 'claudeai');
    assert.equal(r.added, 1);
    assert.equal((await api('/api/imports/delete', { source: 'claudeai' })).status, 200);
  });

  await test('reads token usage, estimated cost and changed files', async () => {
    const all = (await api('/api/projects')).data.projects.flatMap((p) => p.sessions);
    const c = all.find((s) => s.source === 'claude' && s.usage);
    assert.ok(c, 'a Claude chat has usage');
    assert.ok(c.usage.out > 0 && c.usage.cr > 0);
    assert.ok(c.usage.cost > 0, 'Claude models are priced');
    assert.ok(c.files.length >= 1 && c.files[0].endsWith('.ts'));
    const x = all.find((s) => s.source === 'codex');
    assert.equal(x.usage.in, 14000);
    assert.equal(x.usage.cr, 38000);
    assert.equal(x.usage.cost, null, 'no prices for Codex models');
    assert.ok(x.files[0].endsWith(path.join('api-server', 'src', 'server.ts')));
  });
  await test('searches inside replies, not only prompts', async () => {
    // "SIGTERM" only appears in the Codex reply.
    const r = await api('/api/search?q=sigterm');
    assert.equal(r.status, 200);
    assert.equal(r.data.hits.length, 1);
    assert.equal(r.data.hits[0].role, 'assistant');
    assert.match(r.data.hits[0].snippet, /SIGTERM/);
    assert.equal((await api('/api/search?q=sliding%20headers')).data.hits.length, 1, 'all words, anywhere in the chat');
    assert.equal((await api('/api/search?q=zzzznothing')).data.hits.length, 0);
  });
  await test('tags a chat', async () => {
    const s = data.projects.find((x) => x.source === 'claude').sessions[0];
    const r = await api('/api/tags', { sessionId: s.id, tags: ['#Bug', 'perf', 'bug'] });
    assert.deepEqual(r.data.tags, ['bug', 'perf']);
    assert.deepEqual((await api('/api/tags')).data.tags[s.id], ['bug', 'perf']);
    assert.equal((await api('/api/tags', { sessionId: s.id, tags: ['no spaces?!'] })).status, 400);
    await api('/api/tags', { sessionId: s.id, tags: [] });
    assert.equal((await api('/api/tags')).data.tags[s.id], undefined);
  });
  await test('archives chats, keeps one Claude Code deleted, and restores it', async () => {
    const before = (await api('/api/archive')).data;
    assert.equal(before.auto, false);
    assert.equal(before.kept, 0);
    const on = await api('/api/archive/settings', { auto: true });
    assert.equal(on.data.kept, on.data.total);
    const p = (await api('/api/projects')).data.projects.find((x) => x.source === 'claude' && x.cwd === projects['acme-web']);
    const s = p.sessions[0];
    const file = path.join(home, '.claude', 'projects', p.key, `${s.id}.jsonl`);
    const original = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file); // what Claude Code's cleanup does
    const gone = (await api('/api/projects')).data.projects.flatMap((x) => x.sessions).find((x) => x.id === s.id);
    assert.equal(gone.archived, 'only');
    assert.ok((await api(`/api/session?key=${encodeURIComponent(p.key)}&id=${s.id}`)).data.messages.length >= 2, 'still readable');
    assert.equal((await api('/api/move', { key: p.key, to: home, ids: [s.id] })).status, 400, 'archive-only chats are not moved');
    const r = await api('/api/archive/restore', { key: p.key, id: s.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal((await api('/api/archive/restore', { key: p.key, id: s.id })).status, 400, 'nothing left to restore');
    await api('/api/archive/settings', { auto: false });
  });
  await test('answers MCP requests over stdio', async () => {
    const mcp = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map();
    let buf = '';
    mcp.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); }
    });
    const ask = async (id, method, params) => {
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      for (let n = 0; n < 150 && !replies.has(id); n++) await new Promise((r) => setTimeout(r, 100));
      return replies.get(id);
    };
    try {
      const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.equal(init.result.serverInfo.name, 'chatshelf');
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const tools = await ask(2, 'tools/list', {});
      assert.deepEqual(tools.result.tools.map((t) => t.name), ['search_chats', 'list_chats', 'read_chat']);
      const found = await ask(3, 'tools/call', { name: 'search_chats', arguments: { query: 'SIGTERM' } });
      assert.match(found.result.content[0].text, /Add graceful shutdown/);
      const id = found.result.content[0].text.match(/id: (\S+)/)[1];
      const chat = await ask(4, 'tools/call', { name: 'read_chat', arguments: { id } });
      assert.match(chat.result.content[0].text, /closes on SIGTERM/);
      const list = await ask(5, 'tools/call', { name: 'list_chats', arguments: { tool: 'claude', limit: 3 } });
      assert.equal(list.result.content[0].text.split('\n').length, 3);
      const bad = await ask(6, 'tools/call', { name: 'read_chat', arguments: { id: 'nope' } });
      assert.equal(bad.result.isError, true);
      assert.equal((await ask(7, 'no/such', {})).error.code, -32601);
    } finally { mcp.kill(); }
  });

  await test('core.mjs works without the web server (as the VS Code extension uses it)', async () => {
    // A separate process, because core.mjs reads HOME when it loads.
    const code = `const { handle } = await import(${JSON.stringify(path.join(ROOT, 'core.mjs'))});
      const r = await handle('GET /api/projects');
      let notFound = 0; try { await handle('GET /api/nope'); } catch (e) { notFound = e.status; }
      console.log(JSON.stringify({ n: r.projects.length, notFound }));`;
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] });
      let s = '';
      p.stdout.on('data', (c) => { s += c; });
      p.on('error', reject);
      p.on('close', (c) => (c === 0 ? resolve(JSON.parse(s)) : reject(new Error(`exit ${c}`))));
    });
    assert.equal(out.n, data.projects.length);
    assert.equal(out.notFound, 404);
  });

  console.log(`\n${passed} passed`);
} catch (e) {
  console.error(`\nFAILED after ${passed} passed:`, e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
