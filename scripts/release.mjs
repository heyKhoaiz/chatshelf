// Release Chatshelf in one command: checks, tests, version bump, npm publish, git push, GitHub release.
//
//   npm run release -- patch          0.1.0 -> 0.1.1  (fixes)
//   npm run release -- minor          0.1.0 -> 0.2.0  (new features)
//   npm run release -- major          0.1.0 -> 1.0.0  (breaking changes)
//   npm run release -- 0.3.0          an exact version
//   npm run release -- patch --dry-run   run every check, change nothing
//
// See RELEASING.md for the full guide.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--'));
const REPO = 'heyKhoaiz/chatshelf';

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m` };
const step = (msg) => console.log(`\n${c.bold('›')} ${msg}`);
const ok = (msg) => console.log(`  ${c.green('✓')} ${msg}`);
const fail = (msg, hint) => { console.error(`\n${c.red('✗')} ${msg}`); if (hint) console.error(c.dim(`  ${hint}`)); process.exit(1); };

// Run a command. `capture` returns trimmed stdout; otherwise output streams to the terminal.
function run(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 && !allowFail) {
    if (capture && r.stderr) console.error(c.dim(r.stderr.trim()));
    fail(`${cmd} ${cmdArgs.join(' ')} failed`);
  }
  return capture ? (r.stdout || '').trim() : r.status;
}
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump)) {
  console.log(`Usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run]

  patch   bug fixes            0.1.0 -> 0.1.1
  minor   new features         0.1.0 -> 0.2.0
  major   breaking changes     0.1.0 -> 1.0.0`);
  process.exit(bump ? 1 : 0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(c.bold(`Chatshelf release${dry ? c.yellow(' (dry run: nothing will change)') : ''}`));
console.log(c.dim(`current version ${pkg.version}, bump: ${bump}`));

// 1. Preconditions
step('Checking git');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
if (branch !== 'main') fail(`You're on "${branch}". Releases are made from main.`, 'git switch main && git pull');
if (run('git', ['status', '--porcelain'], { capture: true })) fail('You have uncommitted changes.', 'Commit or stash them first: git status');
run('git', ['fetch', '--quiet', 'origin', 'main'], { capture: true });
const behind = Number(run('git', ['rev-list', '--count', 'HEAD..origin/main'], { capture: true }));
if (behind > 0) fail(`main is ${behind} commit(s) behind GitHub.`, 'git pull');
ok('on main, clean, up to date with GitHub');

step('Checking npm and GitHub access');
const npmUser = run('npm', ['whoami'], { capture: true, allowFail: true });
if (!npmUser) fail('Not signed in to npm.', 'Run: npm login');
ok(`npm: signed in as ${npmUser}`);
const ghReady = has('gh') && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
ok(ghReady ? 'GitHub CLI: signed in (a GitHub release will be created)' : c.yellow('GitHub CLI not available: skipping the GitHub release (create it on github.com later)'));

// 2. Quality gate
step('Running checks and tests');
run('npm', ['run', '-s', 'check']);
run('npm', ['test', '--silent']);
ok('syntax check and smoke tests passed');

// Work out the next version without touching package.json.
const nextVersion = (cur, how) => {
  if (/^\d/.test(how)) return how;
  const [ma, mi, pa] = cur.split('-')[0].split('.').map(Number);
  return how === 'major' ? `${ma + 1}.0.0` : how === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
};
const next = nextVersion(pkg.version, bump);
if (dry) {
  console.log(`\n${c.green('Dry run finished.')} A real run would publish ${c.bold(`chatshelf@${next}`)}, push the tag v${next} and create a GitHub release.`);
  process.exit(0);
}

// npm needs the maintainer's 2FA confirmation (browser or one-time code), which only works in a real terminal.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  fail('Not running in an interactive terminal, so npm could not ask for your 2FA confirmation.', 'Run the same command yourself in a terminal window. Nothing was changed.');
}

// 3. Version bump: makes a commit and a tag, locally only
step(`Bumping version (${bump})`);
const version = run('npm', ['version', bump, '-m', 'chore: release v%s'], { capture: true }).replace(/^v/, '');
const tag = `v${version}`;
ok(`version ${version}, commit and tag ${tag} created`);

// Undo the local bump if a later step fails before anything is public.
const rollback = (why) => {
  console.error(`\n${c.red('✗')} ${why}`);
  console.error(c.dim(`  Undoing the local version bump (tag ${tag} and its commit). Nothing was published.`));
  run('git', ['tag', '-d', tag], { capture: true, allowFail: true });
  run('git', ['reset', '--hard', 'HEAD~1'], { capture: true, allowFail: true });
  process.exit(1);
};

// 4. Publish to npm (npm asks for 2FA in the browser or for a one-time code)
step(`Publishing chatshelf@${version} to npm`);
console.log(c.dim('  npm will ask you to confirm with 2FA (browser or one-time code).'));
if (run('npm', ['publish'], { allowFail: true }) !== 0) rollback('npm publish failed.');
ok(`published chatshelf@${version}`);

// 5. Push commit and tag
step('Pushing to GitHub');
if (run('git', ['push', '--follow-tags', 'origin', 'main'], { allowFail: true }) !== 0) {
  fail('git push failed, but the npm package IS published.', `Fix the problem, then run: git push --follow-tags origin main`);
}
ok(`pushed main and ${tag}`);

// 6. GitHub release with notes generated from the commits
if (ghReady) {
  step('Creating the GitHub release');
  const st = run('gh', ['release', 'create', tag, '--repo', REPO, '--title', tag, '--generate-notes', '--verify-tag'], { allowFail: true });
  if (st === 0) ok(`release ${tag} created`);
  else console.log(c.yellow(`  Could not create the release. Do it later: gh release create ${tag} --generate-notes`));
}

console.log(`\n${c.green('Released')} ${c.bold(`chatshelf@${version}`)}
  npm:     https://www.npmjs.com/package/chatshelf/v/${version}
  GitHub:  https://github.com/${REPO}/releases/tag/${tag}
  Try it:  npx chatshelf@${version}`);
