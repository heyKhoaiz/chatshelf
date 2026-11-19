#!/usr/bin/env node
// Chatshelf: a local web app to browse AI coding chats (Claude Code, Codex, Cursor, Copilot…) and
// move them when a project folder is renamed. Node built-ins only.
// This file is the web server: address, access checks and static files. The work is in core.mjs.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, HttpError, scan, ROOT, CACHE_FILE } from './core.mjs';

const HOST = '127.0.0.1';
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version; } catch { return ''; } })();

// ---------- address: --port / --host flags, CHATSHELF_PORT / CHATSHELF_HOST (or PORT) settings ----------
function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
const portSetting = flag('port') ?? process.env.CHATSHELF_PORT ?? process.env.PORT;
// A port the user chose is used as-is; otherwise start at 4317 and move up if it's taken.
const PORT_FIXED = portSetting !== undefined && portSetting !== '' && portSetting !== 'auto';
// CHATSHELF_FIRST_PORT only exists so the tests can check the automatic choice without touching 4317.
const DEFAULT_PORT = Number(process.env.CHATSHELF_FIRST_PORT || 4317);
let PORT = PORT_FIXED ? Number(portSetting) : DEFAULT_PORT;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`"${portSetting}" isn't a valid port. Use a number from 1 to 65535, e.g. --port 5000.`);
  process.exit(1);
}
// The name must be localhost or end in .localhost: browsers always send those to this computer,
// which keeps the DNS-rebinding protection.
const NICE_HOST = String(flag('host') ?? process.env.CHATSHELF_HOST ?? 'chatshelf.localhost').toLowerCase().replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*localhost$/.test(NICE_HOST)) {
  console.error(`"${NICE_HOST}" can't be used. Pick a name that ends in .localhost, e.g. --host work.localhost`);
  process.exit(1);
}
const TOKEN = crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

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

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new HttpError(413, 'Too large.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  let body = {};
  if (route === 'POST /api/import') body = { buf: await readBody(req, 600 * 1024 * 1024), filename: req.headers['x-filename'] };
  else if (req.method === 'POST') body = await readJson(req);
  return send(res, 200, await handle(route, url.searchParams, body));
}


const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/logo-reversed.svg': 'logo-reversed.svg', '/favicon.svg': 'favicon.svg', '/favicon.ico': 'favicon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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
    if (file === 'index.html') body = body.replace('__TOKEN__', TOKEN).replaceAll('__VERSION__', VERSION);
    return send(res, 200, body, TYPES[path.extname(file)]);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return send(res, e.status || 500, { error: e.message || 'Something went wrong.' });
  }
});

// Browsers send any *.localhost name to this computer, so chatshelf.localhost needs no setup and,
// like 127.0.0.1, can never point anywhere else (which keeps the DNS-rebinding protection).
// Safari on macOS may not resolve *.localhost, so macOS opens 127.0.0.1; both always work.
let ALLOWED_HOSTS = new Set();
let niceUrl = '';
let ipUrl = '';
let appUrl = '';
function setAddress(port) {
  PORT = port;
  ALLOWED_HOSTS = new Set([`${HOST}:${port}`, `localhost:${port}`, `chatshelf.localhost:${port}`, `${NICE_HOST}:${port}`]);
  niceUrl = `http://${NICE_HOST}:${port}/`;
  ipUrl = `http://${HOST}:${port}/`;
  appUrl = process.platform === 'darwin' ? ipUrl : niceUrl;
}
setAddress(PORT);

// Where the running copy writes its address, so `chatshelf` can find it again on any port.
const RUN_FILE = path.join(path.dirname(CACHE_FILE), 'running.json');
function readRunning() {
  try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch { return null; }
}
// Is the server on this port a Chatshelf? (Asks with an allowed Host header.)
function isChatshelf(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: 1500, headers: { Host: `${HOST}:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4000) res.destroy(); });
      res.on('end', () => resolve(body.includes('<title>Chatshelf')));
      res.on('close', () => resolve(body.includes('<title>Chatshelf')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
const open = (url = appUrl) => {
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
};

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function start() {
  // Already running somewhere (maybe on an automatic port)? Open that one instead.
  const running = readRunning();
  if (running && running.port && (!PORT_FIXED || running.port === PORT) && await isChatshelf(running.port)) {
    console.log(`Chatshelf is already running at ${running.url}`);
    open(running.url);
    process.exit(0);
  }
  const first = PORT;
  for (let port = first; port < first + 20; port++) {
    try {
      await listen(port);
      setAddress(port);
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await isChatshelf(port)) {
        setAddress(port);
        console.log(`Chatshelf is already running at ${appUrl}`);
        open();
        process.exit(0);
      }
      if (PORT_FIXED) {
        console.error(`Port ${port} is used by another program. Pick another one, e.g. --port ${port + 1}, or leave --port out to choose one automatically.`);
        process.exit(1);
      }
    }
  }
  console.error(`Ports ${first}-${first + 19} are all in use. Pick one with --port.`);
  process.exit(1);
}

const cleanup = () => {
  const r = readRunning();
  if (r && r.pid === process.pid) { try { fs.unlinkSync(RUN_FILE); } catch { /* already gone */ } }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

start().then(() => {
  fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify({ url: appUrl, port: PORT, pid: process.pid }));
  if (PORT !== DEFAULT_PORT && !PORT_FIXED) console.log(`Port ${DEFAULT_PORT} was busy, so Chatshelf picked ${PORT}.`);
  console.log(`Chatshelf is running at ${appUrl}`);
  console.log(`  also at ${appUrl === niceUrl ? ipUrl : niceUrl}  (Ctrl+C to stop)`);
  console.log(`Reading sessions from ${ROOT}`);
  const t = Date.now();
  scan().then((p) => console.log(`Indexed ${p.reduce((n, x) => n + x.sessions.length, 0)} sessions in ${Date.now() - t} ms`));
  open();
}).catch((e) => { console.error(e); process.exit(1); });
