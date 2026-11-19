const $ = (id) => document.getElementById(id);
const PAGE = 150;
const DAY = 864e5;
const root = document.documentElement;
const openToolsOnLoad = location.hash === '#tools';
let deepLink = location.hash.startsWith('#s=') ? decodeURIComponent(location.hash.slice(3)) : '';

const state = {
  projects: [], sessions: [], byUid: new Map(), home: '', root: '', view: 'overview', shown: PAGE,
  sort: 'new', sessTab: 'all', projTab: 'all', selected: new Set(), detail: null, mover: null,
  msgs: [], hits: [], hitIdx: 0, loaded: false, src: '', sources: [], bookmarks: [], bmIndex: new Map(), external: [], extIndex: new Map(), focusMsg: '',
  pins: new Set(), chatMarks: new Map(), bmTab: 'all',
  tags: {}, deep: { q: '', src: '', hits: new Map(), busy: false }, archive: null, urange: '30', utool: '',
};

// ---------- host: the local web server, or the VS Code extension ----------
// Inside VS Code the page runs in a webview with no server: every call goes to the extension as a
// message ({ type, id, ...payload }) and comes back as { type: 'reply', id, ok, data | error }.
const vsc = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const pending = new Map();
let seq = 0;
if (vsc) {
  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'reply' || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'Something went wrong.'));
  });
}
const host = (type, payload = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  vsc.postMessage({ type, id, ...payload });
});
const openUrl = (url) => (vsc ? host('open-url', { url }) : window.open(url, '_blank', 'noopener,noreferrer'));
const copyText = (text) => (vsc ? host('copy', { text }) : navigator.clipboard.writeText(text));

// ---------- helpers ----------
async function api(path, body) {
  if (vsc) return host('api', { method: body ? 'POST' : 'GET', path, body });
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': window.CSM_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (p) => (p && state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p || '');
const base = (p) => (p ? p.split('/').filter(Boolean).pop() || '/' : '');
const encode = (p) => p.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
const expand = (p) => (p === '~' ? state.home : p.startsWith('~/') ? state.home + p.slice(1) : p);
const shq = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const date = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const size = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
const motionOn = () => root.classList.contains('motion');
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 6e4);
  if (m < 10) return 'Now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  if (m < 43200) return `${Math.round(m / 1440)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function hl(text, q) {
  const s = String(text ?? '');
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(q);
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
}
const use = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const ICON = {
  folder: use('folder'),
  pin: use('pin'),
  bookmark: use('bookmark'),
  clock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>',
  branch: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/></svg>',
  warn: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19Z"/><path d="M12 10v4M12 17h.01"/></svg>',
  check: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  reply: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/></svg>',
};
let toastTimer;
function toast(msg, action) {
  const t = $('toast');
  t.innerHTML = esc(msg) + (action ? ` <a class="toast-act" href="${esc(action.href)}" target="_blank" rel="noopener noreferrer"${action.star ? ' data-star-click' : ''}>${esc(action.label)}</a>` : '');
  t.classList.toggle('has-action', Boolean(action));
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 8000 : 4500);
}
async function copy(text, btn) {
  await copyText(text);
  const label = btn.querySelector('span') || btn;
  const old = label.textContent;
  label.textContent = 'Copied';
  btn.classList.add('done');
  setTimeout(() => { label.textContent = old; btn.classList.remove('done'); }, 1500);
}
const resumeCmd = (cwd, id) => `cd ${shq(cwd)} && claude --resume ${id}`;
const timeChip = (ms) => {
  const a = ago(ms);
  return `<span class="chip${a === 'Now' ? ' now' : ''}">${ICON.clock}${a}</span>`;
};

// ---------- GitHub (public project) ----------
const REPO = 'heyKhoaiz/chatshelf';
const REPO_URL = `https://github.com/${REPO}`;
const MCP_CMD = 'claude mcp add chatshelf -- npx -y chatshelf mcp';
// Shows the star count next to "Star on GitHub". Uses GitHub's public API (no account, nothing about you is sent),
// cached for 6 hours, and stays hidden when offline.
async function loadStars() {
  const show = (n) => {
    if (typeof n !== 'number' || n < 10) return;
    document.querySelectorAll('[data-star-count]').forEach((el) => { el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); el.hidden = false; });
  };
  try {
    const c = JSON.parse(localStorage.getItem('chatshelf-stars') || 'null');
    if (c && Date.now() - c.at < 6 * 36e5) { show(c.n); return; }
    const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: 'application/vnd.github+json' }, referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
    const n = (await res.json()).stargazers_count;
    localStorage.setItem('chatshelf-stars', JSON.stringify({ n, at: Date.now() }));
    show(n);
  } catch { /* offline: leave the plain button */ }
}

// Ask for a star at the right time: a quiet button at first, a small card from the 3rd visit,
// "Not now" waits 30 days, and after one click we never ask again.
const STAR_KEY = 'chatshelf-star';
const starState = () => { try { return JSON.parse(localStorage.getItem(STAR_KEY) || '{}'); } catch { return {}; } };
const saveStar = (st) => localStorage.setItem(STAR_KEY, JSON.stringify(st));
function renderStar() {
  const st = starState();
  const ask = !st.clicked && (st.visits || 0) >= 3 && (!st.laterUntil || Date.now() > st.laterUntil);
  $('starCard').hidden = !ask;
  $('ghStar').hidden = ask;
  $('ghStar').classList.toggle('starred', Boolean(st.clicked));
}
function initStar() {
  const st = starState();
  st.visits = (st.visits || 0) + 1;
  saveStar(st);
  renderStar();
}
function starClicked() { const st = starState(); st.clicked = true; saveStar(st); setTimeout(renderStar, 300); }
function starLater() { const st = starState(); st.laterUntil = Date.now() + 30 * DAY; saveStar(st); renderStar(); }

// ---------- tools ----------
const TOOLS = {
  claude: { label: 'Claude Code', short: 'Claude' },
  codex: { label: 'Codex', short: 'Codex' },
  cursor: { label: 'Cursor', short: 'Cursor' },
  copilot: { label: 'Copilot Chat', short: 'Copilot' },
  opencode: { label: 'OpenCode', short: 'OpenCode' },
  gemini: { label: 'Gemini CLI', short: 'Gemini' },
  chatgpt: { label: 'ChatGPT', short: 'ChatGPT' },
  claudeai: { label: 'claude.ai', short: 'claude.ai' },
};
// Who answered in a chat from each tool, and the avatar mark to show.
const ASSISTANT = { claude: ['Claude', '✳'], claudeai: ['Claude', '✳'], codex: ['Codex', 'C'], cursor: ['Cursor', 'Cu'], copilot: ['Copilot', 'Co'], opencode: ['OpenCode', 'O'], gemini: ['Gemini', 'G'], chatgpt: ['ChatGPT', 'G'] };
const assistantOf = (src) => ASSISTANT[src] || ['Assistant', 'A'];
const toolLabel = (id) => (TOOLS[id] || { label: id }).label;
const toolBadge = (id) => `<span class="src s-${esc(id)}">${esc((TOOLS[id] || { short: id }).short)}</span>`;
const projName = (p) => base(p.cwd) || (p.source === 'claude' ? p.key : 'No folder');
const claudeProjects = () => state.projects.filter((p) => p.source === 'claude');

// How to pick a chat back up, per tool.
function resumeInfo(s) {
  const p = s.project;
  const q = p.cwd ? shq(p.cwd) : '';
  const inDir = (c) => (q ? `cd ${q} && ${c}` : c);
  switch (s.source) {
    case 'claude': return { kind: 'terminal', label: 'Resume in terminal', cmd: inDir(`claude --resume ${s.id}`), open: 'Open in terminal' };
    case 'codex': return { kind: 'terminal', label: 'Resume with Codex', cmd: inDir(`codex resume ${s.id}`), open: 'Open in terminal', note: 'Needs the Codex CLI. Chats started in the Codex VS Code extension also show up in its history panel.' };
    case 'cursor': return { kind: 'app', label: 'Continue in Cursor', cmd: q ? `cursor ${q}` : 'cursor', open: 'Open in Cursor', note: 'Opens the project. The chat is in Cursor’s chat history.' };
    case 'copilot': return { kind: 'app', label: 'Continue in VS Code', cmd: q ? `code ${q}` : 'code', open: 'Open in VS Code', note: 'Opens the project. The chat is in the Copilot Chat history of that workspace.' };
    case 'opencode': return { kind: 'terminal', label: 'Continue in OpenCode', cmd: inDir('opencode'), open: 'Open in terminal', note: 'Opens OpenCode in the project; pick this chat from its session list.' };
    case 'gemini': return { kind: 'terminal', label: 'Continue in Gemini CLI', cmd: inDir('gemini'), open: 'Open in terminal', note: 'Opens Gemini CLI in the project folder.' };
    case 'chatgpt': return { kind: 'url', label: 'Continue on the web', cmd: s.url || '', open: 'Open on chatgpt.com', url: s.url };
    case 'claudeai': return { kind: 'url', label: 'Continue on the web', cmd: s.url || '', open: 'Open on claude.ai', url: s.url };
    default: return { kind: 'none', label: 'Resume', cmd: '', open: 'Open' };
  }
}

