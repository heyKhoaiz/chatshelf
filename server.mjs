#!/usr/bin/env node
// Chatshelf: a local web app to browse AI coding chats (Claude Code, Codex, Cursor, Copilot…) and
// move them when a project folder is renamed. Node built-ins only.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READERS, reader, importExport, removeImport } from './sources.mjs';

const HOME = os.homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const ROOT = path.join(CLAUDE, 'projects');
const BACKUP = path.join(CLAUDE, 'projects-backup');
const DATA_ROOT = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const DATA_DIR = path.join(DATA_ROOT, 'chatshelf');
// Earlier builds were called claude-session-manager: carry their bookmarks and imports over once.
const OLD_DATA_DIR = path.join(DATA_ROOT, 'claude-session-manager');
if (!fs.existsSync(DATA_DIR) && fs.existsSync(OLD_DATA_DIR)) { try { fs.renameSync(OLD_DATA_DIR, DATA_DIR); } catch { /* keep going with a fresh folder */ } }
const BOOKMARKS = path.join(DATA_DIR, 'bookmarks.json');
const CACHE_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'chatshelf', 'index.json');
const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// Claude Code names a project's session folder after its path, with every
// character that is not a letter or digit replaced by "-".
const CACHE_VERSION = 2;
const encode = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => fs.existsSync(p);
const expand = (p) => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- index cache (per file, keyed by mtime + size) ----------
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
let cacheDirty = false;
function saveCache(seen) {
  for (const k of Object.keys(cache)) if (!seen.has(k)) { delete cache[k]; cacheDirty = true; }
  if (!cacheDirty) return;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  cacheDirty = false;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function cleanPrompt(t, keepLines = false) {
  t = (t || '').trim();
  if (t.startsWith('<command-name>')) return t.split('<command-name>')[1].split('</command-name>')[0].trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return '';
  return keepLines ? t : t.replace(/\s+/g, ' ');
}

function lines(file) {
  return readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
}

async function parseSession(file) {
  const st = await fsp.stat(file);
  const hit = cache[file];
  if (hit && hit.v === CACHE_VERSION && hit.m === st.mtimeMs && hit.s === st.size) return { ...hit.d, mtime: st.mtimeMs, size: st.size };

  const d = { cwd: '', branch: '', custom: '', summary: '', prompts: [], promptCount: 0, start: '', last: '' };
  for await (const line of lines(file)) {
    if (!line.includes('"type":"user"') && !line.includes('"customTitle"') && !line.startsWith('{"type":"summary"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.customTitle) { d.custom = o.customTitle; continue; }
    if (o.type === 'summary') { if (!d.summary && o.summary) d.summary = o.summary; continue; }
    if (o.type !== 'user') continue;
    if (!d.cwd && o.cwd) d.cwd = o.cwd;
    if (!d.branch && o.gitBranch) d.branch = o.gitBranch;
    if (!d.start && o.timestamp) d.start = o.timestamp;
    if (o.isMeta || o.isSidechain) continue;
    const t = cleanPrompt(textOf(o.message && o.message.content));
    if (t) { d.promptCount++; d.last = t.slice(0, 300); if (d.prompts.length < 60) d.prompts.push(t.slice(0, 300)); }
  }
  // The first prompt is often a shortcut like "c-p" or "ok": prefer the first one that says something.
  const meaningful = d.prompts.find((t) => !t.startsWith('/') && t.split(/\s+/).length >= 4);
  d.title = d.custom || d.summary || meaningful || d.prompts[0] || 'Empty session';
  if (d.last === d.title || d.promptCount < 2) d.last = '';
  delete d.custom; delete d.summary;
  cache[file] = { v: CACHE_VERSION, m: st.mtimeMs, s: st.size, d };
  cacheDirty = true;
  return { ...d, mtime: st.mtimeMs, size: st.size };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

let scanning = null;
function scan() {
  if (!scanning) scanning = doScan().finally(() => { scanning = null; });
  return scanning;
}

async function doScan() {
  if (!isDir(ROOT)) return [];
  const entries = (await fsp.readdir(ROOT, { withFileTypes: true })).filter((e) => e.isDirectory());
  const projects = [];
  const jobs = [];
  for (const e of entries) {
    const dir = path.join(ROOT, e.name);
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    const p = { key: e.name, source: 'claude', cwd: '', exists: false, missing: false, memory: names.includes('memory'), sessions: [] };
    projects.push(p);
    for (const n of names) if (n.endsWith('.jsonl')) jobs.push({ p, id: n.slice(0, -6), file: path.join(dir, n) });
  }
  const seen = new Set(jobs.map((j) => j.file));
  await pool(jobs, 8, async (j) => {
    try { j.p.sessions.push({ id: j.id, ...(await parseSession(j.file)) }); } catch { /* unreadable file */ }
  });
  saveCache(seen);
  for (const p of projects) {
    p.sessions.sort((a, b) => b.mtime - a.mtime);
    const cwds = p.sessions.map((s) => s.cwd).filter(Boolean);
    p.cwd = cwds.find((c) => encode(c) === p.key) || cwds[0] || '';
    p.exists = p.cwd ? isDir(p.cwd) : false;
    p.missing = Boolean(p.cwd) && !p.exists;
    p.updated = p.sessions[0] ? p.sessions[0].mtime : 0;
  }
  for (const p of projects) for (const s of p.sessions) s.source = 'claude';
  const others = await scanOtherTools();
  return [...projects.filter((p) => p.sessions.length || p.memory), ...others].sort((a, b) => b.updated - a.updated);
}

// Chats from other tools, grouped by tool + folder. `refs` maps "key|id" to the reader's own handle.
const refs = new Map();
const toolErrors = new Map();
async function scanOtherTools() {
  const groups = new Map();
  for (const r of READERS) {
    let items = [];
    try { items = await r.list(); toolErrors.delete(r.id); } catch (e) { toolErrors.set(r.id, e.message); continue; }
    for (const it of items) {
      const key = `${r.id}:${it.cwd ? encode(it.cwd) : 'none'}`;
      if (!groups.has(key)) {
        groups.set(key, { key, source: r.id, cwd: it.cwd || '', exists: it.cwd ? isDir(it.cwd) : false, missing: false, memory: false, sessions: [] });
      }
      const { ref, ...pub } = it;
      refs.set(`${key}|${it.id}`, { reader: r.id, ref });
      groups.get(key).sessions.push({ ...pub, source: r.id });
    }
  }
  for (const p of groups.values()) {
    p.sessions.sort((a, b) => b.mtime - a.mtime);
    p.updated = p.sessions[0] ? p.sessions[0].mtime : 0;
  }
  return [...groups.values()];
}

async function getProject(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{1,400}$/.test(key) || (!key.includes(':') && !isDir(path.join(ROOT, key)))) {
    throw new HttpError(404, 'Unknown project.');
  }
  const p = (await scan()).find((x) => x.key === key);
  if (!p) throw new HttpError(404, 'Unknown project.');
  return p;
}

// ---------- transcript ----------
async function transcript(file) {
  const msgs = [];
  for await (const line of lines(file)) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain) continue;
    const c = o.message && o.message.content;
    let text = '';
    const tools = [];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') {
          const inp = b.input || {};
          let detail = inp.command || inp.file_path || inp.path || inp.pattern || inp.url || inp.query || inp.description || inp.skill || '';
          if (typeof detail !== 'string') detail = '';
          detail = detail.replace(/\s+/g, ' ').replace(HOME, '~');
          tools.push({ name: b.name, detail: detail.length > 90 ? detail.slice(0, 90) + '…' : detail });
        }
      }
    }
    if (o.type === 'user') text = cleanPrompt(text, true);
    text = text.trim();
    if (!text && !tools.length) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant' && o.type === 'assistant') {
      if (text) last.text = (last.text ? last.text + '\n\n' : '') + text;
      last.tools.push(...tools);
      if (typeof o.uuid === 'string') last.uuids.push(o.uuid);
    } else {
      const uuid = typeof o.uuid === 'string' ? o.uuid : '';
      msgs.push({ role: o.type, text, tools, ts: o.timestamp || '', uuid, uuids: uuid ? [uuid] : [] });
    }
    if (msgs.length >= 3000) break;
  }
  for (const m of msgs) if (m.text.length > 8000) m.text = m.text.slice(0, 8000) + '\n…';
  return msgs;
}

