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
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_CACHE_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', PORT };
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) delete env[k];
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
  await test('imports a claude.ai export and removes it', async () => {
    const body = JSON.stringify([{ uuid: 'c0ffee00-0000-4000-8000-000000000001', name: 'Hello', created_at: new Date().toISOString(), chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Hi there, how are you today?' }, { uuid: 'm2', sender: 'assistant', text: 'Hello!' }] }]);
    const res = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'X-Token': token, 'Content-Type': 'application/octet-stream' }, body });
    const r = await res.json();
    assert.equal(r.source, 'claudeai');
    assert.equal(r.added, 1);
    assert.equal((await api('/api/imports/delete', { source: 'claudeai' })).status, 200);
  });

  console.log(`\n${passed} passed`);
} catch (e) {
  console.error(`\nFAILED after ${passed} passed:`, e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