// ---------- motion (power3-out easing, blur-to-sharp rise, word-by-word headings) ----------
function splitWords(el) {
  if (!el || el.dataset.split === el.textContent) return;
  const text = el.textContent;
  el.setAttribute('aria-label', text);
  let n = 0;
  el.innerHTML = text.split(/(\s+)/).map((w) => (/^\s+$/.test(w) || !w ? w : `<span class="w" aria-hidden="true" style="--i:${n++}">${esc(w)}</span>`)).join('');
  el.dataset.split = el.textContent;
}
function replay(el, cls = 'in') {
  if (!el || !motionOn()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
function stagger(container, selector = ':scope > *', max = 14) {
  if (!container || !motionOn()) return;
  [...container.querySelectorAll(selector)].slice(0, max).forEach((el, i) => {
    el.style.setProperty('--i', i);
    replay(el, 'rv');
  });
}
function countUp(el) {
  const target = Number(el.dataset.n);
  if (!motionOn() || !Number.isFinite(target) || target === 0) return;
  const t0 = performance.now();
  const dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function animateView(view) {
  if (!motionOn()) return;
  const sec = $(`view-${view}`);
  sec.querySelectorAll('.split').forEach((h) => { splitWords(h); replay(h); });
  sec.querySelectorAll('.rv-text').forEach((el) => replay(el));
  if (!state.loaded) return;
  if (view === 'overview') {
    stagger($('stats'));
    $('stats').querySelectorAll('.stat-num').forEach(countUp);
    stagger($('pinned'));
    stagger($('recent'), ':scope > *', 8);
    stagger(document.querySelector('.right'), ':scope > .panel');
    replay($('heat'));
    replay($('topProjects'));
  } else if (view === 'sessions') {
    stagger($('list'), ':scope > .row, :scope > .date-head', 16);
  } else if (view === 'projects') {
    replay($('projSummary'), 'rv');
    replay($('projSummary').querySelector('.segbar'));
    stagger($('projects'), ':scope > .tr, :scope > .group-head', 16);
  } else if (view === 'backups') {
    stagger($('backups'));
  } else if (view === 'bookmarks') {
    stagger($('bmList'), ':scope > .bm-group', 10);
  } else if (view === 'usage') {
    stagger($('usageStats'));
    replay($('usageChart'));
    stagger($('usageTop'), ':scope > *', 8);
  }
}

// ---------- skeletons ----------
function skeletons() {
  const line = (w) => `<span class="sk" style="width:${w}"></span>`;
  const row = () => `<div class="row skel">${line('46%')}<span class="sk chip-sk"></span>${line('30%')}</div>`;
  $('stats').innerHTML = Array.from({ length: 4 }, () => `<div class="stat skel"><div class="stat-top">${line('40%')}${line('70%')}</div><div class="stat-foot">${line('60%')}</div></div>`).join('');
  $('recent').innerHTML = Array.from({ length: 6 }, row).join('');
  $('list').innerHTML = Array.from({ length: 8 }, row).join('');
  $('today').textContent = 'Reading your sessions…';
}

// ---------- pins ----------
// Chat bookmarks (whole sessions). `state.pins` holds the uids of bookmarked chats for quick lookups.
function computePins() {
  state.pins = new Set(state.sessions.filter((s) => state.chatMarks.has(s.id)).map((s) => s.uid));
}
async function togglePin(uid) {
  const s = state.byUid.get(uid);
  if (!s) return;
  const existing = state.chatMarks.get(s.id);
  try {
    if (existing) {
      await api('/api/bookmarks/delete', { id: existing.id });
      state.chatMarks.delete(s.id);
      toast('Chat bookmark removed');
    } else {
      const { bookmark } = await api('/api/bookmarks', { kind: 'chat', sessionId: s.id, title: s.title, cwd: s.project.cwd, note: '' });
      state.chatMarks.set(s.id, bookmark);
      toast(`Bookmarked chat "${s.title.slice(0, 50)}"`);
    }
  } catch (e) { toast(e.message); return; }
  computePins();
  renderAll();
  if (state.detail && state.detail.uid === uid) syncPinButton();
}
// One-time move of old browser-only pins into chat bookmarks on disk.
async function migratePins() {
  const old = JSON.parse(localStorage.getItem('csm-pins') || '[]');
  if (!old.length) return;
  for (const uid of old) {
    const s = state.byUid.get(uid);
    if (!s || state.chatMarks.has(s.id)) continue;
    try {
      const { bookmark } = await api('/api/bookmarks', { kind: 'chat', sessionId: s.id, title: s.title, cwd: s.project.cwd, note: '' });
      state.chatMarks.set(s.id, bookmark);
    } catch { return; }
  }
  localStorage.removeItem('csm-pins');
  computePins();
  renderAll();
}
const pinnedSessions = () => state.sessions.filter((s) => state.pins.has(s.uid));

// ---------- data ----------
async function load() {
  try {
    const [data, bm, tg] = await Promise.all([api('/api/projects'), api('/api/bookmarks').catch(() => ({ bookmarks: [] })), api('/api/tags').catch(() => ({ tags: {} }))]);
    state.tags = tg.tags || {};
    state.deep = { q: '', src: '', hits: new Map(), busy: false };
    setBookmarks(bm.bookmarks);
    setExternal(bm.external);
    state.home = data.home;
    state.root = data.root;
    $('backupRoot').textContent = short(data.backupRoot);
    state.projects = data.projects.map((p) => ({ ...p, bytes: p.sessions.reduce((n, s) => n + s.size, 0) }));
    state.sessions = state.projects.flatMap((p) => p.sessions.map((s) => withHay({
      ...s,
      files: s.files || [],
      tags: state.tags[s.id] || [],
      project: p,
      uid: `${p.key}|${s.id}`,
    })));
    state.sessions.sort((a, b) => b.mtime - a.mtime);
    state.byUid = new Map(state.sessions.map((s) => [s.uid, s]));
    computePins();
    for (const u of [...state.selected]) if (!state.byUid.has(u)) state.selected.delete(u);
    const first = !state.loaded;
    state.loaded = true;
    renderAll();
    if (first) animateView(state.view);
    if (deepLink) { openDetail(deepLink); deepLink = ''; }
    if (first && openToolsOnLoad) openSources();
    migratePins();
    loadArchive();
  } catch (e) {
    $('today').textContent = '';
    $('recent').innerHTML = emptyState('Could not read sessions', esc(e.message), '<button type="button" class="btn" data-reload>Try again</button>');
    $('list').innerHTML = $('recent').innerHTML;
  } finally {
    ['stats', 'recent', 'list'].forEach((id) => $(id).removeAttribute('aria-busy'));
  }
}

function emptyState(title, text, action = '') {
  return `<div class="empty"><div class="empty-ic">${use('search')}</div><p class="empty-title">${esc(title)}</p><p class="small muted">${text}</p>${action}</div>`;
}

// What the session search box looks through (lower case). Tags match as "#tag".
function withHay(s) {
  const p = s.project;
  s.hay = [s.title, p.cwd, p.key, s.id, s.branch, toolLabel(s.source), ...s.prompts, ...s.files, ...s.tags.map((t) => `#${t}`)].join('\n').toLowerCase();
  return s;
}

function renderAll() {
  const missing = state.projects.filter((p) => p.missing);
  $('navSessions').textContent = state.sessions.length.toLocaleString();
  $('navMissing').hidden = !missing.length;
  $('navMissing').textContent = missing.length;
  const sel = $('proj');
  const current = sel.value;
  sel.innerHTML = '<option value="">All projects</option>' + state.projects
    .filter((p) => p.sessions.length)
    .map((p) => `<option value="${esc(p.key)}">${esc(projName(p))} · ${esc(toolLabel(p.source))} (${p.sessions.length})</option>`)
    .join('');
  sel.value = state.projects.some((p) => p.key === current) ? current : '';
  renderSidePins();
  renderTools();
  renderTagFilter();
  renderOverview();
  renderUsage();
  renderBookmarks();
  renderSessions();
  renderProjects();
  renderBulk();
  if (state.view === 'backups') renderBackups();
}

function renderSidePins() {
  const pins = pinnedSessions().slice(0, 6);
  $('sidePinned').hidden = !pins.length;
  $('sidePinnedList').innerHTML = pins.map((s) => `<button type="button" class="side-pin" data-session="${esc(s.uid)}">${ICON.bookmark}<span>${esc(s.title)}</span></button>`).join('');
}

// ---------- overview ----------
function weekStats(fromMs, toMs) {
  const s = state.sessions.filter((x) => x.mtime >= fromMs && x.mtime < toMs);
  return { sessions: s.length, prompts: s.reduce((n, x) => n + x.promptCount, 0), projects: new Set(s.map((x) => x.project.key)).size };
}

function renderOverview() {
  const now = Date.now();
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  if ($('hello').getAttribute('aria-label') !== hello) { $('hello').textContent = hello; delete $('hello').dataset.split; if (motionOn()) splitWords($('hello')); }
  $('today').textContent = new Date().toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const thisW = weekStats(now - 7 * DAY, now + DAY);
  const lastW = weekStats(now - 14 * DAY, now - 7 * DAY);
  const pct = lastW.prompts ? Math.round(((thisW.prompts - lastW.prompts) / lastW.prompts) * 100) : null;
  const missing = state.projects.filter((p) => p.missing);
  const hidden = missing.reduce((n, p) => n + p.sessions.length, 0);
  const withSessions = new Set(state.projects.filter((p) => p.sessions.length && p.cwd).map((p) => p.cwd)).size;

  const stat = (num, label, delta, foot, view) => `
    <${view ? `button type="button" data-view="${view}"` : 'div'} class="stat">
      <div class="stat-top"><div class="stat-num" data-n="${num}">${num.toLocaleString()}</div><div class="stat-label">${label}</div></div>
      <div class="stat-foot">${delta}<span>${foot}</span></div>
    </${view ? 'button' : 'div'}>`;
  const chip = (txt, cls = '') => `<span class="delta ${cls}">${txt}</span>`;
  $('stats').innerHTML =
    stat(state.sessions.length, 'Chats saved', chip(`+${thisW.sessions}`, thisW.sessions ? '' : 'flat'), 'this week', 'sessions') +
    stat(thisW.prompts, 'Prompts this week',
      pct === null ? chip('new', 'flat') : chip(`${pct >= 0 ? '+' : ''}${pct}%`, pct >= 0 ? '' : 'flat'), `vs. ${lastW.prompts.toLocaleString()} last week`) +
    stat(withSessions, 'Projects', chip(`${thisW.projects}`, thisW.projects ? '' : 'flat'), 'active this week', 'projects') +
    stat(missing.length, 'Missing folders', missing.length ? chip(`${hidden}`, 'warn') : chip('OK'),
      missing.length ? 'sessions hidden' : 'all folders found', 'projects');

  const pins = pinnedSessions();
  $('pinnedBlock').hidden = !pins.length;
  $('pinned').innerHTML = pins.slice(0, 4).map((s) => sessionRow(s, '', false)).join('');

  const recent = state.sessions.filter((s) => s.promptCount > 0 && !state.pins.has(s.uid)).slice(0, 8);
  $('recent').innerHTML = recent.map((s) => sessionRow(s, '', false)).join('') ||
    emptyState('No sessions yet', 'Run <code>claude</code> in any folder and your chats will show up here.');

  // heatmap: 16 weeks ending this week, by day last used
  const counts = new Map();
  for (const s of state.sessions) {
    const d = new Date(s.mtime); d.setHours(0, 0, 0, 0);
    counts.set(d.getTime(), (counts.get(d.getTime()) || 0) + 1);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(today); end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end); start.setDate(start.getDate() - 16 * 7 + 1);
  const vals = [];
  for (let d = new Date(start), i = 0; d <= end; d.setDate(d.getDate() + 1), i++) vals.push({ t: d.getTime(), n: counts.get(d.getTime()) || 0, future: d > today, c: Math.floor(i / 7) });
  const max = Math.max(1, ...vals.map((v) => v.n));
  const level = (n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  $('heat').innerHTML = vals.map((v) => `<i data-l="${level(v.n)}" ${v.n ? `data-day="${ymd(v.t)}"` : ''} class="${v.future ? 'future' : ''}" style="--c:${v.c}" title="${new Date(v.t).toDateString()}: ${plural(v.n, 'session')}"></i>`).join('');
  const active = vals.filter((v) => v.n && !v.future).length;
  $('heat').setAttribute('aria-label', `Sessions per day over the last 16 weeks. Active on ${active} days.`);
  $('heatFoot').innerHTML = `${ICON.check}<b>${thisW.sessions}</b> <span class="muted">this week · active ${active} of the last 112 days</span>`;

  $('attention').innerHTML = missing.length
    ? missing.map((p) => `<div class="row">
        <div class="row-title">${esc(base(p.cwd))}</div>
        <div class="row-meta"><span class="mono-s">${esc(short(p.cwd))}</span></div>
        <div class="row-side"><span class="chip danger">${ICON.warn}${plural(p.sessions.length, 'session')}</span><button type="button" class="btn accent sm" data-move="${esc(p.key)}">Fix</button></div>
      </div>`).join('')
    : `<div class="good">${ICON.check}Every project folder still exists.</div>`;

  const top = state.projects.filter((p) => p.sessions.length && p.cwd).sort((a, b) => b.sessions.length - a.sessions.length).slice(0, 5);
  const most = top[0] ? top[0].sessions.length : 1;
  $('topProjects').innerHTML = top.map((p, i) => `<button type="button" class="row" data-show="${esc(p.key)}">
      <div class="row-title">${esc(projName(p))} ${toolBadge(p.source)}</div>
      <div class="row-side"><span class="muted small">${plural(p.sessions.length, 'chat')}</span></div>
      <div class="bar-mini"><span style="width:${Math.max(4, (p.sessions.length / most) * 100)}%; --i:${i}"></span></div>
    </button>`).join('');
}

// ---------- sessions ----------
function sessionRow(s, q, selectable) {
  const p = s.project;
  const match = q && !s.title.toLowerCase().includes(q) ? s.prompts.find((x) => x.toLowerCase().includes(q)) : '';
  const deep = q && !match && !s.title.toLowerCase().includes(q) ? deepHit(s, q) : null;
  const pinned = state.pins.has(s.uid);
  const inner = `
      <span class="row-title">${pinned && !selectable ? `<span class="pin-dot" title="Bookmarked chat">${ICON.bookmark}</span>` : ''}${hl(s.title, q)}</span>
      <span class="row-meta">
        ${toolBadge(s.source)}<span class="proj">${ICON.folder}${hl(projName(p), q)}</span>
        ${s.branch ? `<span class="sep">·</span><span class="proj">${ICON.branch}${esc(s.branch)}</span>` : ''}
        <span class="sep">·</span><span>${s.promptCount ? plural(s.promptCount, 'prompt') : 'empty'}</span>
        ${p.missing ? `<span class="sep">·</span><span class="danger-t">${ICON.warn}folder missing</span>` : ''}
        ${s.archived === 'only' ? `<span class="sep">·</span><span class="arch-t" title="Claude Code deleted this chat; Chatshelf kept a copy">${use('shield')}archive only</span>` : ''}
        ${s.tags.map((t) => `<span class="tag">#${hl(t, q.replace(/^#/, ''))}</span>`).join('')}
      </span>
      ${match ? `<span class="row-last">${ICON.reply}<span>“${hl(match.slice(0, 140), q)}”</span></span>`
        : deep ? `<span class="row-last deep"><b>${deep.role === 'user' ? 'You' : esc(assistantOf(s.source)[0])}:</b> <span>${hl(deep.snippet, q.split(/\s+/)[0])}</span></span>`
        : s.last ? `<span class="row-last" title="Your last prompt">${ICON.reply}<span>${esc(s.last.slice(0, 140))}</span></span>` : ''}
      <span class="row-side">${timeChip(s.mtime)}</span>`;
  if (!selectable) return `<button type="button" class="row${p.missing ? ' missing' : ''}" data-session="${esc(s.uid)}">${inner}</button>`;
  const checked = state.selected.has(s.uid);
  return `<div class="row selectable${checked ? ' is-selected' : ''}${p.missing ? ' missing' : ''}${pinned ? ' is-pinned' : ''}" data-uid="${esc(s.uid)}">
      ${s.source !== 'claude' ? '<span class="check" aria-hidden="true"></span>' : `<label class="check"><input type="checkbox" data-select="${esc(s.uid)}" ${checked ? 'checked' : ''} aria-label="Select: ${esc(s.title.slice(0, 60))}"></label>`}
      <button type="button" class="row-open" data-session="${esc(s.uid)}">${inner}</button>
      <button type="button" class="pin-btn" data-pin="${esc(s.uid)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Remove chat bookmark' : 'Bookmark chat'}: ${esc(s.title.slice(0, 60))}" title="${pinned ? 'Remove chat bookmark' : 'Bookmark chat'}">${ICON.bookmark}</button>
    </div>`;
}

function filteredSessions() {
  const q = $('q').value.trim().toLowerCase();
  const key = $('proj').value;
  const showEmpty = $('showEmpty').checked;
  const weekAgo = Date.now() - 7 * DAY;
  const range = dateBounds();
  const tag = $('tagFilter').value;
  const deepOn = deepEnabled() && state.deep.q === q && q.length >= 3;
  const pool = state.sessions.filter((s) => (!state.src || s.source === state.src) && (!key || s.project.key === key) && (!tag || s.tags.includes(tag))
    && (!range || (s.mtime >= range[0] && s.mtime < range[1])) && (!q || s.hay.includes(q) || (deepOn && state.deep.hits.has(s.uid))));
  const visible = pool.filter((s) => showEmpty || s.promptCount > 0);
  const counts = {
    all: visible.length,
    pinned: visible.filter((s) => state.pins.has(s.uid)).length,
    week: visible.filter((s) => s.mtime >= weekAgo).length,
    missing: visible.filter((s) => s.project.missing).length,
    archived: visible.filter((s) => s.archived === 'only').length,
  };
  const emptyHidden = pool.length - visible.length;
  let rows = state.sessTab === 'pinned' ? visible.filter((s) => state.pins.has(s.uid))
    : state.sessTab === 'week' ? visible.filter((s) => s.mtime >= weekAgo)
      : state.sessTab === 'missing' ? visible.filter((s) => s.project.missing)
        : state.sessTab === 'archived' ? visible.filter((s) => s.archived === 'only') : visible;
  if (state.sort === 'old') rows = rows.slice().reverse();
  if (state.sort === 'big') rows = rows.slice().sort((a, b) => b.promptCount - a.promptCount);
  return { rows, q, counts, emptyHidden };
}

// ---------- search inside replies (server side, debounced) ----------
const deepEnabled = () => localStorage.getItem('csm-deep') !== '0';
let deepTimer;
let deepSeq = 0;
function queueDeep(q) {
  if (!deepEnabled() || q.length < 3 || (state.deep.q === q && !state.deep.busy)) return;
  clearTimeout(deepTimer);
  deepTimer = setTimeout(async () => {
    const mine = ++deepSeq;
    state.deep.busy = true;
    try {
      const { hits } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=1000`);
      if (mine !== deepSeq) return;
      state.deep = { q, hits: new Map(hits.map((h) => [`${h.key}|${h.id}`, h])), busy: false };
    } catch (e) {
      if (mine !== deepSeq) return;
      state.deep = { q, hits: new Map(), busy: false };
      toast(e.message);
    }
    if ($('q').value.trim().toLowerCase() === q) renderSessions();
  }, 350);
}
const deepHit = (s, q) => (state.deep.q === q ? state.deep.hits.get(s.uid) : null);

