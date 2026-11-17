# Contributing to Chatshelf

Thanks for helping! Chatshelf is small on purpose: plain Node.js and browser JavaScript, no build step, no dependencies. You can read the whole thing in an afternoon.

## Get started

```bash
git clone https://github.com/heyKhoaiz/chatshelf.git
cd chatshelf
npm run demo     # runs with fake chats, so you don't need your own history
npm test         # end-to-end smoke test against the demo data
npm run check    # syntax check
```

Requires Node.js 22.5 or newer.

## How the code is laid out

| File | What it does |
| --- | --- |
| `server.mjs` | HTTP server and API. Reads Claude Code sessions, moves them, handles backups, bookmarks and opening terminals. |
| `sources.mjs` | Readers for every other tool (Codex, Cursor, Copilot, OpenCode, Gemini CLI) and the ChatGPT and claude.ai importers. |
| `public/` | The web app: `index.html`, `app.js`, `style.css`. |
| `test/demo-data.mjs` | Builds a fake home folder with chats from several tools. |
| `test/smoke.mjs` | Starts the server against the demo data and checks the API. |

## Add or fix a tool reader

Each reader in `sources.mjs` is an object with:

```js
{
  id: 'mytool',            // short id, also used for the colour class .s-mytool
  label: 'My Tool',
  experimental: true,      // until someone has tested it with real data
  async status() { /* { id, label, found, path, count } */ },
  async list() { /* [{ id, cwd, title, prompts, promptCount, last, start, mtime, size, branch, ref }] */ },
  async transcript(ref) { /* [{ role: 'user' | 'assistant', text, tools: [{ name, detail }], ts, uuid }] */ },
}
```

Then:

1. Add it to `READERS` at the bottom of `sources.mjs`.
2. Add its name to `TOOLS` and `ASSISTANT` in `public/app.js`, and a colour in `style.css` (`.s-mytool { --tool: … }`).
3. If it can be resumed, add it to `resumeInfo()` in `app.js` and to `openTerminal()` in `server.mjs`.
4. Add a few fake chats to `test/demo-data.mjs` and a check to `test/smoke.mjs`.

Rules for readers:

- **Read-only.** Never write to another tool's files. Open databases with `readOnly: true`.
- **Fail quietly.** A missing or unreadable file means "not found", never a crash.
- **Don't guess formats silently.** If you write a reader without real data to test against, mark it `experimental: true` and say so in the PR.
- Never paste real chat content into issues, PRs, tests or screenshots. Use made-up examples.

## Pull requests

- Keep each PR focused on one change. Include a screenshot for UI changes, taken with `npm run demo`.
- Run `npm run check` and `npm test` before you push. CI runs both.
- Match the existing style: 2-space indent, single quotes, small functions, no new dependencies.
- UI: warm neutrals, ink `#1C1917` for primary actions, orange `#E8590C` as the one accent, 44px touch targets, visible focus rings, and respect for `prefers-reduced-motion`.
- Commit messages: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`…).

## Releasing (maintainers)

Releases are made with one command, `npm run release -- patch` (or `minor` / `major`). See **[RELEASING.md](RELEASING.md)**.

## Reporting bugs

Open an issue with your OS, Node version, the tool involved and what you expected. Leave out personal paths and chat content.

## Be kind

Assume good intent, keep feedback about the code, and help newcomers. Harassment of any kind isn't welcome here.
