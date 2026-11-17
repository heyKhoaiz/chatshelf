// Readers for chat history from tools other than Claude Code.
// Every reader is read-only: it never writes to another tool's files.
//
//   list()           -> [{ id, cwd, title, prompts, promptCount, last, start, mtime, size, branch, url, ref }]
//   transcript(ref)  -> [{ role, text, tools: [{ name, detail }], ts, uuid, uuids }]
//   status()         -> { id, label, found, path, count, experimental, note }
//
// `ref` stays on the server; the browser only sees ids.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const CONFIG = IS_MAC ? path.join(HOME, 'Library', 'Application Support')
  : IS_WIN ? (process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'))
    : (process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'));
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
export const IMPORT_DIR = path.join(DATA, 'chatshelf', 'imports');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const lines = (file) => readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
const uriToPath = (u) => {
  if (typeof u !== 'string' || !u) return '';
  if (u.startsWith('file://')) { try { return fileURLToPath(u); } catch { return ''; } }
  return u.startsWith('/') ? u : '';
};
const toMs = (v) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || 0);
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');

function summarize(prompts, promptCount, fallback) {
  const meaningful = prompts.find((t) => !t.startsWith('/') && t.split(/\s+/).length >= 4);
  const title = fallback || meaningful || prompts[0] || 'Empty chat';
  const last = promptCount > 1 ? prompts[prompts.length - 1] : '';
  return { title: squash(title).slice(0, 200), last: last && last !== title ? last : '' };
}

async function* walk(dir, depth = 6) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* walk(p, depth - 1);
    else if (e.isFile()) yield p;
  }
}

// Merge consecutive assistant lines into one message, like the Claude reader does.
function pushMsg(msgs, m) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant' && m.role === 'assistant') {
    if (m.text) last.text = (last.text ? last.text + '\n\n' : '') + m.text;
    last.tools.push(...(m.tools || []));
    if (m.uuid) last.uuids.push(m.uuid);
    return;
  }
  if (!m.text && !(m.tools || []).length) return;
  msgs.push({ role: m.role, text: m.text || '', tools: m.tools || [], ts: m.ts || '', uuid: m.uuid || '', uuids: m.uuid ? [m.uuid] : [] });
}
function capMsgs(msgs) {
  for (const m of msgs) if (m.text.length > 8000) m.text = m.text.slice(0, 8000) + '\n…';
  return msgs.slice(0, 3000);
}
const fileCache = new Map(); // file -> { m, s, value }
async function cached(file, fn) {
  const st = await fsp.stat(file);
  const hit = fileCache.get(file);
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.value;
  const value = await fn(st);
  fileCache.set(file, { m: st.mtimeMs, s: st.size, value });
  return value;
}

// =====================================================================
// Codex CLI / Codex IDE extension: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// =====================================================================
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

