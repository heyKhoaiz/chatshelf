# Chatshelf: notes for coding agents

Chatshelf is a local web app that reads AI coding chat history (Claude Code, Codex, Cursor, Copilot Chat, plus experimental OpenCode and Gemini CLI, and imported ChatGPT and claude.ai exports) and shows it in one place. It also moves Claude Code sessions after a project folder is renamed.

It is **published on npm** as [`chatshelf`](https://www.npmjs.com/package/chatshelf) and on GitHub as [`heyKhoaiz/chatshelf`](https://github.com/heyKhoaiz/chatshelf). People run it with `npx chatshelf`, so anything that reaches `main` or npm reaches users.

## Publishing: ask first, every time

- **Never run `npm publish`, `vsce publish`, `ovsx publish`, `npm run release`, `npm version`, `npm unpublish`, `npm deprecate` or `git push --tags`** unless the maintainer asks for that release in this conversation. Approval for one release doesn't carry over to the next.
- Releases go through `npm run release -- <patch|minor|major>` only (see [RELEASING.md](RELEASING.md)). Don't hand-edit the version in `package.json`, and don't publish with plain `npm publish`.
- A published version can't be reused, and unpublishing only works for 72 hours. To check a release without changing anything, use `npm run release -- patch --dry-run`.
- npm requires the maintainer's 2FA confirmation. Never ask for, enter or store one-time codes, tokens or passwords; the maintainer confirms in their own browser.
- Commit and push only when asked. Use Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`), because GitHub release notes are generated from them.

## Commands

```bash
npm start                 # run against your real chats (http://chatshelf.localhost:4317)
npm run demo              # run against fake chats in a temp folder
npm test                  # end-to-end smoke test against demo data
npm run check             # syntax check
npm run test:vscode       # VS Code extension test in a throwaway VS Code window (demo data)
npm run pack:vscode       # build vscode/chatshelf-<version>.vsix (does not publish)
npm run release -- patch --dry-run   # rehearse a release (changes nothing)
```

Node 22.5+ (uses the built-in `node:sqlite` for Cursor). No dependencies and no build step. Keep it that way.

## Layout

| Path | Role |
| --- | --- |
| `server.mjs` | HTTP server: address, `Host` allow-list, token, static files. Hands every `/api/` call to `core.mjs` |
| `core.mjs` | The API routes (`handle()`). Claude Code reader (with token usage and estimated cost), move/backup/restore, archive, search inside messages, tags, bookmarks, open-in-terminal. No HTTP, so the VS Code extension can use it too |
| `mcp.mjs` | `chatshelf mcp`: a read-only MCP server over stdio (`search_chats`, `list_chats`, `read_chat`) built on `core.mjs` |
| `sources.mjs` | Readers for the other tools, and the ChatGPT and claude.ai importers |
| `public/` | The web app (`index.html`, `app.js`, `style.css`), plain JS |
| `vscode/` | The VS Code extension: `extension.cjs` opens the app in a webview and answers its API calls with `core.mjs`, with no server. Its own `package.json` and version |
| `bin/chatshelf.mjs` | The `chatshelf` / `npx chatshelf` entry point |
| `test/demo-data.mjs`, `test/smoke.mjs` | Demo data and the smoke test |
| `scripts/demo.mjs`, `scripts/release.mjs` | `npm run demo`, `npm run release` |

Only `server.mjs`, `core.mjs`, `sources.mjs`, `mcp.mjs`, `public/` and `bin/` ship in the npm package (`files` in `package.json`). A new runtime file must be added there, or it won't be published.

## Rules

- **Privacy:** the app reads people's private chats. Never put real chat content, real personal paths or real screenshots into code, tests, docs or commits. Screenshots come from `npm run demo`.
- **Read-only:** never write to another tool's files. The archive copies Claude Code sessions into Chatshelf's own folder and never changes the originals. The only writes outside Chatshelf's own folders are user-triggered moves and restores of Claude Code sessions (a move always makes a backup first; a restore from the archive never overwrites).
- **MCP:** `mcp.mjs` must stay read-only, and stdout is the protocol: log to stderr only.
- **Security:** keep the server on `127.0.0.1`, keep the `Host` allow-list (`127.0.0.1`, `localhost`, `chatshelf.localhost` and the user's `--host` name, which must end in `.localhost`) and the per-run token on every `/api/` route, and escape everything rendered into HTML.
- **Readers:** a missing or unreadable file means "not found", never a crash. Mark a reader `experimental` until it has been tested on real data. When adding one, follow CONTRIBUTING.md (reader, `TOOLS` and `ASSISTANT` in `app.js`, a colour class, demo data, a smoke test).
- **UI:** warm neutrals, ink `#1C1917` for primary actions, orange `#E8590C` as the one accent, 44px targets, visible focus, `prefers-reduced-motion` respected, SVG icons (no emoji).
- Run `npm run check && npm test` before saying a change works.
