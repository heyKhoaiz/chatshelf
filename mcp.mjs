// Chatshelf as an MCP server (stdio), so an AI tool can look things up in your past chats.
// Read-only: it searches and reads chats, and never changes anything.
//
//   claude mcp add chatshelf -- npx -y chatshelf mcp
//
// Speaks JSON-RPC 2.0, one message per line on stdin/stdout. Logs go to stderr only, because
// stdout belongs to the protocol.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { scan, search, readMessages } from './core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LABELS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot Chat', opencode: 'OpenCode', gemini: 'Gemini CLI', chatgpt: 'ChatGPT', claudeai: 'claude.ai' };
const TOOL_IDS = Object.keys(LABELS);
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

const TOOLS = [
  {
    name: 'search_chats',
    description: 'Search the user\'s past AI chats (Claude Code, Codex, Cursor, Copilot Chat, imported ChatGPT and claude.ai) for words in their prompts or in the replies. Every word must appear in the chat. Returns the newest matches first, with a snippet and the chat id for read_chat.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "rate limit sliding window".' },
        tool: { type: 'string', enum: TOOL_IDS, description: 'Only chats from this tool.' },
        project: { type: 'string', description: 'Only chats whose project folder path contains this text.' },
        limit: { type: 'number', description: 'Most results to return (default 10, max 50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_chats',
    description: 'List the user\'s most recent AI chats, newest first, optionally for one project folder or tool.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only chats whose project folder path contains this text.' },
        tool: { type: 'string', enum: TOOL_IDS },
        days: { type: 'number', description: 'Only chats active in the last N days.' },
        limit: { type: 'number', description: 'Most results to return (default 20, max 100).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_chat',
    description: 'Read one chat as plain text: the user\'s prompts, the replies, and the tools that ran. Use an id from search_chats or list_chats. Long chats are cut to max_chars, keeping the start and the end.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The chat id.' },
        max_chars: { type: 'number', description: 'Most characters to return (default 30000).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const clamp = (v, d, max) => Math.max(1, Math.min(max, Math.floor(Number(v) || d)));
const inProject = (p, text) => !text || String(p.cwd || '').toLowerCase().includes(String(text).toLowerCase());
const line = (p, s) => `- ${s.title} | ${LABELS[s.source] || s.source} | ${p.cwd || 'no folder'} | ${day(s.mtime)} | id: ${s.id}`;

async function findChat(id) {
  for (const p of await scan()) {
    const s = p.sessions.find((x) => x.id === id);
    if (s) return { p, s };
  }
  return null;
}

async function call(name, a = {}) {
  if (name === 'search_chats') {
    if (!String(a.query || '').trim()) throw new Error('query is empty.');
    const { hits, total } = await search({ q: a.query, limit: 1000, source: a.tool || '' });
    const byKey = new Map((await scan()).map((p) => [p.key, p]));
    const rows = [];
    for (const h of hits) {
      const p = byKey.get(h.key);
      const s = p && p.sessions.find((x) => x.id === h.id);
      if (!s || !inProject(p, a.project)) continue;
      rows.push(`${line(p, s)}\n  ${h.role === 'user' ? 'User' : 'Assistant'}: ${h.snippet}`);
      if (rows.length >= clamp(a.limit, 10, 50)) break;
    }
    return rows.length ? `${rows.length} of ${total} matching chats:\n${rows.join('\n')}` : `No chats contain "${a.query}".`;
  }
  if (name === 'list_chats') {
    const since = a.days ? Date.now() - Number(a.days) * 864e5 : 0;
    const rows = (await scan())
      .filter((p) => (!a.tool || p.source === a.tool) && inProject(p, a.project))
      .flatMap((p) => p.sessions.filter((s) => s.promptCount > 0 && s.mtime >= since).map((s) => ({ p, s })))
      .sort((x, y) => y.s.mtime - x.s.mtime)
      .slice(0, clamp(a.limit, 20, 100));
    return rows.length ? rows.map(({ p, s }) => line(p, s)).join('\n') : 'No chats found.';
  }
  if (name === 'read_chat') {
    const hit = await findChat(String(a.id || ''));
    if (!hit) throw new Error(`No chat with id ${a.id}.`);
    const { p, s } = hit;
    const msgs = await readMessages(p, s);
    const body = msgs.map((m) => {
      const tools = (m.tools || []).map((t) => `[${t.name}${t.detail ? ` ${t.detail}` : ''}]`).join(' ');
      return `## ${m.role === 'user' ? 'User' : 'Assistant'}${m.ts ? ` (${m.ts})` : ''}\n${m.text}${tools ? `\n${tools}` : ''}`;
    }).join('\n\n');
    const max = clamp(a.max_chars, 30000, 200000);
    const text = body.length > max ? `${body.slice(0, max * 0.4)}\n\n[… ${(body.length - max).toLocaleString()} characters left out …]\n\n${body.slice(-max * 0.6)}` : body;
    return `# ${s.title}\n${LABELS[s.source] || s.source} · ${p.cwd || 'no folder'} · last active ${day(s.mtime)}\n\n${text}`;
  }
  throw new Error(`Unknown tool: ${name}`);
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function onMessage(m) {
  const { id, method, params = {} } = m;
  const reply = (result) => { if (id !== undefined) send({ id, result }); };
  const fail = (code, message) => { if (id !== undefined) send({ id, error: { code, message } }); };
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'chatshelf', version },
        instructions: 'Search and read the user\'s past AI coding chats on this computer. Read-only.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        return reply({ content: [{ type: 'text', text: await call(params.name, params.arguments || {}) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message || 'Something went wrong.' }], isError: true });
      }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
      return fail(-32601, `Method not found: ${method}`);
  }
}

// Requests still being answered when the client closes stdin finish first, then the process exits.
const inFlight = new Set();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  if (!raw.trim()) return;
  let m;
  try { m = JSON.parse(raw); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const job = onMessage(m).catch((e) => { console.error(e); if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: e.message } }); });
  inFlight.add(job);
  job.finally(() => inFlight.delete(job));
});
rl.on('close', async () => { await Promise.allSettled([...inFlight]); process.exit(0); });