function codexPrompt(text) {
  const t = String(text || '');
  const m = t.match(/#*\s*My request[^:\n]*:\s*\n([\s\S]*)$/);
  if (m) return m[1].trim();
  if (/^\s*</.test(t) || t.startsWith('# Context from my IDE') || t.startsWith('# AGENTS.md')) return '';
  return t.trim();
}
const codexText = (content) => (Array.isArray(content) ? content.map((c) => c && c.text).filter(Boolean).join('\n') : '');

const codex = {
  id: 'codex',
  label: 'Codex',
  root: path.join(CODEX_HOME, 'sessions'),
  async files() {
    const out = [];
    for await (const f of walk(this.root)) if (f.endsWith('.jsonl')) out.push(f);
    return out;
  },
  async status() {
    const n = isDir(this.root) ? (await this.files()).length : 0;
    return { id: this.id, label: this.label, found: n > 0, path: this.root, count: n };
  },
  async list() {
    const out = [];
    for (const file of await this.files()) {
      try {
        out.push(await cached(file, async (st) => {
          const d = { id: '', cwd: '', branch: '', prompts: [], promptCount: 0, start: '' };
          for await (const line of lines(file)) {
            if (!line.includes('"session_meta"') && !line.includes('"role":"user"')) continue;
            let o;
            try { o = JSON.parse(line); } catch { continue; }
            const p = o.payload || {};
            if (o.type === 'session_meta') {
              d.id = p.id || p.session_id || d.id;
              d.cwd = p.cwd || d.cwd;
              d.start = p.timestamp || o.timestamp || d.start;
              if (p.git && p.git.branch) d.branch = p.git.branch;
            } else if (o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
              const t = squash(codexPrompt(codexText(p.content)));
              if (t) { d.promptCount++; if (d.prompts.length < 60) d.prompts.push(t.slice(0, 300)); }
            }
          }
          if (!d.id) d.id = (path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27})/) || [])[1] || path.basename(file, '.jsonl');
          return { ...d, ...summarize(d.prompts, d.promptCount), mtime: st.mtimeMs, size: st.size, ref: file };
        }));
      } catch { /* unreadable file */ }
    }
    return out;
  },
  async transcript(file) {
    const msgs = [];
    for await (const line of lines(file)) {
      if (!line.includes('"response_item"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload || {};
      if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const text = p.role === 'user' ? codexPrompt(codexText(p.content)) : codexText(p.content);
        pushMsg(msgs, { role: p.role, text: text.trim(), ts: o.timestamp, uuid: p.id });
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let detail = '';
        try { const a = JSON.parse(p.arguments || '{}'); detail = a.cmd || a.command || a.path || ''; } catch { detail = ''; }
        if (Array.isArray(detail)) detail = detail.join(' ');
        if (!detail && typeof p.input === 'string') detail = (p.input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/) || [])[1] || '';
        pushMsg(msgs, { role: 'assistant', text: '', tools: [{ name: p.name || 'tool', detail: squash(detail).replace(HOME, '~').slice(0, 90) }], ts: o.timestamp, uuid: p.id });
      }
    }
    return capMsgs(msgs);
  },
};

// =====================================================================
// Cursor: <config>/Cursor/User/globalStorage/state.vscdb (SQLite, table cursorDiskKV)
// =====================================================================
let sqlite = null;
async function openDb(file) {
  if (sqlite === null) {
    try { sqlite = await import('node:sqlite'); } catch { sqlite = false; }
  }
  if (!sqlite) throw new Error('This Node version has no built-in SQLite (needs Node 22.5+).');
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

// "home-alex-code-my-app" -> "/home/alex/code/my-app", resolved against folders that really exist.
const dashedCache = new Map();
function resolveDashed(name) {
  if (!name) return '';
  if (dashedCache.has(name)) return dashedCache.get(name);
  const parts = name.split('-').filter(Boolean);
  const walkUp = (dir, i) => {
    if (i >= parts.length) return dir;
    for (let k = parts.length; k > i; k--) {
      for (const sep of ['-', '.', ' ', '_']) {
        const next = path.join(dir, parts.slice(i, k).join(sep));
        if (isDir(next)) { const r = walkUp(next, k); if (r) return r; }
        if (k === i + 1) break;
      }
    }
    return '';
  };
  const out = walkUp(path.parse(HOME).root, 0);
  dashedCache.set(name, out);
  return out;
}

// Walk up from a file to the nearest folder that looks like a project root.
function projectRootOf(file) {
  if (!file || !path.isAbsolute(file)) return '';
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && dir !== HOME) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return '';
}

