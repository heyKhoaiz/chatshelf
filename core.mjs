// Chatshelf core: reads Claude Code sessions and the other tools' chats, moves and restores
// sessions, and keeps bookmarks. No HTTP here, so the same code runs behind the local web
// server (server.mjs) and inside the VS Code extension. Node built-ins only.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
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
const TAGS = path.join(DATA_DIR, 'tags.json');
const SETTINGS = path.join(DATA_DIR, 'settings.json');
const ARCHIVE = path.join(DATA_DIR, 'archive');
const CACHE_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'chatshelf', 'index.json');

// Claude Code names a project's session folder after its path, with every
// character that is not a letter or digit replaced by "-".
const CACHE_VERSION = 3;
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

// ---------- token usage and estimated API cost ----------
// Per million tokens: [match, input, output, cache read (default 10% of input)].
// Cache writes cost 1.25x input (5-minute) or 2x input (1-hour). List prices, so for people on a
// Claude subscription this is "what the same usage would cost on the API", not what they paid.
const PRICES = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2],
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable-5|mythos-5/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus-5/, 5, 25],
  [/opus-4-[5-9]/, 5, 25],
  [/opus-4|opus-3|3-opus/, 15, 75],
  [/sonnet-5-5/, 2, 10, 0.1],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/haiku-5-5/, 0.1, 0.5],
  [/haiku-4-5/, 1, 5],
  [/3-5-haiku|haiku-3-5/, 0.8, 4],
  [/haiku/, 0.25, 1.25],
];
export function priceOf(model) {
  const row = PRICES.find(([re]) => re.test(String(model || '')));
  return row ? { input: row[1], output: row[2], read: row[3] ?? row[1] * 0.1 } : null;
}
// u: { in, out, cw (5-minute writes), cw1h (1-hour writes), cr }
function costOf(model, u) {
  const p = priceOf(model);
  if (!p) return null;
  return (u.in * p.input + u.out * p.output + u.cw * p.input * 1.25 + (u.cw1h || 0) * p.input * 2 + u.cr * p.read) / 1e6;
}
const emptyUsage = () => ({ in: 0, out: 0, cw: 0, cw1h: 0, cr: 0 });
function finishUsage(models) {
  const total = { ...emptyUsage(), cost: null, models: {} };
  for (const [m, u] of Object.entries(models)) {
    const c = costOf(m, u);
    total.models[m] = { ...u, cost: c };
    for (const k of ['in', 'out', 'cw', 'cw1h', 'cr']) total[k] += u[k] || 0;
    if (c !== null) total.cost = (total.cost || 0) + c;
  }
  return total.in + total.out + total.cw + total.cw1h + total.cr ? total : null;
}

// Tools that change a file, and where they keep its path.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