// ---------- tags ----------
function renderTagFilter() {
  const all = [...new Set(state.sessions.flatMap((s) => s.tags))].sort();
  const cur = $('tagFilter').value;
  $('tagFilter').hidden = !all.length;
  $('tagFilter').innerHTML = '<option value="">All tags</option>' + all.map((t) => `<option value="${esc(t)}">#${esc(t)} (${state.sessions.filter((s) => s.tags.includes(t)).length})</option>`).join('');
  $('tagFilter').value = all.includes(cur) ? cur : '';
}
function renderTagEdit() {
  const s = state.detail;
  if (!s) return;
  $('tagEdit').innerHTML = `${use('tag')}` + s.tags.map((t) => `<span class="tag big">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}" title="Remove tag">${use('x')}</button></span>`).join('') +
    `<label class="tag-add"><span class="sr-only">Add a tag</span><input id="tagInput" type="text" maxlength="32" placeholder="${s.tags.length ? 'Add tag' : 'Add a tag, like bug or idea'}" list="tagList" autocomplete="off" spellcheck="false"></label>` +
    `<datalist id="tagList">${[...new Set(state.sessions.flatMap((x) => x.tags))].filter((t) => !s.tags.includes(t)).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;
}
async function setTags(s, tags) {
  try {
    const r = await api('/api/tags', { sessionId: s.id, tags });
    if (r.tags.length) state.tags[s.id] = r.tags; else delete state.tags[s.id];
    for (const x of state.sessions) if (x.id === s.id) { x.tags = r.tags; withHay(x); }
    renderTagEdit();
    renderTagFilter();
    renderSessions();
    return true;
  } catch (e) { toast(e.message); return false; }
}

// ---------- archive: keep a copy of every Claude Code chat ----------
async function loadArchive() {
  try { state.archive = await api('/api/archive'); } catch { state.archive = null; }
  renderArchive();
}
function renderArchive() {
  const a = state.archive;
  $('archivePanel').hidden = !a || !a.total && !a.only;
  if (!a) return;
  const dir = `<code>${esc(short(a.dir))}</code>`;
  if (a.auto) {
    $('archiveSub').textContent = 'On: Chatshelf keeps a copy of each Claude Code chat';
    $('archiveBody').innerHTML = `<div class="good">${use('shield')}${plural(a.kept, 'chat')} kept safe${a.only ? `, ${a.only} of them only here now` : ''}.</div>
      <p class="small muted">Claude Code removes chats after ${a.retentionDays} days without use. The copies are in ${dir}, and you can restore any of them.</p>
      <div class="arch-actions">${a.only ? '<button type="button" class="btn ghost sm" data-sesstab-go="archived">Show archived chats</button>' : ''}<button type="button" class="link small" data-archive="off">Turn off</button></div>`;
    return;
  }
  $('archiveSub').textContent = `Claude Code removes chats after ${a.retentionDays} days without use`;
  $('archiveBody').innerHTML = `${a.atRisk ? `<p class="arch-warn">${ICON.warn}<span><b>${plural(a.atRisk, 'chat')}</b> will be removed within a week.</span></p>` : ''}
    <p class="small">Keep a copy of all ${plural(a.total, 'chat')} (${size(a.totalBytes)}) in ${dir}. New and changed chats are copied each time Chatshelf looks. Claude Code's own files are never changed.</p>
    ${a.only ? `<p class="small muted">${plural(a.only, 'chat')} already only in the archive.</p>` : ''}
    <div class="arch-actions"><button type="button" class="btn accent sm" data-archive="on">${use('shield')}Keep every chat</button></div>`;
}
async function setArchive(mode, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(mode === 'run' ? '/api/archive/run' : '/api/archive/settings', mode === 'run' ? {} : { auto: mode === 'on' });
    state.archive = r;
    toast(mode === 'off' ? 'Archive turned off. Copies already made stay where they are.' : `Archive on. ${plural(r.kept, 'chat')} kept safe.`);
    await load();
  } catch (e) { toast(e.message); } finally { if (btn) btn.disabled = false; }
}

// ---------- usage ----------
const tok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const money = (c) => (c === null || c === undefined ? '—' : c < 0.01 && c > 0 ? '<$0.01' : `$${c >= 100 ? Math.round(c).toLocaleString() : c.toFixed(2)}`);
const tokensOf = (u) => (u ? u.in + u.out + u.cw + (u.cw1h || 0) + u.cr : 0);
function usageTitle(u) {
  return `Input ${tok(u.in)} · output ${tok(u.out)} · cache writes ${tok(u.cw + (u.cw1h || 0))} · cache reads ${tok(u.cr)}${u.cost !== null ? ` · about ${money(u.cost)} at API prices` : ''}`;
}
function usageSessions() {
  const days = state.urange === 'all' ? Infinity : Number(state.urange);
  const from = days === Infinity ? 0 : Date.now() - days * DAY;
  return state.sessions.filter((s) => s.usage && s.mtime >= from && (!state.utool || s.source === state.utool));
}
function renderUsage() {
  const withUsage = state.sessions.filter((s) => s.usage);
  const tools = [...new Set(withUsage.map((s) => s.source))];
  $('usageTool').innerHTML = '<option value="">All tools</option>' + tools.map((t) => `<option value="${t}">${esc(toolLabel(t))}</option>`).join('');
  $('usageTool').value = tools.includes(state.utool) ? state.utool : '';
  document.querySelectorAll('[data-urange]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.urange === state.urange)));
  const list = usageSessions();
  const sum = { in: 0, out: 0, cw: 0, cw1h: 0, cr: 0, cost: 0, priced: 0 };
  const models = new Map();
  const projects = new Map();
  for (const s of list) {
    const u = s.usage;
    for (const k of ['in', 'out', 'cw', 'cw1h', 'cr']) sum[k] += u[k] || 0;
    if (u.cost !== null) { sum.cost += u.cost; sum.priced++; }
    for (const [m, mu] of Object.entries(u.models || {})) {
      const t = models.get(m) || { in: 0, out: 0, cw: 0, cw1h: 0, cr: 0, cost: null, chats: 0 };
      for (const k of ['in', 'out', 'cw', 'cw1h', 'cr']) t[k] += mu[k] || 0;
      if (mu.cost !== null) t.cost = (t.cost || 0) + mu.cost;
      t.chats++;
      models.set(m, t);
    }
    const pr = projects.get(s.project.key) || { p: s.project, tokens: 0, cost: null, chats: 0 };
    pr.tokens += tokensOf(u);
    if (u.cost !== null) pr.cost = (pr.cost || 0) + u.cost;
    pr.chats++;
    projects.set(s.project.key, pr);
  }
  const total = tokensOf(sum);
  const stat = (num, label, foot) => `<div class="stat"><div class="stat-top"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div><div class="stat-foot"><span>${foot}</span></div></div>`;
  const inputSide = sum.in + sum.cw + sum.cw1h + sum.cr;
  $('usageStats').innerHTML = !withUsage.length ? '' :
    stat(tok(total), 'Tokens', `in ${plural(list.length, 'chat')}`) +
    stat(tok(sum.out), 'Written by the AI', 'output tokens') +
    stat(`${inputSide ? Math.round((sum.cr / inputSide) * 100) : 0}%`, 'Read from cache', 'of input, at a tenth of the price') +
    stat(sum.priced ? money(sum.cost) : '—', 'Estimated API cost', sum.priced ? `${plural(sum.priced, 'Claude chat')}, list prices` : 'no Claude chats in this period');

  if (!withUsage.length) {
    $('usageChart').innerHTML = emptyState('No token counts yet', 'Claude Code and Codex save token counts in their chat files. Other tools don\'t, so they don\'t show up here.');
    ['usageModels', 'usageProjects', 'usageTop'].forEach((id) => { $(id).innerHTML = ''; });
    return;
  }
  // Bars: per day for up to 90 days, per month for all time.
  const monthly = state.urange === 'all';
  const buckets = new Map();
  const keyOf = (ms) => { const d = new Date(ms); return monthly ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : ymd(ms); };
  for (const s of list) { const k = keyOf(s.mtime); const b = buckets.get(k) || { t: 0, c: 0, n: 0 }; b.t += tokensOf(s.usage); b.c += s.usage.cost || 0; b.n++; buckets.set(k, b); }
  const keys = [];
  if (monthly) {
    const first = list.length ? Math.min(...list.map((s) => s.mtime)) : Date.now();
    for (let d = new Date(first); d <= new Date(); d.setMonth(d.getMonth() + 1, 1)) keys.push(keyOf(d.getTime()));
  } else {
    for (let i = Number(state.urange) - 1; i >= 0; i--) keys.push(ymd(Date.now() - i * DAY));
  }
  const max = Math.max(1, ...keys.map((k) => (buckets.get(k) || { t: 0 }).t));
  const label = (k) => (monthly ? new Date(`${k}-01T00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : new Date(`${k}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  $('usageChartNote').textContent = monthly ? 'Tokens per month, by the day a chat was last active' : 'Tokens per day, by the day a chat was last active';
  $('usageChart').innerHTML = `<div class="ubar-row">${keys.map((k, i) => {
    const b = buckets.get(k) || { t: 0, c: 0, n: 0 };
    return `<span class="ubar${b.t ? '' : ' zero'}" style="--h:${Math.max(b.t ? 3 : 0, (b.t / max) * 100)}%; --i:${i}" title="${esc(label(k))}: ${tok(b.t)} tokens in ${plural(b.n, 'chat')}${b.c ? ` · about ${money(b.c)}` : ''}"${b.n && !monthly ? ` data-day="${k}"` : ''}></span>`;
  }).join('')}</div><div class="ubar-axis"><span>${esc(label(keys[0]))}</span><span>${esc(label(keys[keys.length - 1]))}</span></div>`;
  $('usageChart').setAttribute('aria-label', `${tok(total)} tokens over ${monthly ? 'all time' : `the last ${state.urange} days`}. Busiest: ${esc(label(keys.reduce((a, k) => ((buckets.get(k) || { t: 0 }).t > (buckets.get(a) || { t: 0 }).t ? k : a), keys[0])))}.`);

  const mrows = [...models].sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0) || tokensOf(b[1]) - tokensOf(a[1]));
  $('usageModels').innerHTML = `<div class="uhead"><span>Model</span><span>Chats</span><span>Input</span><span>Output</span><span>Cache write</span><span>Cache read</span><span>Est. cost</span></div>` +
    mrows.map(([m, u]) => `<div class="urow"><span class="mono-s">${esc(m)}</span><span>${u.chats}</span><span>${tok(u.in)}</span><span>${tok(u.out)}</span><span>${tok(u.cw + u.cw1h)}</span><span>${tok(u.cr)}</span><span>${money(u.cost)}</span></div>`).join('');
  const prows = [...projects.values()].sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.tokens - a.tokens).slice(0, 8);
  const pmax = Math.max(1, ...prows.map((r) => r.tokens));
  $('usageProjects').innerHTML = prows.map((r, i) => `<button type="button" class="row" data-show="${esc(r.p.key)}">
      <div class="row-title">${esc(projName(r.p))} ${toolBadge(r.p.source)}</div>
      <div class="row-side"><span class="muted small">${tok(r.tokens)} · ${money(r.cost)}</span></div>
      <div class="bar-mini"><span style="width:${Math.max(4, (r.tokens / pmax) * 100)}%; --i:${i}"></span></div>
    </button>`).join('');
  const top = list.slice().sort((a, b) => (b.usage.cost || 0) - (a.usage.cost || 0) || tokensOf(b.usage) - tokensOf(a.usage)).slice(0, 8);
  $('usageTop').innerHTML = top.map((s) => `<button type="button" class="row" data-session="${esc(s.uid)}" title="${esc(usageTitle(s.usage))}">
      <span class="row-title">${esc(s.title)}</span>
      <span class="row-meta">${toolBadge(s.source)}<span class="proj">${ICON.folder}${esc(projName(s.project))}</span><span class="sep">·</span><span>${ago(s.mtime)}</span></span>
      <span class="row-side"><span class="chip">${tok(tokensOf(s.usage))} tokens</span><b class="ucost">${money(s.usage.cost)}</b></span>
    </button>`).join('');
}

// ---------- date filter ----------
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function dateBounds() {
  const v = $('dateRange').value;
  if (!v) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  if (v === 'today') return [t0, Infinity];
  if (v === 'yesterday') return [t0 - DAY, t0];
  if (v === 'year') return [new Date(today.getFullYear(), 0, 1).getTime(), Infinity];
  if (v === 'custom') {
    const f = $('dateFrom').value;
    const t = $('dateTo').value;
    const from = f ? new Date(`${f}T00:00`).getTime() : -Infinity;
    const to = t ? new Date(`${t}T00:00`).getTime() + DAY : Infinity;
    return from > to ? [to - DAY, from + DAY] : [from, to];
  }
  return [t0 - (Number(v) - 1) * DAY, Infinity];
}
function dateLabel() {
  const v = $('dateRange').value;
  if (!v) return '';
  if (v !== 'custom') return $('dateRange').selectedOptions[0].textContent;
  const fmt = (x) => new Date(`${x}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const f = $('dateFrom').value;
  const t = $('dateTo').value;
  if (f && t) return f === t ? fmt(f) : `${fmt(f)} – ${fmt(t)}`;
  return f ? `from ${fmt(f)}` : t ? `until ${fmt(t)}` : 'any date';
}
function setDateFilter(range, from = '', to = '') {
  $('dateRange').value = range;
  $('dateFrom').value = from;
  $('dateTo').value = to;
  $('dateCustom').hidden = range !== 'custom';
  state.shown = PAGE;
  renderSessions();
}

function dayLabel(ms) {
  const d = new Date(ms); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / DAY);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function renderSessions() {
  const { rows, q, counts, emptyHidden } = filteredSessions();
  queueDeep(q);
  $('sessTabs').innerHTML = [['all', 'All'], ['pinned', 'Bookmarked'], ['missing', 'Folder missing'], ['archived', 'Archive only']]
    .filter(([k]) => k === 'all' || counts[k] || state.sessTab === k)
    .map(([k, label]) => `<button type="button" data-sesstab="${k}" aria-pressed="${state.sessTab === k}">${label} <span>${counts[k]}</span></button>`).join('');
  $('count').textContent = `Showing ${Math.min(rows.length, state.shown).toLocaleString()} of ${plural(rows.length, 'session')}` + (dateBounds() ? ` · ${dateLabel()}` : '') +
    (emptyHidden && !$('showEmpty').checked ? ` · ${emptyHidden} empty hidden` : '') +
    (state.deep.busy ? ' · searching inside replies…' : '');
  const visible = rows.slice(0, state.shown);
  $('selectAll').checked = visible.length > 0 && visible.every((s) => state.selected.has(s.uid));
  $('selectAll').indeterminate = !$('selectAll').checked && visible.some((s) => state.selected.has(s.uid));

  let html = '';
  let group = '';
  for (const s of visible) {
    if (state.sort !== 'big') {
      const g = dayLabel(s.mtime);
      if (g !== group) { group = g; html += `<h3 class="date-head eyebrow">${esc(g)}</h3>`; }
    }
    html += sessionRow(s, q, true);
  }
  const filtered = q || $('proj').value || $('tagFilter').value || state.sessTab !== 'all' || state.src || dateBounds();
  $('list').innerHTML = html || (state.sessions.length
    ? emptyState(q ? `No sessions match “${q}”` : 'Nothing here', q
      ? (deepEnabled() ? 'Try fewer words, a folder name, or part of a session ID. Search looks inside your prompts and the replies.' : 'Try fewer words. Turn on <b>Search replies</b> to also look inside the answers.')
      : 'Try another tab or project filter.', filtered ? '<button type="button" class="btn ghost" data-clear-filters>Clear filters</button>' : '')
    : emptyState('No sessions found', 'Run <code>claude</code> in a folder and come back.'));
  $('more').hidden = rows.length <= state.shown;
  $('more').textContent = `Show more (${(rows.length - state.shown).toLocaleString()} left)`;
}

function renderBulk() {
  const n = state.selected.size;
  $('bulk').hidden = n === 0 || state.view !== 'sessions';
  if (!n) return;
  const sel = state.sessions.filter((s) => state.selected.has(s.uid));
  const projects = new Set(sel.map((s) => s.project.key)).size;
  $('bulkCount').textContent = plural(n, 'session');
  $('bulkMeta').textContent = `selected · from ${plural(projects, 'project')} · ${size(sel.reduce((a, s) => a + s.size, 0))}`;
  $('bulkGoLabel').textContent = `Move ${plural(n, 'session')}`;
}

// ---------- projects ----------
function renderProjects() {
  const all = claudeProjects();
  const missing = all.filter((p) => p.missing);
  const ok = all.filter((p) => p.exists);
  const other = all.filter((p) => !p.missing && !p.exists);
  const cells = all.slice().sort((a, b) => Number(a.missing) - Number(b.missing) || Number(b.exists) - Number(a.exists))
    .map((p, i) => `<i class="${p.missing ? 'm' : p.exists ? 'o' : 'u'}" style="--i:${i}" title="${esc(short(p.cwd) || p.key)}"></i>`).join('');
  $('projSummary').innerHTML = `
    <div class="sum-main">
      <p class="eyebrow">Projects · storage</p>
      <div class="sum-num"><span>${plural(all.length, 'project')}</span><span class="muted small">${size(all.reduce((n, p) => n + p.bytes, 0))} of sessions</span></div>
      <div class="segbar" role="img" aria-label="${ok.length} found, ${other.length} memory only, ${missing.length} missing">${cells}</div>
      <div class="legend">
        <span><i class="o"></i>${ok.length} folder found</span>
        <span><i class="u"></i>${other.length} memory only</span>
        <span><i class="m"></i>${missing.length} folder missing <span class="muted">${plural(missing.reduce((n, p) => n + p.sessions.length, 0), 'session')}</span></span>
      </div>
    </div>
    <div class="sum-side">
      <p class="eyebrow">Why sessions vanish</p>
      <p class="small">Claude stores chats under the folder's path. Rename <code>app</code> to <code>app-v2</code> and the chats stay filed under <code>app</code>.</p>
    </div>`;

  $('projTabs').innerHTML = [['all', 'All', all.length], ['missing', 'Needs you', missing.length], ['ok', 'Healthy', ok.length]]
    .map(([k, label, n]) => `<button type="button" data-projtab="${k}" aria-pressed="${state.projTab === k}">${label} <span>${n}</span></button>`).join('');

  const maxBytes = Math.max(1, ...all.map((p) => p.bytes));
  const row = (p) => `
    <div class="tr${p.missing ? ' missing' : ''}">
      <div class="td-folder">
        <span class="ficon ${p.missing ? 'm' : p.exists ? 'o' : 'u'}">${p.missing ? ICON.warn : ICON.folder}</span>
        <div class="min0"><div class="row-title">${esc(base(p.cwd) || p.key)}</div><div class="mono-s">${esc(short(p.cwd) || 'no sessions, memory only')}</div></div>
      </div>
      <div class="td-num">${p.sessions.length}</div>
      <div class="td-date">${p.updated ? ago(p.updated) : '—'}</div>
      <div class="td-bar"><span class="meter"><span style="width:${Math.max(2, (p.bytes / maxBytes) * 100)}%"></span></span><span class="small muted">${p.bytes ? size(p.bytes) : '—'}</span></div>
      <div class="td-status">${p.missing ? `<span class="chip danger">${ICON.warn}Folder missing</span>` : p.exists ? `<span class="chip ok">${ICON.check}Found</span>` : '<span class="chip">Memory only</span>'}</div>
      <div class="td-act">
        ${p.sessions.length ? `<button type="button" class="btn ghost sm" data-show="${esc(p.key)}">Sessions</button>` : ''}
        <button type="button" class="btn ${p.missing ? 'accent' : 'ghost'} sm" data-move="${esc(p.key)}">${p.missing ? 'Fix' : 'Move'}</button>
      </div>
    </div>`;
  const group = (label, note, list) => (list.length
    ? `<div class="group-head"><span class="eyebrow">${label} · ${list.length}</span><span class="muted small">${note}</span></div>${list.map(row).join('')}`
    : '');
  const t = state.projTab;
  $('projects').innerHTML = `
    <div class="thead"><span>Folder</span><span>Sessions</span><span>Last used</span><span>Storage</span><span>Status</span><span></span></div>
    ${t !== 'ok' ? group('Needs you', 'Folder renamed or deleted: move its sessions to the new folder', missing) : ''}
    ${t !== 'missing' ? group('Healthy', 'Folder exists: claude --resume finds these', ok) : ''}
    ${t === 'all' ? group('Memory only', 'No sessions left, only project memory', other) : ''}
    ${t === 'missing' && !missing.length ? `<div class="good pad">${ICON.check}Nothing needs you. Every project folder still exists.</div>` : ''}`;
}

// ---------- backups ----------
async function renderBackups() {
  $('backups').innerHTML = '<div class="row skel"><span class="sk" style="width:40%"></span><span class="sk" style="width:60%"></span></div>';
  try {
    const { backups } = await api('/api/backups');
    $('backups').innerHTML = backups.map((b) => `
      <div class="row">
        <div class="row-title">${esc(base(b.from) || b.key)}${b.to ? ` <span class="muted">→</span> ${esc(base(b.to))}` : ''}</div>
        <div class="row-meta"><span>${date(Date.parse(b.at))}</span><span class="sep">·</span><span>${plural(b.sessions, 'session')}</span><span class="sep">·</span><span class="mono-s">${esc(short(b.from))}${b.to ? ` → ${esc(short(b.to))}` : ''}</span></div>
        <div class="row-side"><button type="button" class="btn ghost sm" data-restore="${esc(b.name)}">Restore</button></div>
      </div>`).join('') || emptyState('No backups yet', 'A backup is saved automatically before every move, so you can always put things back.');
    if (state.view === 'backups') stagger($('backups'));
  } catch (e) {
    $('backups').innerHTML = emptyState('Could not load backups', esc(e.message));
  }
}

// ---------- markdown (escape first, then add a small safe subset) ----------
function inline(s) {
  const codes = [];
  let t = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}
const indentOf = (l) => l.match(/^\s*/)[0].length;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
function codeBlock(code, lang) {
  return `<div class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button type="button" data-copycode><span>Copy</span></button></div><pre><code>${esc(code)}</code></pre></div>`;
}
function parseList(lines, i) {
  const baseIndent = indentOf(lines[i]);
  const ordered = /^\s*\d/.test(lines[i]);
  const items = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(ITEM);
    const ind = indentOf(l);
    const cur = items[items.length - 1];
    if (m && ind === baseIndent) { items.push([m[3]]); i++; continue; }
    if (!l.trim()) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.trim() && (indentOf(nx) > baseIndent || (ITEM.test(nx) && indentOf(nx) === baseIndent))) { cur.push(''); i++; continue; }
      break;
    }
    if (ind > baseIndent) { cur.push(l.slice(Math.min(ind, baseIndent + 2))); i++; continue; }
    if (cur[cur.length - 1] !== '' && !/^\s*(#|```|~~~|>|\|)/.test(l)) { cur.push(l.trim()); i++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map((it) => `<li>${md(it.join('\n'))}</li>`).join('')}</${tag}>`, i };
}
function md(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let out = '';
  let para = [];
  const flush = () => { if (para.length) { out += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const ind = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !/^\s*(```+|~~~+)\s*$/.test(lines[i])) { body.push(lines[i].slice(Math.min(ind, indentOf(lines[i])))); i++; }
      i++;
      out += codeBlock(body.join('\n'), fence[2]);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/))) { flush(); out += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { flush(); out += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out += `<blockquote>${md(q.join('\n'))}</blockquote>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    if (ITEM.test(line)) { flush(); const r = parseList(lines, i); out += r.html; i = r.i; continue; }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

// ---------- session detail ----------
const timeOf = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function renderMsg(m, idx) {
  const user = m.role === 'user';
  const long = m.text.length > 1800 || (m.text.match(/\n/g) || []).length > 32;
  const tools = m.tools.slice(0, 12);
  const sid = state.detail ? state.detail.id : '';
  const srcNow = state.detail ? state.detail.source : 'claude';
  const uuids = m.uuids && m.uuids.length ? m.uuids : (m.uuid ? [m.uuid] : []);
  const bm = m.uuid && sid ? state.bmIndex.get(`${sid}|${m.uuid}`) : null;
  const ext = sid ? uuids.map((u) => state.extIndex.get(`${sid}|${u}`)).find(Boolean) : null;
  return `<article class="msg ${m.role}${bm || ext ? ' is-bm' : ''}" data-i="${idx}" data-uuid="${esc(m.uuid || '')}" data-uuids="${esc(uuids.join(' '))}">
    <div class="avatar${user ? '' : ` s-${esc(srcNow)}`}" aria-hidden="true">${user ? 'Y' : esc(assistantOf(srcNow)[1])}</div>
    <div class="min0">
      <div class="msg-head"><b>${user ? 'You' : esc(assistantOf(srcNow)[0])}</b>${m.ts ? `<span class="time">${timeOf(m.ts)}</span>` : ''}${ext ? `<span class="src-badge" title="Bookmarked with the ${esc(ext.source)} extension">${ICON.bookmark}${esc(ext.source)}</span>` : ''}<span class="msg-actions">${m.uuid ? `<button type="button" class="msg-bm" data-bm="${idx}" aria-pressed="${Boolean(bm)}" aria-label="${bm ? 'Remove bookmark' : 'Bookmark this message'}" title="${bm ? 'Remove bookmark' : 'Bookmark this message'}">${ICON.bookmark}</button>` : ''}${m.text ? `<button type="button" class="msg-copy" data-copymsg="${idx}"><span>Copy</span></button>` : ''}</span></div>
      ${m.text ? `<div class="bubble"><div class="md${long ? ' clamp' : ''}">${md(m.text)}</div>${long ? '<button type="button" class="more-btn" data-more>Show more</button>' : ''}</div>` : ''}
      ${bm ? `<label class="bm-note">${ICON.bookmark}<span class="sr-only">Bookmark note</span><input type="text" data-bmnote="${esc(bm.id)}" value="${esc(bm.note || '')}" placeholder="Add a note to this bookmark…" maxlength="500"></label>` : ''}
      ${tools.length ? `<div class="tools-row">${tools.map((t) => `<span class="tool"><b>${esc(t.name || t)}</b>${t.detail ? ' ' + esc(t.detail) : ''}</span>`).join('')}${m.tools.length > 12 ? `<span class="tool">+${m.tools.length - 12} more</span>` : ''}</div>` : ''}
    </div>
  </article>`;
}

function syncPinButton() {
  const on = Boolean(state.detail && state.pins.has(state.detail.uid));
  $('detailPin').setAttribute('aria-pressed', String(on));
  $('detailPin').setAttribute('aria-label', on ? 'Remove chat bookmark' : 'Bookmark this chat');
  $('detailPin').title = on ? 'Remove chat bookmark' : 'Bookmark this chat';
}

async function openDetail(uid, focusUuid = '', findText = '') {
  const s = state.byUid.get(uid) || state.sessions.find((x) => x.id === String(uid).split('|').pop());
  if (!s) return;
  const p = s.project;
  state.detail = s;
  state.msgs = [];
  state.focusMsg = focusUuid;
  renderMarks();
  $('detailProject').textContent = `${toolLabel(s.source)} · ${short(p.cwd) || 'no project folder'}`;
  $('detailTitle').textContent = s.title;
  $('detailMeta').innerHTML = [
    p.missing ? `<span class="chip danger">${ICON.warn}folder missing</span>` : '',
    `<span class="chip">${ICON.clock}${date(s.mtime)}</span>`,
    s.branch ? `<span class="chip">${ICON.branch}${esc(s.branch)}</span>` : '',
    toolBadge(s.source),
    `<span class="chip">${plural(s.promptCount, 'prompt')}</span>`,
    `<span class="chip">${size(s.size)}</span>`,
    s.usage ? `<span class="chip" title="${esc(usageTitle(s.usage))}">${use('chart')}${tok(tokensOf(s.usage))} tokens${s.usage.cost !== null ? ` · ~${money(s.usage.cost)}` : ''}</span>` : '',
    s.archived === 'only' ? `<span class="chip arch">${use('shield')}archive only</span>` : s.archived === 'kept' ? `<span class="chip ok" title="Chatshelf keeps a copy of this chat">${use('shield')}kept</span>` : '',
    `<span class="chip mono-s">${esc(s.id)}</span>`,
  ].join('');
  renderTagEdit();
  const files = s.files || [];
  $('filesBox').hidden = !files.length;
  $('filesBox').open = false;
  $('filesSum').textContent = `Files changed (${files.length})`;
  const rel = (f) => (p.cwd && f.startsWith(p.cwd + '/') ? f.slice(p.cwd.length + 1) : short(f));
  $('filesList').innerHTML = files.map((f) => `<button type="button" class="file-btn" data-file="${esc(f)}" title="Show every chat that changed ${esc(short(f))}">${use('file')}<span>${esc(rel(f))}</span></button>`).join('');
  const ri = resumeInfo(s);
  $('resumeLabel').textContent = ri.label;
  $('detailCmd').textContent = ri.cmd;
  $('detailCmd').hidden = !ri.cmd;
  $('detailOpenLabel').textContent = ri.open;
  $('detailOpen').disabled = ri.kind === 'none' || (ri.kind === 'url' ? !ri.url : !p.exists);
  $('detailOpen').title = ri.kind === 'url' ? 'Opens the chat in your browser' : p.exists ? 'Opens the project folder' : (s.source === 'claude' ? 'Move this session to the new folder first' : 'This chat has no project folder on this computer');
  $('detailOpen').querySelector('use').setAttribute('href', ri.kind === 'url' ? '#i-link' : ri.kind === 'app' ? '#i-folder' : '#i-terminal');
  $('resumeNote').hidden = !ri.note;
  $('resumeNote').textContent = ri.note || '';
  $('detailMove').hidden = s.source !== 'claude' || s.archived === 'only';
  $('detailCopy').hidden = !ri.cmd;
  if (s.archived === 'only') {
    $('resumeLabel').textContent = 'Only in Chatshelf\'s archive';
    $('detailCmd').hidden = true;
    $('detailCopy').hidden = true;
    $('detailOpenLabel').textContent = 'Restore to Claude Code';
    $('detailOpen').disabled = false;
    $('detailOpen').title = 'Copies the chat back so claude --resume finds it';
    $('detailOpen').querySelector('use').setAttribute('href', '#i-shield');
    $('resumeNote').hidden = false;
    $('resumeNote').textContent = 'Claude Code removed this chat. Restoring copies it back into Claude Code\'s folder, so you can resume it there.';
  }
  syncPinButton();
  $('find').value = '';
  $('findCount').textContent = '';
  setWho('all');
  $('transcript').innerHTML = [30, 80, 55, 70].map((w, i) => `<div class="msg skel"><span class="avatar sk"></span><div><span class="sk" style="width:${w}%"></span><span class="sk" style="width:${[60, 90, 40, 85][i]}%"></span></div></div>`).join('');
  $('transcript').setAttribute('aria-busy', 'true');
  if (!$('detail').open) $('detail').showModal();
  history.replaceState(null, '', `#s=${encodeURIComponent(s.uid)}`);
  $('transcript').scrollTop = 0;
  try {
    const { messages } = await api(`/api/session?key=${encodeURIComponent(p.key)}&id=${encodeURIComponent(s.id)}`);
    if (state.detail !== s) return;
    state.msgs = messages;
    $('transcript').innerHTML = messages.map(renderMsg).join('') || emptyState('No readable messages', 'This session has no text messages, only tool activity.');
    renderMarks();
    if (findText) { $('find').value = findText; findInConvo(findText); }
    else if (state.focusMsg) { scrollToMsg(state.focusMsg); state.focusMsg = ''; } else stagger($('transcript'), ':scope > .msg', 8);
  } catch (e) {
    $('transcript').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  } finally {
    $('transcript').removeAttribute('aria-busy');
  }
}

function expandClamp(c) {
  c.classList.remove('clamp');
  const b = c.parentElement.querySelector('[data-more]');
  if (b) b.remove();
}
function setWho(who) {
  document.querySelectorAll('[data-who]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.who === who)));
  document.querySelectorAll('#transcript .msg').forEach((m) => m.classList.toggle('dim', (who === 'user' && m.classList.contains('assistant')) || (who === 'bm' && !m.classList.contains('is-bm'))));
}
function clearHits() {
  const t = $('transcript');
  t.querySelectorAll('mark.hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
  t.normalize();
  state.hits = [];
}
function findInConvo(q) {
  clearHits();
  if (!q) { $('findCount').textContent = ''; return; }
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker($('transcript'), NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.md, .tools-row') && !n.parentElement.closest('.msg.dim') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const t = n.nodeValue;
    const low = t.toLowerCase();
    let i = low.indexOf(ql);
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i >= 0) {
      frag.append(t.slice(last, i));
      const mk = document.createElement('mark');
      mk.className = 'hit';
      mk.textContent = t.slice(i, i + q.length);
      frag.append(mk);
      state.hits.push(mk);
      last = i + q.length;
      i = low.indexOf(ql, last);
    }
    frag.append(t.slice(last));
    n.replaceWith(frag);
  }
  if (!state.hits.length) { $('findCount').textContent = 'No matches'; return; }
  focusHit(0);
}
function focusHit(i) {
  if (!state.hits.length) return;
  state.hits.forEach((h) => h.classList.remove('cur'));
  state.hitIdx = (i + state.hits.length) % state.hits.length;
  const h = state.hits[state.hitIdx];
  h.classList.add('cur');
  const c = h.closest('.clamp');
  if (c) expandClamp(c);
  h.scrollIntoView({ block: 'center', behavior: motionOn() ? 'smooth' : 'auto' });
  $('findCount').textContent = `${state.hitIdx + 1} / ${state.hits.length}`;
}

async function openTerminal() {
  const s = state.detail;
  if (!s) return;
  const b = $('detailOpen');
  b.disabled = true;
  try {
    if (s.archived === 'only') {
      await api('/api/archive/restore', { key: s.project.key, id: s.id });
      toast('Restored. claude --resume can find this chat again.');
      await load();
      openDetail(s.uid);
      return;
    }
    const ri = resumeInfo(s);
    if (ri.kind === 'url') { openUrl(ri.url); return; }
    const r = await api('/api/open-terminal', { key: s.project.key, id: s.id });
    toast(r.app ? `Opened the project in ${r.terminal}.` : `Opened in ${r.terminal}.`);
  } catch (e) {
    toast(e.message);
  } finally {
    const ri = resumeInfo(s);
    if (s.archived !== 'only') b.disabled = ri.kind === 'url' ? !ri.url : !s.project.exists;
    else b.disabled = false;
  }
}

// ---------- tools: filter chips, overview panel, sources dialog, import ----------
function toolCounts() {
  const c = {};
  for (const s of state.sessions) c[s.source] = (c[s.source] || 0) + 1;
  return c;
}
function renderTools() {
  const c = toolCounts();
  const ids = Object.keys(TOOLS).filter((id) => c[id]);
  $('srcTabs').hidden = ids.length < 2;
  $('srcTabs').innerHTML = [`<button type="button" data-src="" aria-pressed="${!state.src}">All tools <span>${state.sessions.length.toLocaleString()}</span></button>`,
    ...ids.map((id) => `<button type="button" data-src="${id}" aria-pressed="${state.src === id}"><i class="dot s-${id}"></i>${esc(toolLabel(id))} <span>${c[id].toLocaleString()}</span></button>`)].join('');
  $('toolCount').textContent = ids.length ? ids.length : '';
  $('toolPanel').hidden = ids.length < 2;
  const max = Math.max(1, ...ids.map((id) => c[id]));
  $('toolBars').innerHTML = ids.sort((a, b) => c[b] - c[a]).map((id, i) => `<button type="button" class="row" data-src="${id}">
      <div class="row-title"><i class="dot s-${id}"></i>${esc(toolLabel(id))}</div>
      <div class="row-side"><span class="muted small">${plural(c[id], 'chat')}</span></div>
      <div class="bar-mini"><span class="s-${id}" style="width:${Math.max(4, (c[id] / max) * 100)}%; --i:${i}"></span></div>
    </button>`).join('');
}

async function openSources() {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('importMsg').textContent = '';
  $('srcList').innerHTML = '<div class="row skel"><span class="sk" style="width:50%"></span><span class="sk" style="width:70%"></span></div>';
  $('sources').showModal();
  try {
    const { sources } = await api('/api/sources');
    state.sources = sources;
    $('srcList').innerHTML = sources.map((t) => `<div class="src-row${t.found ? '' : ' off'}">
        <i class="dot s-${esc(t.id)}"></i>
        <div class="min0">
          <div class="src-name">${esc(t.label)}${t.experimental ? ' <span class="chip">experimental</span>' : ''}${t.imported ? ' <span class="chip">import</span>' : ''}</div>
          <div class="mono-s">${esc(short(t.path || ''))}</div>
          ${t.note ? `<div class="small error">${esc(t.note)}</div>` : ''}
          ${t.imported && t.found ? `<div class="small muted">Imported ${esc(date(Date.parse(t.importedAt)))}${t.file ? ` from ${esc(t.file)}` : ''}</div>` : ''}
        </div>
        <div class="src-state">${t.found ? `<span class="chip ok">${ICON.check}${plural(t.count, 'chat')}</span>` : `<span class="chip">${t.imported ? 'Not imported' : 'Not found'}</span>`}
          ${t.imported && t.found ? `<button type="button" class="btn ghost sm" data-rmimport="${esc(t.id)}">Remove</button>` : ''}</div>
      </div>`).join('');
  } catch (e) {
    $('srcList').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

async function uploadExport(file) {
  if (!file) return;
  $('importMsg').className = 'small';
  $('importMsg').textContent = `Reading ${file.name} (${size(file.size)})…`;
  $('drop').classList.add('busy');
  try {
    let data;
    if (vsc) data = await host('api', { method: 'POST', path: '/api/import', file: await file.arrayBuffer(), filename: file.name });
    else {
      const res = await fetch('/api/import', { method: 'POST', headers: { 'X-Token': window.CSM_TOKEN, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name).slice(0, 200) }, body: file });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
    }
    $('importMsg').className = 'small ok-t';
    $('importMsg').textContent = `Imported ${plural(data.total, 'chat')} from ${data.label}: ${data.added} new, ${data.updated} updated.`;
    await load();
    await openSourcesListOnly();
  } catch (e) {
    $('importMsg').className = 'small error';
    $('importMsg').textContent = e.message;
  } finally {
    $('drop').classList.remove('busy');
    $('importFile').value = '';
  }
}
async function openSourcesListOnly() { if ($('sources').open) { const msg = $('importMsg').textContent; const cls = $('importMsg').className; await openSources(); $('importMsg').textContent = msg; $('importMsg').className = cls; } }
async function removeImport(source) {
  try {
    await api('/api/imports/delete', { source });
    toast(`Removed the ${toolLabel(source)} import`);
    await load();
    await openSourcesListOnly();
  } catch (e) { toast(e.message); }
}

// ---------- bookmarks ----------
function setExternal(list) {
  state.external = (list || []).filter((b) => b && b.sessionId && b.msgUuid);
  state.extIndex = new Map(state.external.map((b) => [`${b.sessionId}|${b.msgUuid}`, b]));
}
// Message bookmarks from both places (ours + the VS Code extension's), newest first.
const msgMarks = () => [...state.bookmarks, ...state.external].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const allMarks = () => [...state.bookmarks, ...state.chatMarks.values()];
function setBookmarks(list) {
  const sorted = (list || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  state.chatMarks = new Map(sorted.filter((b) => b.kind === 'chat').map((b) => [b.sessionId, b]));
  state.bookmarks = sorted.filter((b) => b.kind !== 'chat');
  if (state.sessions.length) computePins();
  state.bmIndex = new Map(state.bookmarks.map((b) => [`${b.sessionId}|${b.msgUuid}`, b]));
}
const sessionById = (id) => state.sessions.find((s) => s.id === id);
const stripMd = (t) => String(t || '')
  .replace(/```[\w+#.-]*\n?([\s\S]*?)```/g, '$1')
  .replace(/^\s{0,3}#{1,4}\s+/gm, '')
  .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\|?(\s*:?-{3,}:?\s*\|)+/g, ' ')
  .replace(/\s*\|\s*/g, ' · ')
  .replace(/(\s*·\s*)+/g, ' · ')
  .replace(/^\s*·\s*|\s*·\s*$/gm, '');
const bmSnippet = (m) => (stripMd(m.text) || (m.tools || []).map((t) => `${t.name || t}${t.detail ? ' ' + t.detail : ''}`).join(' · ')).replace(/\s+/g, ' ').trim();

async function toggleBookmark(idx) {
  const s = state.detail;
  const m = state.msgs[idx];
  if (!s || !m || !m.uuid) return;
  const key = `${s.id}|${m.uuid}`;
  const existing = state.bmIndex.get(key);
  try {
    if (existing) {
      await api('/api/bookmarks/delete', { id: existing.id });
      setBookmarks(allMarks().filter((b) => b.id !== existing.id));
      toast('Bookmark removed');
    } else {
      const { bookmark } = await api('/api/bookmarks', {
        sessionId: s.id, msgUuid: m.uuid, role: m.role, text: bmSnippet(m).slice(0, 600), ts: m.ts, title: s.title, cwd: s.project.cwd, note: '',
      });
      setBookmarks([bookmark, ...allMarks()]);
      toast('Bookmarked. Add a note under the message if you like.');
    }
  } catch (e) { toast(e.message); return; }
  const art = document.querySelector(`#transcript .msg[data-i="${idx}"]`);
  if (art) {
    art.outerHTML = renderMsg(m, idx);
    const fresh = document.querySelector(`#transcript .msg[data-i="${idx}"]`);
    if (!existing && fresh) { replay(fresh, 'flash'); const inp = fresh.querySelector('[data-bmnote]'); if (inp) inp.focus({ preventScroll: true }); }
  }
  renderMarks();
  renderBookmarks();
}

async function saveNote(input) {
  const b = allMarks().find((x) => x.id === input.dataset.bmnote);
  if (!b || (b.note || '') === input.value.trim()) return;
  try {
    const { bookmark } = await api('/api/bookmarks', { ...b, note: input.value.trim() });
    Object.assign(b, bookmark);
    input.closest('.bm-note, .bm-item')?.classList.add('saved');
    setTimeout(() => input.closest('.bm-note, .bm-item')?.classList.remove('saved'), 1200);
    renderMarks();
    if (state.view !== 'bookmarks') renderBookmarks();
    else document.querySelectorAll(`[data-bmnote="${CSS.escape(b.id)}"]`).forEach((el) => { if (el !== input) el.value = b.note; });
  } catch (e) { toast(e.message); }
}

async function removeBookmark(id) {
  try {
    await api('/api/bookmarks/delete', { id });
    const wasChat = [...state.chatMarks.values()].some((b) => b.id === id);
    setBookmarks(allMarks().filter((b) => b.id !== id));
    toast('Bookmark removed');
    if (wasChat) { computePins(); renderAll(); if (state.detail) syncPinButton(); } else renderBookmarks();
    if (state.detail) { renderMarks(); $('transcript').querySelectorAll('.msg.is-bm').forEach((el) => { const i = Number(el.dataset.i); if (!state.bmIndex.get(`${state.detail.id}|${el.dataset.uuid}`)) el.outerHTML = renderMsg(state.msgs[i], i); }); }
  } catch (e) { toast(e.message); }
}

function scrollToMsg(uuid) {
  const el = [...document.querySelectorAll('#transcript .msg')].find((x) => (x.dataset.uuids || '').split(' ').includes(uuid));
  if (!el) { toast('That message is no longer in this session.'); return; }
  const c = el.querySelector('.clamp');
  if (c) expandClamp(c);
  el.classList.remove('dim');
  el.scrollIntoView({ block: 'center', behavior: motionOn() ? 'smooth' : 'auto' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function renderMarks() {
  const s = state.detail;
  const marks = s ? msgMarks().filter((b) => b.sessionId === s.id) : [];
  $('detailMarks').hidden = !marks.length;
  const order = new Map(state.msgs.flatMap((m, i) => (m.uuids || [m.uuid]).map((u) => [u, i])));
  marks.sort((a, b) => (order.get(a.msgUuid) ?? 1e9) - (order.get(b.msgUuid) ?? 1e9));
  $('detailMarks').innerHTML = marks.length
    ? `<span class="eyebrow">${ICON.bookmark}${marks.length}</span>` + marks.map((b) => `<button type="button" class="mark-chip" data-jump="${esc(b.msgUuid)}" title="${esc(stripMd(b.text))}${b.readOnly ? ` (bookmarked in ${esc(b.source)})` : ''}">${b.readOnly ? `<span class="chip-src">${esc(b.source)}</span>` : ''}${esc((b.note || stripMd(b.text) || 'Bookmarked message').slice(0, 48))}</button>`).join('')
    : '';
}

function bmItem(b, q) {
  const bmSrc = (sessionById(b.sessionId) || { source: 'claude' }).source;
  const user = b.role === 'user';
  return `<div class="bm-item" data-bmid="${esc(b.id)}">
      <div class="avatar sm ${user ? 'u' : 'a'}" aria-hidden="true">${user ? 'Y' : esc(assistantOf(bmSrc)[1])}</div>
      <div class="min0">
        <div class="bm-meta"><b>${user ? 'You' : esc(assistantOf(bmSrc)[0])}</b>${b.ts ? `<span>${timeOf(b.ts)}</span>` : ''}${b.readOnly ? `<span class="src-badge">${ICON.bookmark}${esc(b.source)}</span>` : ''}</div>
        <p class="bm-text">${b.text ? hl(stripMd(b.text).replace(/\s+/g, ' '), q) : '<span class="muted">This message is no longer in the session file.</span>'}</p>
        ${b.readOnly
          ? `<p class="src-note">Bookmarked in ${esc(b.source)}. To remove it, use the bookmark button under the reply there.</p>`
          : `<label class="bm-note inline"><span class="sr-only">Note</span><input type="text" data-bmnote="${esc(b.id)}" value="${esc(b.note || '')}" placeholder="Add a note…" maxlength="500"></label>`}
      </div>
      <div class="bm-actions">
        <button type="button" class="btn ghost sm" data-bmopen="${esc(b.id)}">Open${use('arrow')}</button>
        ${b.readOnly ? '' : `<button type="button" class="btn ghost icon sm" data-bmdel="${esc(b.id)}" aria-label="Remove bookmark">${use('trash')}</button>`}
      </div>
    </div>`;
}

function chatItem(b, q) {
  const s = sessionById(b.sessionId);
  return `<div class="bm-item chat" data-bmid="${esc(b.id)}">
      <div class="avatar sm c" aria-hidden="true">${ICON.bookmark}</div>
      <div class="min0">
        <div class="bm-meta"><b>${hl(s ? s.title : b.title, q)}</b><span>${esc(base(s ? s.project.cwd : b.cwd))}${s ? ` · ${ago(s.mtime)} · ${plural(s.promptCount, 'prompt')}` : ' · session not found'}</span></div>
        ${s && s.last ? `<p class="bm-text">${ICON.reply} ${esc(s.last)}</p>` : ''}
        <label class="bm-note inline"><span class="sr-only">Note</span><input type="text" data-bmnote="${esc(b.id)}" value="${esc(b.note || '')}" placeholder="Why is this chat worth keeping?" maxlength="500"></label>
      </div>
      <div class="bm-actions">
        ${s ? `<button type="button" class="btn ghost sm" data-session="${esc(s.uid)}">Open${use('arrow')}</button>` : ''}
        <button type="button" class="btn ghost icon sm" data-bmdel="${esc(b.id)}" aria-label="Remove chat bookmark">${use('trash')}</button>
      </div>
    </div>`;
}

function renderBookmarks() {
  const chats = [...state.chatMarks.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const allMsg = msgMarks();
  const n = allMsg.length + chats.length;
  $('navBookmarks').textContent = n ? n : '';
  // overview panel
  $('bmPanel').hidden = !n;
  $('bmRecent').innerHTML = allMsg.slice(0, 4).map((b) => `<button type="button" class="row" data-bmopen="${esc(b.id)}">
      <div class="row-title">${esc((b.note || stripMd(b.text)).slice(0, 90))}</div>
      <div class="row-meta"><span>${esc((b.title || (sessionById(b.sessionId) || {}).title || '').slice(0, 50))}</span>${b.readOnly ? `<span class="sep">·</span><span>${esc(b.source)}</span>` : ''}</div>
    </button>`).join('');
  // page
  const q = $('bmQ').value.trim().toLowerCase();
  const list = allMsg.filter((b) => { const x = sessionById(b.sessionId); return !q || [b.text, b.note, b.title || (x ? x.title : ''), b.cwd, b.source].join('\n').toLowerCase().includes(q); });
  const chatList = chats.filter((b) => { const s = sessionById(b.sessionId); return !q || [s ? s.title : b.title, b.note, b.cwd, s ? s.last : ''].join('\n').toLowerCase().includes(q); });
  $('bmTabs').innerHTML = [['all', 'All', chatList.length + list.length], ['chats', 'Chats', chatList.length], ['messages', 'Messages', list.length]]
    .map(([k, label, c]) => `<button type="button" data-bmtab="${k}" aria-pressed="${state.bmTab === k}">${label} <span>${c}</span></button>`).join('');
  $('bmCount').textContent = n ? `${plural(chats.length, 'chat')} and ${plural(allMsg.length, 'message')} saved${state.external.length ? ` (${state.external.length} from VS Code)` : ''}. Notes save when you leave the field.` : 'Chats and messages you saved, with your notes.';
  if (!n) {
    $('bmList').innerHTML = emptyState('No bookmarks yet', `Bookmark a whole chat with ${ICON.bookmark} at the top of a conversation (or press <kbd>b</kbd> on a row), or bookmark a single message by hovering over it.`, '<button type="button" class="btn ghost" data-view="sessions">Browse sessions</button>');
    return;
  }
  const showChats = state.bmTab !== 'messages';
  const showMsgs = state.bmTab !== 'chats';
  if ((!showChats || !chatList.length) && (!showMsgs || !list.length)) {
    $('bmList').innerHTML = emptyState(q ? `No bookmarks match “${q}”` : 'Nothing in this tab yet', q ? 'Search looks at chat titles, messages and your notes.' : (state.bmTab === 'chats' ? 'Open a chat and click the bookmark icon at the top.' : 'Hover over a message in a chat and click its bookmark icon.'));
    return;
  }
  const chatHtml = showChats && chatList.length ? `<section class="bm-group"><header class="bm-head"><div><p class="eyebrow">Chats · ${chatList.length}</p></div></header>${chatList.map((b) => chatItem(b, q)).join('')}</section>` : '';
  const msgHead = showMsgs && list.length && state.bmTab === 'all' ? `<p class="eyebrow bm-sep">Messages · ${list.length}</p>` : '';
  if (!showMsgs || !list.length) { $('bmList').innerHTML = chatHtml; return; }
  const groups = new Map();
  for (const b of list) { if (!groups.has(b.sessionId)) groups.set(b.sessionId, []); groups.get(b.sessionId).push(b); }
  $('bmList').innerHTML = chatHtml + msgHead + [...groups].map(([sid, items]) => {
    const s = sessionById(sid);
    const title = s ? s.title : items[0].title;
    const cwd = s ? s.project.cwd : items[0].cwd;
    return `<section class="bm-group">
      <header class="bm-head">
        <div class="min0"><h2>${state.chatMarks.has(sid) ? `<span class="pin-dot" title="Chat bookmarked">${ICON.bookmark}</span>` : ''}${hl(title, q)}</h2><p class="mono-s">${esc(short(cwd))}${s ? '' : ' · session not found'}</p></div>
        ${s ? `<button type="button" class="link" data-session="${esc(s.uid)}">Open chat</button>` : ''}
      </header>
      ${items.map((b) => bmItem(b, q)).join('')}
    </section>`;
  }).join('');
}

function openBookmark(id) {
  const b = msgMarks().find((x) => x.id === id);
  if (!b) return;
  const s = sessionById(b.sessionId);
  if (!s) { toast('That session no longer exists. You can remove the bookmark.'); return; }
  openDetail(s.uid, b.msgUuid);
}

// ---------- handoff: continue a chat in another tool ----------
const HO_OPTIONS = [
  { id: 'codex', label: 'Codex', sub: 'Opens a terminal and starts codex', kind: 'terminal' },
  { id: 'claude', label: 'Claude Code', sub: 'Starts a new Claude Code session', kind: 'terminal' },
  { id: 'copy', label: 'Copy', sub: 'Paste into Cursor, ChatGPT, anything', kind: 'copy' },
  { id: 'download', label: 'Download', sub: 'Save as a Markdown file', kind: 'download' },
];
const ho = { target: 'copy', targets: null };
const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function buildHandoff(s, msgs) {
  const p = s.project;
  const users = msgs.filter((m) => m.role === 'user' && m.text.trim()).map((m) => stripMd(m.text).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lastAnswer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text.trim());
  const touched = [];
  const seen = new Set();
  for (const m of msgs) {
    for (const t of m.tools || []) {
      const d = String(t.detail || '').trim();
      const k = `${t.name || t}${d ? ` ${d}` : ''}`;
      if (!d || seen.has(k)) continue;
      seen.add(k);
      touched.push(k);
    }
  }
  const out = [`# Handoff: ${s.title}`, ''];
  out.push(`I'm continuing a conversation I had in ${toolLabel(s.source)} (last active ${date(s.mtime)}).`);
  if (p.cwd) out.push(`Project folder: ${p.cwd}${s.branch ? ` (git branch ${s.branch})` : ''}`);
  out.push('');
  if (users.length) {
    out.push('## What I asked, in order');
    const pick = users.length > 12 ? [...users.slice(0, 4), '…', ...users.slice(-7)] : users;
    for (const u of pick) out.push(u === '…' ? '- …' : `- ${cut(u, 240)}`);
    out.push('');
  }
  if (lastAnswer) out.push('## Where we left off', cut(lastAnswer.text.trim(), 1800), '');
  if (touched.length) {
    out.push('## Files and commands involved');
    for (const t of touched.slice(-15)) out.push(`- ${cut(t, 140)}`);
    out.push('');
  }
  out.push('## What I need from you', 'Check the current state of the files above, then continue from where we left off. Ask me if anything is unclear.');
  return out.join('\n');
}

function renderHandoffTargets() {
  const p = state.detail.project;
  $('hoTargets').innerHTML = HO_OPTIONS.map((o) => {
    const t = ho.targets && ho.targets[o.id];
    const missing = o.kind === 'terminal' && t && !t.installed;
    return `<button type="button" class="ho-opt" role="radio" data-ho="${o.id}" aria-checked="${ho.target === o.id}" ${missing ? 'disabled' : ''}>
      ${use(o.kind === 'copy' ? 'copy' : o.kind === 'download' ? 'download' : 'terminal')}
      <span><b>${esc(o.label)}</b><span class="small muted">${missing ? `Not installed (no "${o.id}" command)` : esc(o.sub)}</span></span>
    </button>`;
  }).join('');
  const opt = HO_OPTIONS.find((o) => o.id === ho.target);
  $('hoGoLabel').textContent = opt.kind === 'copy' ? 'Copy handoff' : opt.kind === 'download' ? 'Download .md' : `Open in ${opt.label}`;
  $('hoGo').querySelector('use').setAttribute('href', opt.kind === 'copy' ? '#i-copy' : opt.kind === 'download' ? '#i-download' : '#i-handoff');
  $('hoNote').textContent = opt.kind === 'terminal'
    ? (p.exists ? `Starts in ${short(p.cwd)} with the handoff as your first message.` : 'This chat has no project folder on this computer, so it starts in your home folder.')
    : opt.kind === 'copy' ? 'Paste it as the first message in the other tool.' : 'Saves the handoff so you can attach or paste it later.';
}

async function openHandoff() {
  const s = state.detail;
  if (!s) return;
  if (!state.msgs.length) { toast('Wait for the chat to finish loading, then try again.'); return; }
  $('hoText').value = buildHandoff(s, state.msgs);
  $('hoError').textContent = '';
  updateHandoffCount();
  if (!ho.targets) { try { ho.targets = (await api('/api/handoff/targets')).targets; } catch { ho.targets = {}; } }
  // Default to "the other tool" when it's installed, otherwise Copy.
  const other = s.source === 'codex' ? 'claude' : 'codex';
  ho.target = ho.targets[other] && ho.targets[other].installed ? other : (ho.targets.claude && ho.targets.claude.installed && s.source !== 'claude' ? 'claude' : 'copy');
  renderHandoffTargets();
  $('handoff').showModal();
  $('hoText').scrollTop = 0;
}
function updateHandoffCount() {
  const n = $('hoText').value.length;
  $('hoCount').textContent = `${n.toLocaleString()} characters${n > 20000 ? ' (too long, 20,000 max)' : ''}`;
}

async function goHandoff() {
  const s = state.detail;
  const text = $('hoText').value.trim();
  const opt = HO_OPTIONS.find((o) => o.id === ho.target);
  $('hoError').textContent = '';
  if (!text) { $('hoError').textContent = 'The handoff is empty.'; return; }
  if (opt.kind === 'copy') {
    await copyText(text);
    $('handoff').close();
    toast('Handoff copied. Paste it as the first message in the other tool.');
    return;
  }
  if (opt.kind === 'download') {
    const name = `handoff-${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat'}.md`;
    if (vsc) {
      try {
        if (!(await host('save', { name, text })).saved) return;
      } catch (e) { $('hoError').textContent = e.message; return; }
      $('handoff').close();
      toast('Handoff saved.');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('handoff').close();
    toast('Handoff downloaded.');
    return;
  }
  $('hoGo').disabled = true;
  try {
    const r = await api('/api/handoff', { key: s.project.key, id: s.id, target: opt.id, text });
    $('handoff').close();
    toast(`Opened ${r.target} in ${r.terminal}, starting from your handoff.`);
  } catch (e) {
    $('hoError').textContent = e.message;
  } finally {
    $('hoGo').disabled = false;
  }
}

// ---------- mover ----------
// groups: [{ key, ids|null }]  (ids null = whole project, including memory)
async function openMover(groups) {
  const projects = groups.map((g) => ({ ...g, p: state.projects.find((x) => x.key === g.key) })).filter((g) => g.p);
  if (!projects.length) return;
  const count = projects.reduce((n, g) => n + (g.ids ? g.ids.length : g.p.sessions.length), 0);
  state.mover = { groups: projects, count };
  const first = projects[0].p;
  $('moverTitle').textContent = `Move ${plural(count, 'session')}`;
  $('moverFrom').textContent = projects.length === 1 ? (short(first.cwd) || first.key) : `${projects.length} projects`;
  $('moverFromState').innerHTML = projects.length === 1 && first.missing ? '<span class="chip danger">folder missing</span>' : '';
  $('moverTo').value = '';
  $('moverError').textContent = '';
  $('suggestions').innerHTML = '<span class="sk" style="width:70%;height:44px"></span>';
  $('suggestBox').hidden = false;
  updatePreview();
  if ($('detail').open) $('detail').close();
  $('mover').showModal();
  browse(first.exists ? first.cwd : parentOf(first.cwd));
  try {
    const { suggestions } = await api(`/api/suggest?key=${encodeURIComponent(first.key)}`);
    $('suggestions').innerHTML = suggestions.length
      ? suggestions.map((s) => `<button type="button" class="choice" data-pick="${esc(s.path)}" aria-pressed="false">${ICON.folder}<span>${esc(short(s.path))}</span></button>`).join('')
      : '<p class="muted small">No similar folder names found nearby. Type or browse to the folder below.</p>';
    stagger($('suggestions'));
  } catch {
    $('suggestBox').hidden = true;
  }
}

function parentOf(p) {
  if (!p) return state.home;
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '/';
}

async function browse(path) {
  try {
    const d = await api(`/api/dirs?path=${encodeURIComponent(path || state.home)}`);
    $('browsePath').textContent = short(d.path);
    $('browseList').innerHTML =
      (d.parent ? `<button type="button" data-browse="${esc(d.parent)}">${use('up')}Up one level</button>` : '') +
      `<button type="button" class="use-here" data-pick="${esc(d.path)}">${use('check')}<b>Use this folder</b><span class="muted">${esc(short(d.path))}</span></button>` +
      d.dirs.map((n) => `<button type="button" data-browse="${esc((d.path === '/' ? '' : d.path) + '/' + n)}">${ICON.folder}${esc(n)}</button>`).join('');
  } catch (e) {
    $('browseList').innerHTML = `<p class="error small">${esc(e.message)}</p>`;
  }
}

function markPicked(path) {
  document.querySelectorAll('#suggestions .choice').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === path)));
}
function pick(path) {
  $('moverTo').value = short(path);
  markPicked(path);
  updatePreview();
}

function updatePreview() {
  const m = state.mover;
  if (!m) return;
  const raw = $('moverTo').value.trim();
  const to = raw ? expand(raw) : '';
  $('moverError').textContent = '';
  if (!to) {
    $('moverPreview').innerHTML = '<span class="muted">Pick the folder these sessions belong to now.</span>';
    $('moverGo').disabled = true;
    return;
  }
  const key = encode(to);
  const target = state.projects.find((p) => p.key === key);
  const same = m.groups.filter((g) => g.key === key);
  const movable = m.count - same.reduce((n, g) => n + (g.ids ? g.ids.length : g.p.sessions.length), 0);
  if (!movable) {
    $('moverPreview').innerHTML = '<span class="muted">That is the folder they already belong to.</span>';
    $('moverGo').disabled = true;
    return;
  }
  const memory = m.groups.some((g) => !g.ids && g.p.memory);
  $('moverPreview').innerHTML = `Moves ${plural(movable, 'session')}${memory ? ' and project memory' : ''} to <code>${esc(short(state.root))}/${esc(key)}</code>.
    ${same.length ? ` ${plural(m.count - movable, 'session')} already there will be left alone.` : ''}
    ${target && target.sessions.length ? ` Merges with the ${plural(target.sessions.length, 'session')} already there.` : ''}
    A backup is saved first.`;
  $('moverGo').disabled = false;
}

async function doMove(e) {
  e.preventDefault();
  const m = state.mover;
  const to = expand($('moverTo').value.trim());
  const key = encode(to);
  $('moverGo').disabled = true;
  $('moverGo').textContent = 'Moving…';
  let moved = 0;
  let skipped = 0;
  try {
    for (const g of m.groups) {
      if (g.key === key) continue;
      const r = await api('/api/move', { key: g.key, to, ids: g.ids || undefined });
      moved += r.moved;
      skipped += r.skipped.length;
    }
    $('mover').close();
    state.selected.clear();
    const st = starState();
    const offer = !st.clicked && !st.offeredAfterFix;
    if (offer) { st.offeredAfterFix = true; saveStar(st); }
    toast(`Moved ${plural(moved, 'session')} to ${short(to)}.${skipped ? ` Skipped ${skipped} that already existed.` : ''}${offer ? ' Glad it helped?' : ''}`,
      offer ? { label: '★ Star on GitHub', href: REPO_URL, star: true } : undefined);
  } catch (err) {
    $('moverError').textContent = moved ? `Moved ${moved}, then stopped: ${err.message}` : err.message;
  } finally {
    $('moverGo').textContent = 'Move sessions';
    $('moverGo').disabled = false;
    if (moved) await load();
  }
}

function bulkGroups() {
  const by = new Map();
  for (const s of state.sessions) {
    if (!state.selected.has(s.uid)) continue;
    if (!by.has(s.project.key)) by.set(s.project.key, []);
    by.get(s.project.key).push(s.id);
  }
  return [...by].map(([key, ids]) => ({ key, ids }));
}

// ---------- command palette ----------
const pal = { items: [], active: 0 };
function paletteItems(q) {
  const ql = q.trim().toLowerCase();
  const actions = [
    { group: 'Go to', label: 'Overview', hint: 'g o', run: () => setView('overview'), icon: 'grid' },
    { group: 'Go to', label: 'Sessions', hint: 'g s', run: () => setView('sessions'), icon: 'chat' },
    { group: 'Go to', label: 'Bookmarks', hint: 'g m', run: () => setView('bookmarks'), icon: 'bookmark' },
    { group: 'Go to', label: 'Usage and cost', hint: 'g u', run: () => setView('usage'), icon: 'chart' },
    { group: 'Go to', label: 'Projects', hint: 'g p', run: () => setView('projects'), icon: 'folder' },
    { group: 'Go to', label: 'Backups', hint: 'g b', run: () => setView('backups'), icon: 'archive' },
    { group: 'Actions', label: 'Tools & import', run: () => openSources(), icon: 'plug' },
    { group: 'Chatshelf', label: 'Star Chatshelf on GitHub', run: () => openUrl(REPO_URL), icon: 'star' },
    { group: 'Chatshelf', label: 'About Chatshelf', run: () => $('shortcuts').showModal(), icon: 'star' },
    { group: 'Chatshelf', label: 'Author on X (@khoaizahmmed)', run: () => openUrl('https://x.com/khoaizahmmed'), icon: 'link' },
    { group: 'Chatshelf', label: 'Report a bug or suggest a feature', run: () => openUrl(`${REPO_URL}/issues/new/choose`), icon: 'chat' },
    { group: 'Chatshelf', label: 'Contribute: add support for another tool', run: () => openUrl(`${REPO_URL}/blob/main/CONTRIBUTING.md`), icon: 'plug' },
    { group: 'Actions', label: 'Import a ChatGPT or claude.ai export', run: () => openSources(), icon: 'upload' },
    { group: 'Actions', label: 'Keep every chat (archive)', run: () => setView('overview'), icon: 'shield' },
    { group: 'Actions', label: 'Copy the MCP setup command for Claude Code', run: () => copyText(MCP_CMD).then(() => toast('Copied. Run it in a terminal to let Claude Code search your chats.')), icon: 'plug' },
    { group: 'Actions', label: 'Find missing folders', run: () => { state.projTab = 'missing'; renderProjects(); setView('projects'); }, icon: 'search' },
    { group: 'Actions', label: 'Light theme', run: () => applyTheme('light'), icon: 'sun' },
    { group: 'Actions', label: 'Dark theme', run: () => applyTheme('dark'), icon: 'moon' },
    { group: 'Actions', label: 'Theme: follow system', run: () => applyTheme('system'), icon: 'monitor' },
    { group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: () => $('shortcuts').showModal(), icon: 'key' },
  ];
  const sessions = (ql ? state.sessions.filter((s) => s.hay.includes(ql)) : [...pinnedSessions(), ...state.sessions.filter((s) => !state.pins.has(s.uid) && s.promptCount)])
    .slice(0, ql ? 8 : 6)
    .map((s) => ({ group: ql ? 'Sessions' : 'Recent', label: s.title, sub: `${toolLabel(s.source)} · ${projName(s.project)} · ${ago(s.mtime)}`, run: () => openDetail(s.uid), icon: state.pins.has(s.uid) ? 'bookmark' : 'chat' }));
  const projects = ql ? state.projects.filter((p) => (p.cwd || p.key).toLowerCase().includes(ql)).slice(0, 4)
    .map((p) => ({ group: 'Projects', label: projName(p), sub: `${toolLabel(p.source)} · ${short(p.cwd)}`, run: () => { $('proj').value = p.key; searchFor(''); }, icon: 'folder' })) : [];
  const chatMarksHit = ql ? [...state.chatMarks.values()].filter((b) => [b.note, b.title].join('\n').toLowerCase().includes(ql)).slice(0, 3)
    .map((b) => ({ group: 'Bookmarks', label: b.note || b.title, sub: b.note ? `Chat: ${b.title}` : 'Bookmarked chat', run: () => { const x = sessionById(b.sessionId); if (x) openDetail(x.uid); }, icon: 'bookmark' })) : [];
  const marks = ql ? msgMarks().filter((b) => [b.text, b.note, b.title].join('\n').toLowerCase().includes(ql)).slice(0, 5)
    .map((b) => ({ group: 'Bookmarks', label: b.note || stripMd(b.text) || 'Bookmarked message', sub: [b.title || (sessionById(b.sessionId) || {}).title, b.readOnly ? b.source : ''].filter(Boolean).join(' · '), run: () => openBookmark(b.id), icon: 'bookmark' })) : [];
  const tagHits = ql ? [...new Set(state.sessions.flatMap((s) => s.tags))].filter((t) => t.includes(ql.replace(/^#/, ''))).slice(0, 4)
    .map((t) => ({ group: 'Tags', label: `#${t}`, sub: plural(state.sessions.filter((s) => s.tags.includes(t)).length, 'chat'), run: () => { $('tagFilter').value = t; searchFor(''); }, icon: 'tag' })) : [];
  const acts = actions.filter((a) => !ql || a.label.toLowerCase().includes(ql));
  return [...sessions, ...tagHits, ...chatMarksHit, ...marks, ...projects, ...acts];
}
function renderPalette() {
  const q = $('palQ').value;
  pal.items = paletteItems(q);
  pal.active = Math.min(pal.active, Math.max(0, pal.items.length - 1));
  let group = '';
  $('palList').innerHTML = pal.items.map((it, i) => {
    const head = it.group !== group ? `<div class="pal-group" role="presentation">${esc((group = it.group))}</div>` : '';
    return `${head}<div class="pal-item" role="option" id="pal-${i}" data-pal="${i}" aria-selected="${i === pal.active}">
      ${use(it.icon)}<span class="pal-label"><span class="pal-main">${hl(it.label, q.trim().toLowerCase())}</span>${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}</div>`;
  }).join('') || `<div class="pal-empty muted">No matches for “${esc(q)}”. Try a folder name or a word from a prompt.</div>`;
  $('palQ').setAttribute('aria-activedescendant', pal.items.length ? `pal-${pal.active}` : '');
}
function openPalette() {
  if ($('palette').open) return;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('palQ').value = '';
  pal.active = 0;
  renderPalette();
  $('palette').showModal();
  $('palQ').focus();
  stagger($('palList'), '.pal-item', 10);
}
function runPalette(i) {
  const it = pal.items[i];
  if (!it) return;
  $('palette').close();
  it.run();
}
function movePalette(d) {
  if (!pal.items.length) return;
  pal.active = (pal.active + d + pal.items.length) % pal.items.length;
  $('palList').querySelectorAll('.pal-item').forEach((el) => el.setAttribute('aria-selected', String(Number(el.dataset.pal) === pal.active)));
  $('palQ').setAttribute('aria-activedescendant', `pal-${pal.active}`);
  $(`pal-${pal.active}`).scrollIntoView({ block: 'nearest' });
}

// ---------- theme ----------
// In VS Code, "System" follows the editor's colour theme (its class on <body>) instead of the OS.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const systemDark = () => (vsc ? /\bvscode-(dark|high-contrast)\b/.test(document.body.className) && !document.body.classList.contains('vscode-high-contrast-light') : darkQuery.matches);
const DEFAULT_THEME = vsc ? 'system' : 'light';
function applyTheme(pref, animate = true) {
  localStorage.setItem('csm-theme', pref);
  const dark = pref === 'dark' || (pref === 'system' && systemDark());
  const set = () => {
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === pref)));
  };
  if (animate && motionOn() && document.startViewTransition && root.dataset.theme !== (dark ? 'dark' : 'light')) document.startViewTransition(set);
  else set();
}
const followSystem = () => { if ((localStorage.getItem('csm-theme') || DEFAULT_THEME) === 'system') applyTheme('system'); };
if (vsc) new MutationObserver(followSystem).observe(document.body, { attributes: true, attributeFilter: ['class'] });
else darkQuery.addEventListener('change', followSystem);

// ---------- navigation ----------
const VIEWS = ['overview', 'sessions', 'bookmarks', 'usage', 'projects', 'backups'];
function setView(view) {
  const changed = state.view !== view;
  state.view = view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((t) => (t.dataset.view === view ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  renderBulk();
  if (view === 'backups') renderBackups();
  if (!$('detail').open && !deepLink && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, 0);
  if (changed || !state.loaded) animateView(view);
}

function searchFor(text) {
  $('q').value = text;
  state.shown = PAGE;
  state.sessTab = 'all';
  renderSessions();
  if (state.view !== 'sessions') setView('sessions');
}

function listButtons() {
  const scope = state.view === 'sessions' ? $('list') : state.view === 'overview' ? $('view-overview') : null;
  return scope ? [...scope.querySelectorAll('.row-open, button.row[data-session]')] : [];
}
function moveFocus(d) {
  const items = listButtons();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + d))];
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', behavior: motionOn() ? 'smooth' : 'auto' });
}
const focusedUid = () => { const el = document.activeElement; return el && el.dataset ? el.dataset.session : undefined; };

// ---------- events ----------
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-star-click]')) starClicked();
  if (e.target.closest('[data-star-later]')) { starLater(); return; }
  const pi = e.target.closest('[data-pal]');
  if (pi) { runPalette(Number(pi.dataset.pal)); return; }
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.themeSet) applyTheme(d.themeSet);
  else if ('palette' in d) openPalette();
  else if ('shortcuts' in d) $('shortcuts').showModal();
  else if ('sources' in d) openSources();
  else if (d.src !== undefined) { state.src = d.src; state.shown = PAGE; renderTools(); renderSessions(); stagger($('list'), ':scope > .row, :scope > .date-head', 12); if (state.view !== 'sessions') setView('sessions'); }
  else if (d.rmimport) removeImport(d.rmimport);
  else if ('copymcp' in d) copy(MCP_CMD, t);
  else if (d.archive) setArchive(d.archive, t);
  else if (d.sesstabGo) { $('q').value = ''; state.sessTab = d.sesstabGo; state.shown = PAGE; renderSessions(); setView('sessions'); }
  else if (d.urange) { state.urange = d.urange; renderUsage(); replay($('usageChart')); }
  else if (d.untag && state.detail) setTags(state.detail, state.detail.tags.filter((x) => x !== d.untag));
  else if (d.file) { $('detail').close(); $('q').value = ''; searchFor(d.file.toLowerCase()); toast(`Chats that changed ${base(d.file)}`); }
  else if (d.ho) { ho.target = d.ho; renderHandoffTargets(); }
  else if ('reload' in d) { skeletons(); load(); }
  else if ('clearFilters' in d) { $('q').value = ''; $('proj').value = ''; $('tagFilter').value = ''; state.sessTab = 'all'; state.src = ''; renderTools(); setDateFilter(''); }
  else if ('dateClear' in d) setDateFilter('');
  else if ('copycode' in d) copy(t.closest('.code').querySelector('code').textContent, t);
  else if (d.copymsg) copy(state.msgs[Number(d.copymsg)].text, t);
  else if ('more' in d) expandClamp(t.parentElement.querySelector('.clamp'));
  else if (d.who) { setWho(d.who); findInConvo($('find').value.trim()); }
  else if (d.pin) togglePin(d.pin);
  else if (d.bm) toggleBookmark(Number(d.bm));
  else if (d.bmopen) openBookmark(d.bmopen);
  else if (d.bmdel) removeBookmark(d.bmdel);
  else if (d.jump) scrollToMsg(d.jump);
  else if (d.bmtab) { state.bmTab = d.bmtab; renderBookmarks(); stagger($('bmList'), ':scope > *', 10); }
  else if (d.view) setView(d.view);
  else if (d.session) {
    // From a search, open at the first match.
    const q = state.view === 'sessions' ? $('q').value.trim().toLowerCase() : '';
    const s = state.byUid.get(d.session);
    const hit = q && s ? deepHit(s, q) : null;
    openDetail(d.session, hit ? hit.uuid : '', q && !q.startsWith('/') && !q.startsWith('#') ? q.split(/\s+/)[0] : '');
  }
  else if (d.show) { $('proj').value = d.show; $('q').value = ''; state.sessTab = 'all'; state.shown = PAGE; renderSessions(); setView('sessions'); }
  else if (d.move) openMover([{ key: d.move, ids: null }]);
  else if (d.pick) pick(d.pick);
  else if (d.browse) browse(d.browse);
  else if (d.sesstab) { state.sessTab = d.sesstab; state.shown = PAGE; renderSessions(); stagger($('list'), ':scope > .row, :scope > .date-head', 12); }
  else if (d.projtab) { state.projTab = d.projtab; renderProjects(); stagger($('projects'), ':scope > .tr, :scope > .group-head', 12); }
  else if (d.sort) {
    state.sort = d.sort;
    document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === d.sort)));
    renderSessions();
    stagger($('list'), ':scope > .row, :scope > .date-head', 12);
  } else if ('close' in d) t.closest('dialog').close();
  else if (d.restore) {
    t.disabled = true;
    try {
      const r = await api('/api/restore', { name: d.restore });
      toast(`Restored ${plural(r.restored, 'session')}.${r.skipped.length ? ` ${r.skipped.length} were already there.` : ''}`);
      await load();
    } catch (err) { toast(err.message); } finally { t.disabled = false; }
  }
});

document.addEventListener('change', (e) => {
  const uid = e.target.dataset && e.target.dataset.select;
  if (!uid) return;
  if (e.target.checked) state.selected.add(uid); else state.selected.delete(uid);
  e.target.closest('.row').classList.toggle('is-selected', e.target.checked);
  renderBulk();
  const { rows } = filteredSessions();
  const visible = rows.slice(0, state.shown);
  $('selectAll').checked = visible.length > 0 && visible.every((s) => state.selected.has(s.uid));
  $('selectAll').indeterminate = !$('selectAll').checked && visible.some((s) => state.selected.has(s.uid));
});
$('selectAll').addEventListener('change', (e) => {
  const { rows } = filteredSessions();
  for (const s of rows.slice(0, state.shown)) { if (e.target.checked) state.selected.add(s.uid); else state.selected.delete(s.uid); }
  renderSessions();
  renderBulk();
});
document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.bmnote) saveNote(e.target); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.bmnote) { e.preventDefault(); e.target.blur(); } }, true);
$('bmQ').addEventListener('input', () => renderBookmarks());
$('importFile').addEventListener('change', (e) => uploadExport(e.target.files[0]));
['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', (e) => uploadExport(e.dataTransfer.files[0]));
$('dateRange').addEventListener('change', () => {
  const v = $('dateRange').value;
  if (v === 'custom' && !$('dateFrom').value && !$('dateTo').value) { $('dateFrom').value = ymd(Date.now() - 6 * DAY); $('dateTo').value = ymd(Date.now()); }
  $('dateCustom').hidden = v !== 'custom';
  state.shown = PAGE;
  renderSessions();
  stagger($('list'), ':scope > .row, :scope > .date-head', 12);
  if (v === 'custom') $('dateFrom').focus();
});
['dateFrom', 'dateTo'].forEach((id) => $(id).addEventListener('change', () => { state.shown = PAGE; renderSessions(); }));
$('heat').addEventListener('click', (e) => {
  const cell = e.target.closest('i[data-day]');
  if (!cell) return;
  state.src = '';
  state.sessTab = 'all';
  $('q').value = '';
  $('proj').value = '';
  renderTools();
  setDateFilter('custom', cell.dataset.day, cell.dataset.day);
  setView('sessions');
  toast(`Showing chats from ${dateLabel()}`);
});
$('showEmpty').addEventListener('change', () => { state.shown = PAGE; renderSessions(); });
$('deepSearch').checked = deepEnabled();
$('deepSearch').addEventListener('change', (e) => { localStorage.setItem('csm-deep', e.target.checked ? '1' : '0'); state.deep = { q: '', hits: new Map(), busy: false }; renderSessions(); });
$('tagFilter').addEventListener('change', () => { state.shown = PAGE; renderSessions(); });
$('usageTool').addEventListener('change', (e) => { state.utool = e.target.value; renderUsage(); });
$('usageChart').addEventListener('click', (e) => {
  const bar = e.target.closest('[data-day]');
  if (!bar) return;
  state.src = state.utool;
  $('q').value = '';
  renderTools();
  setDateFilter('custom', bar.dataset.day, bar.dataset.day);
  setView('sessions');
});
document.addEventListener('keydown', async (e) => {
  if (e.target.id !== 'tagInput' || !state.detail) return;
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const v = e.target.value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (!v || state.detail.tags.includes(v)) { e.target.value = ''; return; }
    if (await setTags(state.detail, [...state.detail.tags, v])) $('tagInput').focus();
  } else if (e.key === 'Backspace' && !e.target.value && state.detail.tags.length) {
    setTags(state.detail, state.detail.tags.slice(0, -1)).then(() => $('tagInput').focus());
  }
});
$('bulkClear').addEventListener('click', () => { state.selected.clear(); renderSessions(); renderBulk(); });
$('bulkGo').addEventListener('click', () => openMover(bulkGroups()));