const cursor = {
  id: 'cursor',
  label: 'Cursor',
  db: path.join(CONFIG, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  cache: null,
  stamp() {
    const a = fs.statSync(this.db);
    let b = 0;
    try { b = fs.statSync(`${this.db}-wal`).mtimeMs; } catch { b = 0; }
    return `${a.mtimeMs}:${a.size}:${b}`;
  },
  async status() {
    if (!isFile(this.db)) return { id: this.id, label: this.label, found: false, path: this.db, count: 0 };
    try { return { id: this.id, label: this.label, found: true, path: this.db, count: (await this.list()).length }; } catch (e) {
      return { id: this.id, label: this.label, found: true, path: this.db, count: 0, note: e.message };
    }
  },
  // Per-workspace databases list which chats belong to which folder (and the branch).
  async workspaceMap() {
    const map = new Map();
    const ws = path.join(path.dirname(path.dirname(this.db)), 'workspaceStorage');
    let dirs = [];
    try { dirs = await fsp.readdir(ws); } catch { return map; }
    for (const d of dirs) {
      const f = path.join(ws, d, 'state.vscdb');
      if (!isFile(f)) continue;
      let folder = '';
      try { const w = JSON.parse(await fsp.readFile(path.join(ws, d, 'workspace.json'), 'utf8')); folder = uriToPath(w.folder || ''); } catch { folder = ''; }
      try {
        const db = await openDb(f);
        const r = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
        db.close();
        const v = r ? JSON.parse(r.value) : null;
        for (const c of (v && v.allComposers) || []) if (c.composerId) map.set(c.composerId, { folder, branch: c.createdOnBranch || '' });
      } catch { /* locked or unreadable */ }
    }
    return map;
  },
  async list() {
    if (!isFile(this.db)) return [];
    const stamp = this.stamp();
    if (this.cache && this.cache.stamp === stamp) return this.cache.items;
    const wsMap = await this.workspaceMap();
    const db = await openDb(this.db);
    const items = [];
    try {
      const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").iterate()) {
        let v;
        try { v = JSON.parse(row.value); } catch { continue; }
        const heads = v && Array.isArray(v.fullConversationHeadersOnly) ? v.fullConversationHeadersOnly : [];
        if (!heads.length) continue;
        const id = v.composerId || String(row.key).slice('composerData:'.length);
        const prompts = [];
        let promptCount = 0;
        const known = wsMap.get(id);
        let cwd = known ? known.folder : '';
        let projectDir = '';
        let size = String(row.value).length;
        for (const h of heads) {
          if (h.type !== 1 && cwd) continue;
          const b = get.get(`bubbleId:${id}:${h.bubbleId}`);
          if (!b) continue;
          size += String(b.value).length;
          let o;
          try { o = JSON.parse(b.value); } catch { continue; }
          if (!cwd && Array.isArray(o.workspaceUris) && o.workspaceUris[0]) cwd = uriToPath(o.workspaceUris[0]);
          if (!projectDir && typeof o.workspaceProjectDir === 'string') projectDir = path.basename(o.workspaceProjectDir);
          if (h.type === 1) {
            const t = squash(o.text);
            if (t) { promptCount++; if (prompts.length < 60) prompts.push(t.slice(0, 300)); }
          }
        }
        if (!cwd && projectDir) cwd = resolveDashed(projectDir);
        if (!cwd) cwd = projectRootOf((String(row.value).match(/"fsPath":"([^"]+)"/) || [])[1]);
        const created = toMs(v.createdAt);
        items.push({
          id, cwd, branch: known ? known.branch : '', prompts, promptCount, start: iso(created),
          mtime: toMs(v.lastUpdatedAt) || created, size, ref: id,
          ...summarize(prompts, promptCount, v.name),
        });
      }
    } finally { db.close(); }
    this.cache = { stamp, items };
    return items;
  },
  async transcript(id) {
    const db = await openDb(this.db);
    const msgs = [];
    try {
      const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
      const v = row ? JSON.parse(row.value) : null;
      const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      for (const h of (v && v.fullConversationHeadersOnly) || []) {
        const b = get.get(`bubbleId:${id}:${h.bubbleId}`);
        if (!b) continue;
        let o;
        try { o = JSON.parse(b.value); } catch { continue; }
        const role = (o.type || h.type) === 1 ? 'user' : 'assistant';
        const tf = o.toolFormerData;
        const tools = tf && tf.name ? [{ name: tf.name, detail: '' }] : [];
        pushMsg(msgs, { role, text: String(o.text || '').trim(), tools, ts: o.createdAt || '', uuid: h.bubbleId });
      }
    } finally { db.close(); }
    return capMsgs(msgs);
  },
};

// =====================================================================
// GitHub Copilot Chat in VS Code: <config>/Code/User/workspaceStorage/<hash>/chatSessions/*.json(l)
// New versions write a patch log (.jsonl): kind 0 = full state, 1 = set at path, 2 = append/splice.
// =====================================================================
function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || cur[keys[i]] === null) cur[keys[i]] = typeof keys[i + 1] === 'number' ? [] : {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}
const getPath = (obj, keys) => keys.reduce((c, k) => (c == null ? undefined : c[k]), obj);

