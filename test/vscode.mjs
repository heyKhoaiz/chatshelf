// Runs the VS Code extension test (vscode/test/run.cjs) in a throwaway VS Code window against demo data.
// Needs VS Code installed. Run: npm run test:vscode   (set VSCODE_BIN to use another build, e.g. Cursor)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDemoHome } from './demo-data.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidates = [process.env.VSCODE_BIN, '/usr/share/code/code', '/usr/bin/code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'];
const code = candidates.find((b) => b && fs.existsSync(b));
if (!code) { console.log('VS Code not found, skipping. Set VSCODE_BIN to its executable.'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatshelf-vscode-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
makeDemoHome(home);
// Stand-ins for the claude and codex commands, so terminals open without the real tools.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "fake $0 $@"\n', { mode: 0o755 });
// TMPDIR inside the throwaway folder, so handoff files are removed with it.
const env = { ...process.env, HOME: home, TMPDIR: tmp, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI']) delete env[k];

const p = spawn(code, [
  '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext'),
  '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window',
  `--extensionDevelopmentPath=${path.join(ROOT, 'vscode')}`, `--extensionTestsPath=${path.join(ROOT, 'vscode', 'test', 'run.cjs')}`,
], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
p.stdout.on('data', (c) => { log += c; process.stdout.write(String(c).split('\n').filter((l) => /^\s+ok\s|Error|assert/i.test(l)).map((l) => l + '\n').join('')); });
p.stderr.on('data', (c) => { log += c; });
p.on('close', (code) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (code !== 0) { console.error(log.split('\n').slice(-40).join('\n')); console.error(`\nVS Code extension test FAILED (exit ${code})`); }
  else console.log('\nVS Code extension test passed');
  process.exit(code ?? 1);
});