$('detailCopy').addEventListener('click', (e) => copy($('detailCmd').textContent, e.currentTarget));
$('detailOpen').addEventListener('click', openTerminal);
$('detailHandoff').addEventListener('click', openHandoff);
$('hoGo').addEventListener('click', goHandoff);
$('hoText').addEventListener('input', updateHandoffCount);
$('detailPin').addEventListener('click', () => state.detail && togglePin(state.detail.uid));
$('detailMove').addEventListener('click', () => state.detail && openMover([{ key: state.detail.project.key, ids: [state.detail.id] }]));
$('detail').addEventListener('close', () => { state.detail = null; history.replaceState(null, '', `#${state.view}`); });
let findTimer;
$('find').addEventListener('input', (e) => { clearTimeout(findTimer); findTimer = setTimeout(() => findInConvo(e.target.value.trim()), 200); });
$('find').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusHit(state.hitIdx + (e.shiftKey ? -1 : 1)); } });
$('jumpEnd').addEventListener('click', () => { const t = $('transcript'); t.scrollTo({ top: t.scrollHeight, behavior: motionOn() ? 'smooth' : 'auto' }); });

$('moverTo').addEventListener('input', () => { markPicked(expand($('moverTo').value.trim())); updatePreview(); });
$('moverTo').addEventListener('change', () => { const v = expand($('moverTo').value.trim()); if (v) browse(v); });
$('moverForm').addEventListener('submit', doMove);
$('more').addEventListener('click', () => { state.shown += PAGE; renderSessions(); });
$('q').addEventListener('input', () => { state.shown = PAGE; renderSessions(); });
$('proj').addEventListener('input', () => { state.shown = PAGE; renderSessions(); stagger($('list'), ':scope > .row, :scope > .date-head', 12); });
$('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') { searchFor(e.target.value); $('q').focus(); } });

