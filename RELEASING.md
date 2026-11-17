# Releasing Chatshelf

Chatshelf is published on npm as [`chatshelf`](https://www.npmjs.com/package/chatshelf). Users get new versions with `npx chatshelf@latest` or `npm update -g chatshelf`, so a release reaches them right away.

This guide is for maintainers. One command does the whole release: it runs the tests, bumps the version, publishes to npm, pushes to GitHub, and creates a GitHub release with notes.

## One-time setup

1. **npm account with 2FA.** npm only lets accounts with two-factor authentication publish. Turn it on at npmjs.com → avatar → **Account** → **Two-Factor Authentication**, choose **Authorization and writes**, and keep the recovery codes.
2. **Sign in on your machine:**
   ```bash
   npm login            # opens the browser
   npm whoami           # should print your npm username
   ```
3. **GitHub CLI** (for the GitHub release step):
   ```bash
   gh auth login
   ```
   Without it, the release still publishes to npm and pushes to GitHub. You then create the GitHub release on github.com.
4. You need publish rights on the `chatshelf` npm package and push rights on `heyKhoaiz/chatshelf`. Check with `npm access list collaborators chatshelf`.

Coding agents working in this repo must not publish or release unless the maintainer asks; see [AGENTS.md](AGENTS.md).

## Pick the version

Chatshelf follows [semantic versioning](https://semver.org):

| Change | Command | Example |
| --- | --- | --- |
| Bug fixes only | `npm run release -- patch` | 0.1.0 → 0.1.1 |
| New features, nothing breaks | `npm run release -- minor` | 0.1.0 → 0.2.0 |
| Breaking changes (removed options, changed data folders…) | `npm run release -- major` | 0.1.0 → 1.0.0 |
| An exact version | `npm run release -- 0.3.0` | → 0.3.0 |

## Release

```bash
git switch main
git pull
npm run release -- patch --dry-run   # optional: run every check, change nothing
npm run release -- patch
```

The command:

1. Checks you're on `main` with no uncommitted changes and nothing new on GitHub.
2. Checks you're signed in to npm (and to `gh`, if it's installed).
3. Runs `npm run check` and `npm test`. It stops if anything fails.
4. Bumps the version in `package.json`, commits `chore: release vX.Y.Z` and tags `vX.Y.Z`. This happens locally only.
5. Runs `npm publish`. **npm asks you to confirm with 2FA**: press Enter to open the browser, or type the one-time code.
6. Pushes the commit and the tag to GitHub.
7. Creates a GitHub release for the tag, with notes generated from the commits since the last release.

If the tests or `npm publish` fail, the command removes its local commit and tag, so you can fix the problem and run it again. Nothing becomes public until step 5.

New versions can take a minute or two to show up on npm. Meanwhile, npm may list a placeholder version `0.0.0-stage`; that's normal.

## Check the release

```bash
npm view chatshelf version            # the new version
npx chatshelf@latest --no-open        # runs the published package
```

Then look at the release page: https://github.com/heyKhoaiz/chatshelf/releases

## Write good release notes

The notes come from commit messages, so use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add Windsurf reader`, a new feature
- `fix: Cursor chats without a folder no longer crash the list`, a bug fix
- `docs:`, `ci:`, `chore:`, everything else

To edit the notes after a release, open the release on GitHub and click **Edit**.

## Something went wrong

| Problem | Fix |
| --- | --- |
| `403 … Two-factor authentication … is required` | Turn on 2FA for **Authorization and writes** (see setup), then run the release again. |
| `ENEEDAUTH` / not signed in | `npm login` |
| `EOTP` / `Not running in an interactive terminal` | Run the release in your own terminal window, so npm can ask for your 2FA confirmation. Scripts, CI and AI agents can't answer that prompt. |
| `You're on "some-branch"` | `git switch main && git pull` |
| `You have uncommitted changes` | Commit or stash them: `git status` |
| Published to npm, but `git push` failed | `git push --follow-tags origin main`, then `gh release create vX.Y.Z --generate-notes` |
| Published a broken version | Release a fixed version (`npm run release -- patch`). You can also mark the bad one: `npm deprecate chatshelf@X.Y.Z "Broken, please update"`. `npm unpublish` only works within 72 hours, and a version number can never be reused. |