// ---------- folder suggestions and browsing ----------
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return out;
}
function similarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let hit = 0, total = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  for (const [g, v] of A) hit += Math.min(v, B.get(g) || 0);
  return total ? (2 * hit) / total : 0;
}

function suggest(oldCwd, knownCwds) {
  let anc = path.dirname(oldCwd);
  while (anc !== path.dirname(anc) && !isDir(anc)) anc = path.dirname(anc);
  const base = path.basename(oldCwd).toLowerCase();
  const found = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
      const full = path.join(dir, e.name);
      let score = similarity(base, e.name.toLowerCase());
      if (!knownCwds.has(full)) score += 0.1; // a renamed folder usually has no sessions of its own yet
      if (path.dirname(full) === path.dirname(oldCwd)) score += 0.1; // same parent as before
      found.push({ path: full, score });
      if (depth > 1) walk(full, depth - 1);
    }
  };
  walk(anc, 2);
  return found.filter((f) => f.score > 0.35).sort((a, b) => b.score - a.score).slice(0, 8);
}

function listDirs(p) {
  let dir = path.resolve(expand(p || HOME));
  if (!isDir(dir)) dir = HOME;
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* unreadable */ }
  return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs };
}

// ---------- move, backup, restore ----------
async function mergeMove(s, d, moved, skipped) {
  if (!exists(d)) { await fsp.rename(s, d); moved.push(d); return; }
  if (isDir(s) && isDir(d)) {
    for (const n of await fsp.readdir(s)) await mergeMove(path.join(s, n), path.join(d, n), moved, skipped);
    try { await fsp.rmdir(s); } catch { /* not empty: something was skipped */ }
    return;
  }
  skipped.push(path.relative(ROOT, s));
}

