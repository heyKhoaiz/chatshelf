# Chatshelf: notes for coding agents

Chatshelf is a local web app that reads AI coding chat history (Claude Code, Codex, Cursor, Copilot Chat, plus experimental OpenCode and Gemini CLI, and imported ChatGPT and claude.ai exports) and shows it in one place. It also moves Claude Code sessions after a project folder is renamed.

It is **published on npm** as [`chatshelf`](https://www.npmjs.com/package/chatshelf) and on GitHub as [`heyKhoaiz/chatshelf`](https://github.com/heyKhoaiz/chatshelf). People run it with `npx chatshelf`, so anything that reaches `main` or npm reaches users.

## Publishing: ask first, every time

- **Never run `npm publish`, `npm run release`, `npm version`, `npm unpublish`, `npm deprecate` or `git push --tags`** unless the maintainer asks for that release in this conversation. Approval for one release doesn't carry over to the next.
- Releases go through `npm run release -- <patch|minor|major>` only (see [RELEASING.md](RELEASING.md)). Don't hand-edit the version in `package.json`, and don't publish with plain `npm publish`.
- A published version can't be reused, and unpublishing only works for 72 hours. To check a release without changing anything, use `npm run release -- patch --dry-run`.
- npm requires the maintainer's 2FA confirmation. Never ask for, enter or store one-time codes, tokens or passwords; the maintainer confirms in their own browser.
- Commit and push only when asked. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`), because GitHub release notes are generated from them.

## Commands

```bash
npm start                 # run against your real chats (http://127.0.0.1:4317)
npm run demo              # run against fake chats in a temp folder
npm test                  # end-to-end smoke test against demo data
npm run check             # syntax check
npm run release -- patch --dry-run   # rehearse a release (changes nothing)
```

Node 22.5+ (uses the built-in `node:sqlite` for Cursor). No dependencies and no build step. Keep it that way.

## Layout

| Path | Role |
| --- | --- |
| `server.mjs` | HTTP server and API. Claude Code reader, move/backup/restore, bookmarks, open-in-terminal |
| `sources.mjs` | Readers for the other tools, and the ChatGPT and claude.ai importers |
| `public/` | The web app (`index.html`, `app.js`, `style.css`), plain JS |
| `bin/chatshelf.mjs` | The `chatshelf` / `npx chatshelf` entry point |
| `test/demo-data.mjs`, `test/smoke.mjs` | Demo data and the smoke test |
| `scripts/demo.mjs`, `scripts/release.mjs` | `npm run demo`, `npm run release` |

Only `server.mjs`, `sources.mjs`, `public/` and `bin/` ship in the npm package (`files` in `package.json`). A new runtime file must be added there, or it won't be published.

## Rules

- **Privacy:** the app reads people's private chats. Never put real chat content, real personal paths or real screenshots into code, tests, docs or commits. Screenshots come from `npm run demo`.
- **Read-only:** never write to another tool's files. The only writes outside Chatshelf's own folders are user-triggered moves and restores of Claude Code sessions, always with a backup first.
- **Security:** keep the server on `127.0.0.1`, keep the `Host` check and the per-run token on every `/api/` route, and escape everything rendered into HTML.
- **Readers:** a missing or unreadable file means "not found", never a crash. Mark a reader `experimental` until it has been tested on real data. When adding one, follow CONTRIBUTING.md (reader, `TOOLS` and `ASSISTANT` in `app.js`, a colour class, demo data, a smoke test).
- **UI:** warm neutrals, ink `#1C1917` for primary actions, orange `#E8590C` as the one accent, 44px targets, visible focus, `prefers-reduced-motion` respected, SVG icons (no emoji).
- Run `npm run check && npm test` before saying a change works.