async function readCopilotFile(file) {
  if (file.endsWith('.json')) return JSON.parse(await fsp.readFile(file, 'utf8'));
  let state = {};
  for await (const line of lines(file)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.kind === 0) state = o.v || {};
    else if (o.kind === 1 && Array.isArray(o.k)) setPath(state, o.k, o.v);
    else if (o.kind === 2 && Array.isArray(o.k)) {
      const arr = getPath(state, o.k);
      const add = Array.isArray(o.v) ? o.v : [o.v];
      if (Array.isArray(arr)) { if (typeof o.i === 'number') arr.splice(o.i, arr.length - o.i, ...add); else arr.push(...add); } else setPath(state, o.k, add);
    } else if (o.kind === 3 && Array.isArray(o.k)) setPath(state, o.k, undefined);
  }
  return state;
}
const copilotResponse = (resp) => {
  const parts = Array.isArray(resp) ? resp : [];
  const text = parts.filter((p) => p && (p.kind === undefined || p.kind === null || p.kind === 'markdownContent') && typeof (p.value ?? (p.content && p.content.value)) === 'string')
    .map((p) => p.value ?? p.content.value).join('');
  const tools = parts.filter((p) => p && (p.kind === 'toolInvocationSerialized' || p.kind === 'toolInvocation'))
    .map((p) => ({ name: p.toolId || 'tool', detail: squash((p.invocationMessage && (p.invocationMessage.value || p.invocationMessage)) || '').slice(0, 90) }));
  return { text: text.trim(), tools };
};

const COPILOT_APPS = ['Code', 'Code - Insiders', 'VSCodium'];
const copilot = {
  id: 'copilot',
  label: 'Copilot Chat',
  async files() {
    const out = [];
    for (const app of COPILOT_APPS) {
      const ws = path.join(CONFIG, app, 'User', 'workspaceStorage');
      let dirs = [];
      try { dirs = await fsp.readdir(ws); } catch { dirs = []; }
      for (const d of dirs) {
        const cs = path.join(ws, d, 'chatSessions');
        let names = [];
        try { names = await fsp.readdir(cs); } catch { continue; }
        let folder = '';
        try { const w = JSON.parse(await fsp.readFile(path.join(ws, d, 'workspace.json'), 'utf8')); folder = uriToPath(w.folder || w.workspace || ''); } catch { folder = ''; }
        for (const n of names) if (/\.jsonl?$/.test(n)) out.push({ file: path.join(cs, n), folder });
      }
      const empty = path.join(CONFIG, app, 'User', 'globalStorage', 'emptyWindowChatSessions');
      let en = [];
      try { en = await fsp.readdir(empty); } catch { en = []; }
      for (const n of en) if (/\.jsonl?$/.test(n)) out.push({ file: path.join(empty, n), folder: '' });
    }
    return out;
  },
  async status() {
    const items = await this.list();
    return { id: this.id, label: this.label, found: items.length > 0, path: path.join(CONFIG, 'Code', 'User', 'workspaceStorage'), count: items.length };
  },
  async list() {
    const out = [];
    for (const { file, folder } of await this.files()) {
      try {
        const item = await cached(file, async (st) => {
          const s = await readCopilotFile(file);
          const reqs = Array.isArray(s.requests) ? s.requests.filter(Boolean) : [];
          if (!reqs.length) return null;
          const prompts = reqs.map((r) => squash(r.message && (r.message.text || r.message))).filter(Boolean);
          const lastTs = reqs.reduce((m, r) => Math.max(m, toMs(r.timestamp)), 0);
          return {
            id: s.sessionId || path.basename(file).replace(/\.jsonl?$/, ''), cwd: folder, branch: '',
            prompts: prompts.slice(0, 60).map((t) => t.slice(0, 300)), promptCount: prompts.length,
            start: iso(toMs(s.creationDate)), mtime: toMs(s.lastMessageDate) || lastTs || st.mtimeMs, size: st.size, ref: file,
            ...summarize(prompts, prompts.length, s.customTitle),
          };
        });
        if (item) out.push(item);
      } catch { /* unreadable file */ }
    }
    return out;
  },
  async transcript(file) {
    const s = await readCopilotFile(file);
    const msgs = [];
    for (const r of (s.requests || []).filter(Boolean)) {
      const ts = iso(toMs(r.timestamp));
      pushMsg(msgs, { role: 'user', text: String((r.message && (r.message.text || r.message)) || '').trim(), ts, uuid: r.requestId });
      const { text, tools } = copilotResponse(r.response);
      pushMsg(msgs, { role: 'assistant', text, tools, ts, uuid: r.responseId || (r.requestId ? `${r.requestId}-response` : '') });
    }
    return capMsgs(msgs);
  },
};