async function jsonlFiles(p, out = []) {
  if (isDir(p)) for (const n of await fsp.readdir(p)) await jsonlFiles(path.join(p, n), out);
  else if (p.endsWith('.jsonl')) out.push(p);
  return out;
}

async function rewriteCwd(file, oldCwd, newCwd) {
  const st = await fsp.stat(file);
  const tmp = `${file}.csm-tmp`;
  const out = fs.createWriteStream(tmp, 'utf8');
  let changed = false;
  for await (const line of lines(file)) {
    let l = line;
    if (line.includes('"cwd"')) {
      try {
        const o = JSON.parse(line);
        if (typeof o.cwd === 'string' && (o.cwd === oldCwd || o.cwd.startsWith(oldCwd + '/'))) {
          o.cwd = newCwd + o.cwd.slice(oldCwd.length);
          l = JSON.stringify(o);
          changed = true;
        }
      } catch { /* keep line as is */ }
    }
    if (!out.write(l + '\n')) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  if (changed) {
    await fsp.rename(tmp, file);
    await fsp.utimes(file, st.atime, st.mtime); // keep the original "last used" time
  } else {
    await fsp.unlink(tmp);
  }
}

async function moveSessions({ key, to, ids }) {
  const p = await getProject(key);
  if (p.source !== 'claude') throw new HttpError(400, 'Only Claude Code sessions are filed by folder, so only they can be moved.');
  if (typeof to !== 'string' || !to.trim()) throw new HttpError(400, 'Choose a folder.');
  const newCwd = path.resolve(expand(to.trim()));
  if (!isDir(newCwd)) throw new HttpError(400, `Folder does not exist: ${newCwd}`);
  const oldCwd = p.cwd;
  const dstKey = encode(newCwd);
  if (dstKey === key) throw new HttpError(400, 'These sessions already belong to that folder.');

  const src = path.join(ROOT, key);
  const dst = path.join(ROOT, dstKey);
  let names;
  if (Array.isArray(ids) && ids.length) {
    const known = new Set(p.sessions.map((s) => s.id));
    names = [];
    for (const id of ids) {
      if (!known.has(id)) throw new HttpError(400, `Unknown session: ${id}`);
      names.push(`${id}.jsonl`);
      if (exists(path.join(src, id))) names.push(id); // subagent and tool-result files
    }
  } else {
    names = await fsp.readdir(src);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = path.join(BACKUP, `${key}__${stamp}`);
  await fsp.mkdir(backup, { recursive: true });
  for (const n of names) {
    await fsp.cp(path.join(src, n), path.join(backup, n), { recursive: true, preserveTimestamps: true });
  }
  await fsp.writeFile(path.join(backup, 'backup.json'), JSON.stringify({
    key, from: oldCwd, to: newCwd, toKey: dstKey, items: names, at: new Date().toISOString(),
  }, null, 2));

  await fsp.mkdir(dst, { recursive: true });
  const moved = [];
  const skipped = [];
  for (const n of names) await mergeMove(path.join(src, n), path.join(dst, n), moved, skipped);
  if (oldCwd) {
    for (const m of moved) for (const f of await jsonlFiles(m)) await rewriteCwd(f, oldCwd, newCwd);
  }
  try { await fsp.rmdir(src); } catch { /* still holds other sessions */ }

  return {
    moved: names.filter((n) => n.endsWith('.jsonl') && !skipped.includes(path.join(key, n))).length,
    skipped,
    backup,
    to: newCwd,
  };
}

async function listBackups() {
  if (!isDir(BACKUP)) return [];
  const out = [];
  for (const name of await fsp.readdir(BACKUP)) {
    const dir = path.join(BACKUP, name);
    if (!isDir(dir)) continue;
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'backup.json'), 'utf8')); } catch { /* older backup */ }
    const files = await fsp.readdir(dir);
    out.push({
      name,
      key: meta.key || name.split('__')[0],
      from: meta.from || '',
      to: meta.to || '',
      at: meta.at || (await fsp.stat(dir)).mtime.toISOString(),
      sessions: files.filter((f) => f.endsWith('.jsonl')).length,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

async function restoreBackup(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name) || !isDir(path.join(BACKUP, name))) {
    throw new HttpError(404, 'Unknown backup.');
  }
  const b = (await listBackups()).find((x) => x.name === name);
  const dst = path.join(ROOT, b.key);
  const src = path.join(BACKUP, name);
  await fsp.mkdir(dst, { recursive: true });
  let restored = 0;
  const skipped = [];
  for (const n of await fsp.readdir(src)) {
    if (n === 'backup.json') continue;
    if (exists(path.join(dst, n))) { skipped.push(n); continue; }
    await fsp.cp(path.join(src, n), path.join(dst, n), { recursive: true, preserveTimestamps: true });
    if (n.endsWith('.jsonl')) restored++;
  }
  return { restored, skipped, to: dst };
}