async function parseSession(file) {
  const st = await fsp.stat(file);
  const hit = cache[file];
  if (hit && hit.v === CACHE_VERSION && hit.m === st.mtimeMs && hit.s === st.size) return { ...hit.d, mtime: st.mtimeMs, size: st.size };

  const d = { cwd: '', branch: '', custom: '', summary: '', prompts: [], promptCount: 0, start: '', last: '' };
  const models = {};
  const seenMsg = new Set();
  const files = new Set();
  for await (const line of lines(file)) {
    if (line.includes('"type":"assistant"')) {
      if (!line.includes('"usage"') && !line.includes('"tool_use"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message || {};
      // Claude Code writes one line per content block, each repeating the same usage: count it once.
      if (m.usage && m.model && m.model !== '<synthetic>' && !seenMsg.has(m.id || o.uuid)) {
        seenMsg.add(m.id || o.uuid);
        const u = m.usage;
        const cc = u.cache_creation || {};
        const w1h = Number(cc.ephemeral_1h_input_tokens) || 0;
        const t = models[m.model] || (models[m.model] = emptyUsage());
        t.in += Number(u.input_tokens) || 0;
        t.out += Number(u.output_tokens) || 0;
        t.cr += Number(u.cache_read_input_tokens) || 0;
        t.cw1h += w1h;
        t.cw += Math.max(0, (Number(u.cache_creation_input_tokens) || 0) - w1h);
      }
      if (Array.isArray(m.content) && files.size < 200) {
        for (const b of m.content) {
          if (b && b.type === 'tool_use' && EDIT_TOOLS.has(b.name) && b.input) {
            const f = b.input.file_path || b.input.notebook_path;
            if (typeof f === 'string' && f) files.add(f);
          }
        }
      }
      continue;
    }
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
  d.usage = finishUsage(models);
  d.files = [...files];
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

// ---------- settings (Chatshelf's own, one small JSON file) ----------
function readSettings() {
  try { const v = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${SETTINGS}.tmp`, SETTINGS);
  return next;
}

// ---------- archive: Chatshelf's own copy of every Claude Code session ----------
// Claude Code deletes sessions it hasn't touched in `cleanupPeriodDays` (30 by default). The archive
// copies each session file into Chatshelf's data folder, so a chat is still readable here after
// Claude Code removes it. Only copies; never changes or deletes Claude Code's files.
function claudeRetentionDays() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8')).cleanupPeriodDays;
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* no settings file */ }
  return 30;
}
const archiveFile = (key, id) => path.join(ARCHIVE, key, `${id}.jsonl`);

// Copies one session if the archived copy is missing or older. Returns true when the archive is current.
async function archiveOne(key, id, file, copy) {
  let src;
  try { src = await fsp.stat(file); } catch { return false; }
  const dst = archiveFile(key, id);
  try {
    const d = await fsp.stat(dst);
    if (d.size === src.size && Math.abs(d.mtimeMs - src.mtimeMs) < 1) return true;
  } catch { /* not archived yet */ }
  if (!copy) return false;
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp`;
  await fsp.copyFile(file, tmp);
  await fsp.utimes(tmp, src.atime, src.mtime);
  await fsp.rename(tmp, dst);
  return true;
}

// Archived sessions whose original is gone: id -> { key, file, mtime } (newest copy wins).
async function archivedOnly(live) {
  const out = new Map();
  if (!isDir(ARCHIVE)) return out;
  for (const key of await fsp.readdir(ARCHIVE)) {
    let names;
    try { names = await fsp.readdir(path.join(ARCHIVE, key)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (live.has(id)) continue;
      const file = path.join(ARCHIVE, key, n);
      let mtime = 0;
      try { mtime = (await fsp.stat(file)).mtimeMs; } catch { continue; }
      const prev = out.get(id);
      if (!prev || prev.mtime < mtime) out.set(id, { key, file, mtime });
    }
  }
  return out;
}

// "key|id" -> the session file to read (the original, or the archived copy).
const claudeFiles = new Map();

async function doScan() {
  const projects = new Map();
  const jobs = [];
  const live = new Set();
  if (isDir(ROOT)) {
    for (const e of (await fsp.readdir(ROOT, { withFileTypes: true })).filter((x) => x.isDirectory())) {
      const dir = path.join(ROOT, e.name);
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      const p = { key: e.name, source: 'claude', cwd: '', exists: false, missing: false, memory: names.includes('memory'), sessions: [] };
      projects.set(e.name, p);
      for (const n of names) if (n.endsWith('.jsonl')) { jobs.push({ p, id: n.slice(0, -6), file: path.join(dir, n) }); live.add(n.slice(0, -6)); }
    }
  }
  const autoArchive = Boolean(readSettings().autoArchive);
  await pool(jobs, 8, async (j) => { try { j.kept = await archiveOne(j.p.key, j.id, j.file, autoArchive); } catch { j.kept = false; } });
  for (const [id, a] of await archivedOnly(live)) {
    let p = projects.get(a.key);
    if (!p) { p = { key: a.key, source: 'claude', cwd: '', exists: false, missing: false, memory: false, sessions: [], archivedOnly: true }; projects.set(a.key, p); }
    jobs.push({ p, id, file: a.file, only: true });
  }
  const seen = new Set(jobs.map((j) => j.file));
  claudeFiles.clear();
  await pool(jobs, 8, async (j) => {
    try {
      j.p.sessions.push({ id: j.id, ...(await parseSession(j.file)), archived: j.only ? 'only' : j.kept ? 'kept' : '' });
      claudeFiles.set(`${j.p.key}|${j.id}`, j.file);
    } catch { /* unreadable file */ }
  });
  saveCache(seen);
  for (const p of projects.values()) {
    p.sessions.sort((a, b) => b.mtime - a.mtime);
    const cwds = p.sessions.map((s) => s.cwd).filter(Boolean);
    p.cwd = cwds.find((c) => encode(c) === p.key) || cwds[0] || '';
    p.exists = p.cwd ? isDir(p.cwd) : false;
    // A project that only lives in the archive has nothing for Claude Code to find, so nothing to fix.
    p.missing = Boolean(p.cwd) && !p.exists && !p.archivedOnly;
    p.updated = p.sessions[0] ? p.sessions[0].mtime : 0;
    for (const s of p.sessions) s.source = 'claude';
  }
  const others = await scanOtherTools();
  return [...[...projects.values()].filter((p) => p.sessions.length || p.memory), ...others].sort((a, b) => b.updated - a.updated);
}

async function archiveStatus() {
  const sessions = (await scan()).filter((p) => p.source === 'claude').flatMap((p) => p.sessions);
  const retentionDays = claudeRetentionDays();
  const soon = Date.now() - Math.max(1, retentionDays - 7) * 864e5;
  const liveS = sessions.filter((s) => s.archived !== 'only');
  return {
    auto: Boolean(readSettings().autoArchive),
    dir: ARCHIVE,
    retentionDays,
    total: liveS.length,
    totalBytes: liveS.reduce((n, s) => n + s.size, 0),
    kept: liveS.filter((s) => s.archived === 'kept').length,
    only: sessions.filter((s) => s.archived === 'only').length,
    atRisk: liveS.filter((s) => s.archived !== 'kept' && s.mtime < soon).length,
  };
}

async function archiveNow() {
  const projects = (await scan()).filter((p) => p.source === 'claude');
  let copied = 0;
  let failed = 0;
  const jobs = projects.flatMap((p) => p.sessions.filter((s) => s.archived === '').map((s) => ({ p, s })));
  await pool(jobs, 6, async ({ p, s }) => {
    try { if (await archiveOne(p.key, s.id, path.join(ROOT, p.key, `${s.id}.jsonl`), true)) copied++; } catch { failed++; }
  });
  return { copied, failed, ...(await archiveStatus()) };
}

// Puts an archived session back where Claude Code looks for it, so `claude --resume` works again.
async function restoreFromArchive({ key, id }) {
  const p = await getProject(key);
  const s = p.sessions.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'Unknown session.');
  if (s.archived !== 'only') throw new HttpError(400, 'This session is still in Claude Code. Nothing to restore.');
  const src = claudeFiles.get(`${key}|${id}`);
  const dst = path.join(ROOT, key, `${id}.jsonl`);
  if (exists(dst)) throw new HttpError(409, 'Claude Code already has a session with this ID.');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  const st = await fsp.stat(src);
  await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
  await fsp.utimes(dst, st.atime, st.mtime);
  return { to: dst, cwd: p.cwd };
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
  if (typeof key !== 'string' || !/^[A-Za-z0-9:._-]{1,400}$/.test(key)) throw new HttpError(404, 'Unknown project.');
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
  if (!isDir(src)) throw new HttpError(400, 'These chats are only in Chatshelf\'s archive. Restore them to Claude Code first.');
  let names;
  if (Array.isArray(ids) && ids.length) {
    const known = new Set(p.sessions.filter((s) => s.archived !== 'only').map((s) => s.id));
    names = [];
    for (const id of ids) {
      if (!known.has(id)) throw new HttpError(400, p.sessions.some((s) => s.id === id) ? 'That chat is only in Chatshelf\'s archive. Restore it to Claude Code first.' : `Unknown session: ${id}`);
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
// A host such as the VS Code extension can run commands in its own terminal instead:
// setTerminalRunner(async ({ cwd, command, name }) => 'label shown to the user').
let terminalRunner = null;
export function setTerminalRunner(fn) { terminalRunner = fn; }
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
  if (s.archived === 'only') throw new HttpError(409, 'Claude Code no longer has this chat. Restore it from the archive first.');
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
  if (terminalRunner) return { terminal: await terminalRunner({ cwd: p.cwd, command: cli[1], name: cli[0] }) };
  const cmd = terminalCommand(p.cwd, cli[1]);
  if (!cmd) throw new HttpError(501, 'No supported terminal found. Copy the command instead, or set CHATSHELF_TERMINAL.');
  spawn(cmd[0], cmd[1], { cwd: p.cwd, stdio: 'ignore', detached: true }).unref();
  return { terminal: path.basename(cmd[0]) };
}

// ---------- handoff: continue a chat in another tool ----------
// The handoff text goes into a private temp file and the tool starts with it as its first message.
// Nothing is written into any tool's own history.
const HANDOFF_TARGETS = { codex: { bin: 'codex', label: 'Codex' }, claude: { bin: 'claude', label: 'Claude Code' } };
const noSpawn = () => Boolean(process.env.CHATSHELF_NO_SPAWN); // tests: build the command, don't run it

function handoffTargets() {
  const out = {};
  for (const [id, t] of Object.entries(HANDOFF_TARGETS)) out[id] = { label: t.label, installed: Boolean(which(t.bin)) };
  return out;
}

async function startHandoff({ key, id, target, text }) {
  const p = await getProject(key);
  if (!p.sessions.some((x) => x.id === id)) throw new HttpError(404, 'Unknown session.');
  const t = HANDOFF_TARGETS[target];
  if (!t) throw new HttpError(400, 'Pick Codex or Claude Code.');
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'The handoff is empty.');
  if (text.length > 20000) throw new HttpError(400, 'The handoff is too long (20,000 characters max). Shorten it first.');
  if (!which(t.bin) && !noSpawn()) throw new HttpError(501, `${t.label} isn't installed (no "${t.bin}" command). Use Copy instead.`);
  const cwd = p.exists ? p.cwd : HOME;
  const file = path.join(os.tmpdir(), `chatshelf-handoff-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  const command = `${t.bin} "$(cat ${shq(file)})"`;
  if (noSpawn()) return { dryRun: true, command, file, cwd };
  if (terminalRunner) return { terminal: await terminalRunner({ cwd, command, name: t.label }), target: t.label, cwd };
  const cmd = terminalCommand(cwd, command);
  if (!cmd) throw new HttpError(501, 'No supported terminal found. Use Copy instead, or set CHATSHELF_TERMINAL.');
  spawn(cmd[0], cmd[1], { cwd, stdio: 'ignore', detached: true }).unref();
  return { terminal: path.basename(cmd[0]), target: t.label, cwd };
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

async function sourceStatus() {
  const claudeCount = (await scan()).filter((p) => p.source === 'claude').reduce((a, p) => a + p.sessions.length, 0);
  const out = [{ id: 'claude', label: 'Claude Code', found: claudeCount > 0, path: ROOT, count: claudeCount }];
  for (const r of READERS) {
    try { out.push({ ...(await r.status()), note: toolErrors.get(r.id) || undefined }); } catch (e) { out.push({ id: r.id, label: r.label, found: false, count: 0, note: e.message }); }
  }
  return out;
}

// ---------- reading any chat ----------
async function readMessages(p, s) {
  if (p.source === 'claude') {
    const file = claudeFiles.get(`${p.key}|${s.id}`) || path.join(ROOT, p.key, `${s.id}.jsonl`);
    return transcript(file);
  }
  const ref = refs.get(`${p.key}|${s.id}`);
  if (!ref) throw new HttpError(404, 'Unknown session.');
  return reader(ref.reader).transcript(ref.ref);
}

// ---------- search inside every message (your prompts and the replies) ----------
// Each chat's text is read once and kept in memory (least recently used first out, capped), and
// read again only when the chat changes.
const TEXT_BUDGET = 60e6; // characters (roughly 60–120 MB of memory)
const textCache = new Map();
let textChars = 0;
async function chatText(p, s) {
  const k = `${p.key}|${s.id}`;
  const stamp = `${s.mtime}:${s.size}`;
  const hit = textCache.get(k);
  if (hit && hit.stamp === stamp) { textCache.delete(k); textCache.set(k, hit); return hit; }
  if (hit) { textCache.delete(k); textChars -= hit.text.length; }
  const parts = [];
  const offs = [];
  const meta = [];
  let len = 0;
  for (const m of await readMessages(p, s)) {
    const t = [m.text, ...(m.tools || []).map((x) => `${x.name || ''} ${x.detail || ''}`)].filter(Boolean).join('\n');
    if (!t) continue;
    offs.push(len);
    meta.push({ role: m.role, uuid: m.uuid || '' });
    parts.push(t);
    len += t.length + 1;
    if (len > 800e3) break;
  }
  const entry = { stamp, text: parts.join('\u0000'), offs, meta };
  textCache.set(k, entry);
  textChars += entry.text.length;
  for (const [key, v] of textCache) { if (textChars <= TEXT_BUDGET) break; textCache.delete(key); textChars -= v.text.length; }
  return entry;
}
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every word must appear somewhere in the chat. The snippet comes from the message with the first word.
async function search({ q, limit = 200, source = '' }) {
  const words = String(q || '').trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
  if (!words.length) return { hits: [], scanned: 0 };
  const res = words.map((w) => new RegExp(reEscape(w), 'i'));
  const all = (await scan()).flatMap((p) => p.sessions.filter((s) => !source || s.source === source).map((s) => ({ p, s })));
  const hits = [];
  await pool(all, 6, async ({ p, s }) => {
    let e;
    try { e = await chatText(p, s); } catch { return; }
    if (!res.every((r) => r.test(e.text))) return;
    const m = res[0].exec(e.text);
    let lo = 0;
    let hi = e.offs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e.offs[mid] <= m.index) lo = mid; else hi = mid - 1; }
    const start = e.offs[lo] ?? 0;
    const end = e.text.indexOf('\u0000', start);
    const msg = e.text.slice(start, end < 0 ? undefined : end);
    const at = m.index - start;
    const from = Math.max(0, at - 70);
    const snippet = (from ? '…' : '') + msg.slice(from, at + 130).replace(/\s+/g, ' ').trim() + (at + 130 < msg.length ? '…' : '');
    hits.push({ key: p.key, id: s.id, mtime: s.mtime, role: e.meta[lo] ? e.meta[lo].role : 'assistant', uuid: e.meta[lo] ? e.meta[lo].uuid : '', snippet });
  });
  hits.sort((a, b) => b.mtime - a.mtime);
  return { hits: hits.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))), total: hits.length, scanned: all.length };
}

// ---------- tags (sessionId -> ["tag", ...]) ----------
const TAG_RE = /^[a-z0-9][a-z0-9_.+-]{0,31}$/;
function readTags() {
  try { const v = JSON.parse(fs.readFileSync(TAGS, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function saveTags({ sessionId, tags }) {
  if (!ID_RE.test(sessionId || '')) throw new HttpError(400, 'Bad session id.');
  if (!Array.isArray(tags)) throw new HttpError(400, 'Tags must be a list.');
  const clean = [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean))];
  const bad = clean.find((t) => !TAG_RE.test(t));
  if (bad) throw new HttpError(400, `"${bad.slice(0, 40)}" can't be a tag. Use letters, numbers, - or _ (32 characters max).`);
  if (clean.length > 12) throw new HttpError(400, 'A chat can have up to 12 tags.');
  const all = readTags();
  if (clean.length) all[sessionId] = clean; else delete all[sessionId];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${TAGS}.tmp`, JSON.stringify(all, null, 2));
  fs.renameSync(`${TAGS}.tmp`, TAGS);
  return { sessionId, tags: clean };
}

// ---------- routes ----------
// One entry point for every caller. `route` is "METHOD /api/path", `query` a URLSearchParams,
// `body` the parsed JSON body (or, for /api/import, { buf, filename }). Returns the response
// object or throws an HttpError. Callers check access before calling this.
export async function handle(route, query = new URLSearchParams(), body = {}) {
  const q = query;
  switch (route) {
    case 'GET /api/projects':
      return { projects: await scan(), root: ROOT, backupRoot: BACKUP, home: HOME };
    case 'GET /api/session': {
      const p = await getProject(q.get('key'));
      const s = p.sessions.find((x) => x.id === q.get('id'));
      if (!s) throw new HttpError(404, 'Unknown session.');
      return { messages: await readMessages(p, s) };
    }
    case 'GET /api/search':
      return search({ q: q.get('q'), limit: q.get('limit'), source: q.get('source') || '' });
    case 'GET /api/tags':
      return { tags: readTags() };
    case 'POST /api/tags':
      return saveTags(body);
    case 'GET /api/archive':
      return archiveStatus();
    case 'POST /api/archive/settings':
      writeSettings({ autoArchive: Boolean(body.auto) });
      return body.auto ? archiveNow() : archiveStatus();
    case 'POST /api/archive/run':
      return archiveNow();
    case 'POST /api/archive/restore':
      return restoreFromArchive(body);
    case 'GET /api/suggest': {
      const p = await getProject(q.get('key'));
      if (p.source !== 'claude') return { suggestions: [] };
      const known = new Set((await scan()).map((x) => x.cwd));
      return { suggestions: p.cwd ? suggest(p.cwd, known) : [] };
    }
    case 'GET /api/dirs':
      return listDirs(q.get('path'));
    case 'POST /api/move':
      return moveSessions(body);
    case 'POST /api/open-terminal':
      return openTerminal(body);
    case 'GET /api/bookmarks':
      return { bookmarks: readBookmarks(), external: await readEditorBookmarks() };
    case 'POST /api/bookmarks':
      return saveBookmark(body);
    case 'POST /api/bookmarks/delete':
      return deleteBookmark(body.id);
    case 'GET /api/handoff/targets':
      return { targets: handoffTargets() };
    case 'POST /api/handoff':
      return startHandoff(body);
    case 'GET /api/sources':
      return { sources: await sourceStatus() };
    case 'POST /api/import':
      try { return await importExport(body.buf, String(body.filename || '')); } catch (e) { throw new HttpError(400, e.message); }
    case 'POST /api/imports/delete':
      try { await removeImport(body.source); } catch (e) { throw new HttpError(400, e.message); }
      return { ok: true };
    case 'GET /api/backups':
      return { backups: await listBackups() };
    case 'POST /api/restore':
      return restoreBackup(body.name);
    default:
      throw new HttpError(404, 'Not found.');
  }
}

export { HttpError, scan, search, readMessages, ROOT, CACHE_FILE };