$('palQ').addEventListener('input', () => { pal.active = 0; renderPalette(); });
$('palQ').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(pal.active); }
});
// Clicking the backdrop closes a dialog.
document.querySelectorAll('dialog').forEach((dlg) => dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }));

let gPending = 0;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  const el = document.activeElement;
  const typing = /INPUT|TEXTAREA|SELECT/.test(el.tagName) && el.type !== 'checkbox';
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (gPending && Date.now() - gPending < 1200) {
    const map = { o: 'overview', s: 'sessions', m: 'bookmarks', u: 'usage', p: 'projects', b: 'backups' };
    gPending = 0;
    if (map[e.key]) { e.preventDefault(); setView(map[e.key]); }
    return;
  }
  const inList = listButtons().includes(el);
  if (e.key === 'g') { gPending = Date.now(); }
  else if (e.key === '/') {
    e.preventDefault();
    if (state.view === 'overview') $('ask').focus();
    else { if (state.view !== 'sessions') setView('sessions'); $('q').focus(); }
  } else if (e.key === '?') { e.preventDefault(); $('shortcuts').showModal(); }
  else if (e.key === 'j' || (e.key === 'ArrowDown' && inList)) { e.preventDefault(); moveFocus(1); }
  else if (e.key === 'k' || (e.key === 'ArrowUp' && inList)) { e.preventDefault(); moveFocus(-1); }
  else if (e.key === 'x' && focusedUid()) {
    const box = document.querySelector(`[data-select="${CSS.escape(focusedUid())}"]`);
    if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }
  } else if ((e.key === 'b' || e.key === 'p') && focusedUid()) {
    const uid = focusedUid();
    togglePin(uid).then(() => {
      const again = document.querySelector(`#view-${state.view} [data-session="${CSS.escape(uid)}"]`);
      if (again) again.focus({ preventScroll: true });
    });
  } else if (e.key === 'Escape' && state.selected.size) { state.selected.clear(); renderSessions(); renderBulk(); }
});

// ---------- start ----------
applyTheme(localStorage.getItem('csm-theme') || DEFAULT_THEME, false);
skeletons();
if (!vsc) loadStars(); // the VS Code webview only talks to the extension
initStar();
setView(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : deepLink ? 'sessions' : 'overview');
load();