// ---------- open a terminal running `claude --resume` ----------
function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* keep looking */ }
  }
  return null;
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function terminalCommand(cwd, command) {
  const run = `${command}; exec "\${SHELL:-bash}"`;
  if (process.platform === 'darwin') {
    const script = `cd ${shq(cwd)} && ${command}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate']];
  }
  const wanted = process.env.CHATSHELF_TERMINAL || process.env.CSM_TERMINAL;
  const options = {
    'gnome-terminal': [`--working-directory=${cwd}`, '--', 'bash', '-lc', run],
    ptyxis: ['--new-window', '--working-directory', cwd, '--', 'bash', '-lc', run],
    konsole: ['--workdir', cwd, '-e', 'bash', '-lc', run],
    kitty: ['--directory', cwd, 'bash', '-lc', run],
    alacritty: ['--working-directory', cwd, '-e', 'bash', '-lc', run],
    wezterm: ['start', '--cwd', cwd, '--', 'bash', '-lc', run],
    'xfce4-terminal': [`--working-directory=${cwd}`, '-x', 'bash', '-lc', run],
    xterm: ['-e', 'bash', '-lc', `cd ${shq(cwd)} && ${run}`],
  };
  const order = wanted ? [wanted] : ['gnome-terminal', 'ptyxis', 'konsole', 'kitty', 'alacritty', 'wezterm', 'xfce4-terminal', 'xterm'];
  for (const name of order) if (options[name] && which(name)) return [name, options[name]];
  return null;
}

async function openTerminal({ key, id }) {
  const p = await getProject(key);
  const s = p.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'Unknown session.');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, 'Bad session id.');
  if (!p.exists) {
    throw new HttpError(409, p.source === 'claude' ? 'The project folder no longer exists. Move this session to the new folder first.' : 'This chat has no project folder on this computer.');
  }
  // Editors: open the project folder in the app; the chat is in that app's own history.
  const apps = { cursor: 'cursor', copilot: 'code' };
  if (apps[p.source]) {
    if (!which(apps[p.source])) throw new HttpError(501, `The "${apps[p.source]}" command isn't on your PATH.`);
    spawn(apps[p.source], [p.cwd], { stdio: 'ignore', detached: true }).unref();
    return { terminal: p.source === 'cursor' ? 'Cursor' : 'VS Code', app: true };
  }
  const clis = { claude: ['claude', `claude --resume ${id}`], codex: ['codex', `codex resume ${id}`], opencode: ['opencode', 'opencode'], gemini: ['gemini', 'gemini'] };
  const cli = clis[p.source];
  if (!cli) throw new HttpError(400, 'This chat can only be opened on the website.');
  if (!which(cli[0])) throw new HttpError(501, `The "${cli[0]}" command isn't installed or isn't on your PATH. Copy the command instead.`);
  const cmd = terminalCommand(p.cwd, cli[1]);
  if (!cmd) throw new HttpError(501, 'No supported terminal found. Copy the command instead, or set CHATSHELF_TERMINAL.');
  spawn(cmd[0], cmd[1], { cwd: p.cwd, stdio: 'ignore', detached: true }).unref();
  return { terminal: path.basename(cmd[0]) };
}