// =====================================================================
// OpenCode (experimental): ~/.local/share/opencode/storage/{session,message,part}
// =====================================================================
const OPENCODE = path.join(DATA, 'opencode', 'storage');
const readJson = async (f) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; } };
const opencode = {
  id: 'opencode',
  label: 'OpenCode',
  experimental: true,
  async status() {
    const items = isDir(OPENCODE) ? await this.list() : [];
    return { id: this.id, label: this.label, found: items.length > 0, path: OPENCODE, count: items.length, experimental: true };
  },
  async messages(sessionId) {
    const dir = path.join(OPENCODE, 'message', sessionId);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names) {
      const m = await readJson(path.join(dir, n));
      if (!m || !m.id) continue;
      let parts = [];
      try { parts = await fsp.readdir(path.join(OPENCODE, 'part', m.id)); } catch { parts = []; }
      const ps = [];
      for (const pn of parts) { const p = await readJson(path.join(OPENCODE, 'part', m.id, pn)); if (p) ps.push(p); }
      ps.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      out.push({ m, ps });
    }
    return out.sort((a, b) => toMs(a.m.time && a.m.time.created) - toMs(b.m.time && b.m.time.created));
  },
  async list() {
    const out = [];
    for await (const f of walk(path.join(OPENCODE, 'session'), 2)) {
      if (!f.endsWith('.json')) continue;
      const s = await readJson(f);
      if (!s || !s.id) continue;
      const msgs = await this.messages(s.id);
      const prompts = msgs.filter((x) => x.m.role === 'user')
        .map((x) => squash(x.ps.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join(' '))).filter(Boolean);
      out.push({
        id: s.id, cwd: s.directory || '', branch: '', prompts: prompts.slice(0, 60).map((t) => t.slice(0, 300)), promptCount: prompts.length,
        start: iso(toMs(s.time && s.time.created)), mtime: toMs(s.time && (s.time.updated || s.time.created)) || 0, size: 0, ref: s.id,
        ...summarize(prompts, prompts.length, s.title),
      });
    }
    return out;
  },
  async transcript(id) {
    const msgs = [];
    for (const { m, ps } of await this.messages(id)) {
      const text = ps.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim();
      const tools = ps.filter((p) => p.type === 'tool').map((p) => ({ name: p.tool || 'tool', detail: '' }));
      pushMsg(msgs, { role: m.role === 'user' ? 'user' : 'assistant', text, tools, ts: iso(toMs(m.time && m.time.created)), uuid: m.id });
    }
    return capMsgs(msgs);
  },
};

// =====================================================================
// Gemini CLI (experimental): ~/.gemini/tmp/<project-hash>/chats/session-*.json
// =====================================================================
const GEMINI = path.join(HOME, '.gemini', 'tmp');
const geminiText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('') : '');
const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  experimental: true,
  async files() {
    const out = [];
    for await (const f of walk(GEMINI, 3)) if (/[\\/]chats[\\/][^\\/]+\.json$/.test(f)) out.push(f);
    return out;
  },
  async status() {
    const n = isDir(GEMINI) ? (await this.list()).length : 0;
    return { id: this.id, label: this.label, found: n > 0, path: GEMINI, count: n, experimental: true };
  },
  async list() {
    const out = [];
    for (const file of await this.files()) {
      try {
        const item = await cached(file, async (st) => {
          const s = JSON.parse(await fsp.readFile(file, 'utf8'));
          const msgs = Array.isArray(s.messages) ? s.messages : [];
          const prompts = msgs.filter((m) => m.type === 'user').map((m) => squash(geminiText(m.content))).filter(Boolean);
          if (!msgs.length) return null;
          return {
            id: s.sessionId || path.basename(file, '.json'), cwd: s.projectRoot || '', branch: '',
            prompts: prompts.slice(0, 60).map((t) => t.slice(0, 300)), promptCount: prompts.length,
            start: s.startTime || '', mtime: toMs(s.lastUpdated) || st.mtimeMs, size: st.size, ref: file,
            ...summarize(prompts, prompts.length),
          };
        });
        if (item) out.push(item);
      } catch { /* unreadable */ }
    }
    return out;
  },
  async transcript(file) {
    const s = JSON.parse(await fsp.readFile(file, 'utf8'));
    const msgs = [];
    for (const m of s.messages || []) {
      if (m.type !== 'user' && m.type !== 'gemini') continue;
      const tools = Array.isArray(m.toolCalls) ? m.toolCalls.map((t) => ({ name: t.name || 'tool', detail: '' })) : [];
      pushMsg(msgs, { role: m.type === 'user' ? 'user' : 'assistant', text: geminiText(m.content).trim(), tools, ts: m.timestamp || '', uuid: m.id });
    }
    return capMsgs(msgs);
  },
};

// =====================================================================
// Imports: ChatGPT and claude.ai data exports (zip or conversations.json)
// Stored normalized in IMPORT_DIR/<source>.json, one file per service.
// =====================================================================
function unzipFind(buf, match) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file is not a valid zip.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!match(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error('Unsupported zip compression.');
  }
  return null;
}

function parseChatGPT(list) {
  return list.filter((c) => c && c.mapping).map((c) => {
    const id = c.conversation_id || c.id;
    const chain = [];
    const seen = new Set();
    let node = c.current_node;
    while (node && c.mapping[node] && !seen.has(node)) { seen.add(node); chain.push(c.mapping[node]); node = c.mapping[node].parent; }
    chain.reverse();
    const messages = [];
    for (const n of chain) {
      const m = n.message;
      if (!m || !m.author || (m.author.role !== 'user' && m.author.role !== 'assistant')) continue;
      if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
      const parts = (m.content && m.content.parts) || [];
      const text = (parts.filter((x) => typeof x === 'string').join('\n') || (m.content && m.content.text) || '').trim();
      if (!text) continue;
      messages.push({ role: m.author.role, text, ts: m.create_time ? iso(m.create_time * 1000) : '', uuid: String(m.id || n.id || '') });
    }
    return { id: String(id), title: c.title || 'Untitled', created: toMs(c.create_time), updated: toMs(c.update_time || c.create_time), url: `https://chatgpt.com/c/${id}`, messages };
  }).filter((c) => c.id && c.messages.length);
}

function parseClaudeAi(list) {
  return list.filter((c) => c && Array.isArray(c.chat_messages)).map((c) => ({
    id: String(c.uuid),
    title: c.name || 'Untitled',
    created: toMs(c.created_at),
    updated: toMs(c.updated_at || c.created_at),
    url: `https://claude.ai/chat/${c.uuid}`,
    messages: c.chat_messages.map((m) => ({
      role: m.sender === 'human' ? 'user' : 'assistant',
      text: String(m.text || (Array.isArray(m.content) ? m.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '')).trim(),
      ts: m.created_at || '',
      uuid: String(m.uuid || ''),
    })).filter((m) => m.text),
  })).filter((c) => c.id && c.messages.length);
}