// ---------- bookmarks (one JSON file, written atomically) ----------
function readBookmarks() {
  try { const v = JSON.parse(fs.readFileSync(BOOKMARKS, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeBookmarks(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${BOOKMARKS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, BOOKMARKS);
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function saveBookmark(b) {
  const kind = b.kind === 'chat' ? 'chat' : 'message';
  if (!ID_RE.test(b.sessionId || '') || (kind === 'message' && !ID_RE.test(b.msgUuid || ''))) throw new HttpError(400, 'Bad bookmark.');
  const list = readBookmarks();
  const same = (x) => x.sessionId === b.sessionId && (kind === 'chat' ? x.kind === 'chat' : x.kind !== 'chat' && x.msgUuid === b.msgUuid);
  let item = list.find(same);
  if (!item) {
    item = { id: crypto.randomUUID(), kind, sessionId: b.sessionId, createdAt: new Date().toISOString() };
    if (kind === 'message') item.msgUuid = b.msgUuid;
    list.push(item);
  }
  item.kind = kind;
  // Only overwrite what the request actually sends, so a partial update never wipes a note.
  const set = (k, max) => { if (typeof b[k] === 'string') item[k] = str(b[k], max); else if (item[k] === undefined) item[k] = ''; };
  if (kind === 'message') {
    if (b.role) item.role = b.role === 'assistant' ? 'assistant' : 'user';
    else if (!item.role) item.role = 'user';
    set('text', 600);
    set('ts', 40);
  }
  set('title', 200);
  set('cwd', 500);
  set('note', 500);
  item.updatedAt = new Date().toISOString();
  writeBookmarks(list);
  return { bookmark: item };
}

// ---------- read-only: bookmarks made with the Claude Code VS Code extension ----------
// The extension keeps one JSON file per session: { bookmarks: [{ uuid, addedAt }] }, where uuid is a
// transcript line id. We only read these files; the format belongs to the extension.
const EDITOR_BM_DIRS = (() => {
  const bases = process.platform === 'darwin' ? [path.join(HOME, 'Library', 'Application Support')]
    : process.platform === 'win32' ? [process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')]
      : [process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')];
  const apps = { Code: 'VS Code', 'Code - Insiders': 'VS Code Insiders', VSCodium: 'VSCodium', Cursor: 'Cursor', Windsurf: 'Windsurf' };
  return bases.flatMap((b) => Object.entries(apps).map(([dir, label]) => ({
    label, dir: path.join(b, dir, 'User', 'globalStorage', 'anthropic.claude-code', 'session-bookmarks'),
  })));
})();
const editorCache = new Map();

async function findSessionFile(id) {
  for (const d of await fsp.readdir(ROOT)) {
    const f = path.join(ROOT, d, `${id}.jsonl`);
    if (exists(f)) return f;
  }
  return null;
}

async function lookupLines(file, uuids) {
  const want = new Set(uuids);
  const found = new Map();
  for await (const line of lines(file)) {
    if (!want.size) break;
    let hit = null;
    for (const u of want) if (line.includes(u)) { hit = u; break; }
    if (!hit) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.uuid || !want.has(o.uuid)) continue;
    const c = o.message && o.message.content;
    let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
    if (!text && Array.isArray(c)) text = c.filter((x) => x.type === 'tool_use').map((x) => x.name).join(', ');
    found.set(o.uuid, { role: o.type === 'user' ? 'user' : 'assistant', text: text.replace(/\s+/g, ' ').trim().slice(0, 600), ts: o.timestamp || '' });
    want.delete(o.uuid);
  }
  return found;
}

async function readEditorBookmarks() {
  const out = [];
  for (const { label, dir } of EDITOR_BM_DIRS) {
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const n of names) {
      const sid = n.slice(0, -5);
      if (!n.endsWith('.json') || !ID_RE.test(sid)) continue;
      const f = path.join(dir, n);
      let st;
      try { st = await fsp.stat(f); } catch { continue; }
      const c = editorCache.get(f);
      if (c && c.m === st.mtimeMs) { out.push(...c.items); continue; }
      let data;
      try { data = JSON.parse(await fsp.readFile(f, 'utf8')); } catch { continue; }
      const marks = (Array.isArray(data.bookmarks) ? data.bookmarks : []).filter((b) => b && typeof b.uuid === 'string' && ID_RE.test(b.uuid));
      const sf = marks.length ? await findSessionFile(sid) : null;
      const found = sf ? await lookupLines(sf, marks.map((b) => b.uuid)) : new Map();
      const items = marks.map((b) => {
        const m = found.get(b.uuid) || {};
        return {
          id: `editor:${sid}:${b.uuid}`, kind: 'message', source: label, readOnly: true, sessionId: sid, msgUuid: b.uuid,
          createdAt: new Date(Number(b.addedAt) || st.mtimeMs).toISOString(), role: m.role || 'assistant', text: m.text || '', ts: m.ts || '', note: '',
        };
      });
      editorCache.set(f, { m: st.mtimeMs, items });
      out.push(...items);
    }
  }
  return out;
}

function deleteBookmark(id) {
  const list = readBookmarks();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) throw new HttpError(404, 'Unknown bookmark.');
  writeBookmarks(next);
  return { ok: true };
}

// ---------- HTTP ----------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(data);
}

async function readBody(req, max) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new HttpError(413, 'That file is too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function sourceStatus() {
  const claudeCount = (await scan()).filter((p) => p.source === 'claude').reduce((a, p) => a + p.sessions.length, 0);
  const out = [{ id: 'claude', label: 'Claude Code', found: claudeCount > 0, path: ROOT, count: claudeCount }];
  for (const r of READERS) {
    try { out.push({ ...(await r.status()), note: toolErrors.get(r.id) || undefined }); } catch (e) { out.push({ id: r.id, label: r.label, found: false, count: 0, note: e.message }); }
  }
  return out;
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new HttpError(413, 'Too large.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const q = url.searchParams;
  switch (route) {
    case 'GET /api/projects':
      return send(res, 200, { projects: await scan(), root: ROOT, backupRoot: BACKUP, home: HOME });
    case 'GET /api/session': {
      const p = await getProject(q.get('key'));
      const s = p.sessions.find((x) => x.id === q.get('id'));
      if (!s) throw new HttpError(404, 'Unknown session.');
      if (p.source === 'claude') return send(res, 200, { messages: await transcript(path.join(ROOT, p.key, `${s.id}.jsonl`)) });
      const handle = refs.get(`${p.key}|${s.id}`);
      if (!handle) throw new HttpError(404, 'Unknown session.');
      return send(res, 200, { messages: await reader(handle.reader).transcript(handle.ref) });
    }
    case 'GET /api/suggest': {
      const p = await getProject(q.get('key'));
      if (p.source !== 'claude') return send(res, 200, { suggestions: [] });
      const known = new Set((await scan()).map((x) => x.cwd));
      return send(res, 200, { suggestions: p.cwd ? suggest(p.cwd, known) : [] });
    }
    case 'GET /api/dirs':
      return send(res, 200, listDirs(q.get('path')));
    case 'POST /api/move':
      return send(res, 200, await moveSessions(await readJson(req)));
    case 'POST /api/open-terminal':
      return send(res, 200, await openTerminal(await readJson(req)));
    case 'GET /api/bookmarks':
      return send(res, 200, { bookmarks: readBookmarks(), external: await readEditorBookmarks() });
    case 'POST /api/bookmarks':
      return send(res, 200, saveBookmark(await readJson(req)));
    case 'POST /api/bookmarks/delete':
      return send(res, 200, deleteBookmark((await readJson(req)).id));
    case 'GET /api/sources':
      return send(res, 200, { sources: await sourceStatus() });
    case 'POST /api/import': {
      const buf = await readBody(req, 600 * 1024 * 1024);
      try { return send(res, 200, await importExport(buf, String(req.headers['x-filename'] || ''))); } catch (e) { throw new HttpError(400, e.message); }
    }
    case 'POST /api/imports/delete': {
      try { await removeImport((await readJson(req)).source); } catch (e) { throw new HttpError(400, e.message); }
      return send(res, 200, { ok: true });
    }
    case 'GET /api/backups':
      return send(res, 200, { backups: await listBackups() });
    case 'POST /api/restore':
      return send(res, 200, await restoreBackup((await readJson(req)).name));
    default:
      throw new HttpError(404, 'Not found.');
  }
}

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (!ALLOWED_HOSTS.has(host)) return send(res, 403, { error: 'Bad host.' });
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-token'] !== TOKEN) return send(res, 403, { error: 'Session expired. Reload the page.' });
      return await api(req, res, url);
    }
    const file = STATIC[url.pathname];
    if (!file || req.method !== 'GET') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    let body = await fsp.readFile(path.join(PUBLIC, file), 'utf8');
    if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN);
    return send(res, 200, body, TYPES[path.extname(file)]);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e.status || 500, { error: e.message || 'Something went wrong.' });
  }
});

// Browsers send any *.localhost name to this computer, so chatshelf.localhost needs no setup and,
// like 127.0.0.1, can never point anywhere else (which keeps the DNS-rebinding protection).
// Safari on macOS may not resolve *.localhost, so macOS opens 127.0.0.1; both always work.
const NICE_HOST = 'chatshelf.localhost';
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`, `${NICE_HOST}:${PORT}`]);
const niceUrl = `http://${NICE_HOST}:${PORT}/`;
const ipUrl = `http://${HOST}:${PORT}/`;
const appUrl = process.platform === 'darwin' ? ipUrl : niceUrl;
const open = () => {
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [appUrl], { stdio: 'ignore', detached: true }).unref();
};

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Chatshelf is already running at ${appUrl}`);
    open();
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`Chatshelf is running at ${appUrl}`);
  console.log(`  also at ${appUrl === niceUrl ? ipUrl : niceUrl}  (Ctrl+C to stop)`);
  console.log(`Reading sessions from ${ROOT}`);
  const t = Date.now();
  scan().then((p) => console.log(`Indexed ${p.reduce((n, x) => n + x.sessions.length, 0)} sessions in ${Date.now() - t} ms`));
  open();
});