const IMPORT_LABELS = { chatgpt: 'ChatGPT', claudeai: 'claude.ai' };
const importFile = (source) => path.join(IMPORT_DIR, `${source}.json`);

export async function importExport(buf, filename = '') {
  let raw = buf;
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    raw = unzipFind(buf, (n) => /(^|\/)conversations\.json$/.test(n));
    if (!raw) throw new Error('No conversations.json inside this zip. Use the export from ChatGPT or claude.ai settings.');
  }
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Could not read this file as JSON.'); }
  const list = Array.isArray(data) ? data : Array.isArray(data.conversations) ? data.conversations : [];
  if (!list.length) throw new Error('No conversations found in this file.');
  let source;
  let convos;
  if (list.some((c) => c && c.mapping)) { source = 'chatgpt'; convos = parseChatGPT(list); }
  else if (list.some((c) => c && Array.isArray(c.chat_messages))) { source = 'claudeai'; convos = parseClaudeAi(list); }
  else throw new Error('This file is not a ChatGPT or claude.ai export.');
  await fsp.mkdir(IMPORT_DIR, { recursive: true });
  const prev = await readJson(importFile(source));
  const byId = new Map(((prev && prev.conversations) || []).map((c) => [c.id, c]));
  let added = 0;
  for (const c of convos) { if (!byId.has(c.id)) added++; byId.set(c.id, c); }
  const out = { source, label: IMPORT_LABELS[source], file: path.basename(filename || ''), importedAt: new Date().toISOString(), conversations: [...byId.values()] };
  const tmp = `${importFile(source)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(out));
  await fsp.rename(tmp, importFile(source));
  importCache.delete(source);
  return { source, label: out.label, total: out.conversations.length, added, updated: convos.length - added };
}

export async function removeImport(source) {
  if (!IMPORT_LABELS[source]) throw new Error('Unknown import.');
  await fsp.rm(importFile(source), { force: true });
  importCache.delete(source);
}

const importCache = new Map();
async function loadImport(source) {
  const f = importFile(source);
  if (!isFile(f)) return null;
  const st = await fsp.stat(f);
  const hit = importCache.get(source);
  if (hit && hit.m === st.mtimeMs) return hit.data;
  const data = await readJson(f);
  importCache.set(source, { m: st.mtimeMs, data });
  return data;
}

function importReader(source) {
  return {
    id: source,
    label: IMPORT_LABELS[source],
    imported: true,
    async status() {
      const d = await loadImport(source);
      return { id: source, label: IMPORT_LABELS[source], found: Boolean(d), path: importFile(source), count: d ? d.conversations.length : 0, imported: true, importedAt: d ? d.importedAt : '', file: d ? d.file : '' };
    },
    async list() {
      const d = await loadImport(source);
      if (!d) return [];
      return d.conversations.map((c) => {
        const prompts = c.messages.filter((m) => m.role === 'user').map((m) => squash(m.text)).filter(Boolean);
        return {
          id: c.id, cwd: '', branch: '', prompts: prompts.slice(0, 60).map((t) => t.slice(0, 300)), promptCount: prompts.length,
          start: iso(c.created), mtime: c.updated || c.created, size: c.messages.reduce((n, m) => n + m.text.length, 0), url: c.url, ref: c.id,
          ...summarize(prompts, prompts.length, c.title),
        };
      });
    },
    async transcript(id) {
      const d = await loadImport(source);
      const c = d && d.conversations.find((x) => x.id === id);
      if (!c) return [];
      const msgs = [];
      for (const m of c.messages) pushMsg(msgs, { role: m.role, text: m.text, ts: m.ts, uuid: m.uuid });
      return capMsgs(msgs);
    },
  };
}

export const READERS = [codex, cursor, copilot, opencode, gemini, importReader('chatgpt'), importReader('claudeai')];
export const reader = (id) => READERS.find((r) => r.id === id);
