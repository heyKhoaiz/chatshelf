// Runs Chatshelf against a fresh fake home folder full of demo chats.
// Your real chats are not read. Usage: npm run demo
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDemoHome } from '../test/demo-data.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = path.join(os.tmpdir(), 'chatshelf-demo');
fs.rmSync(home, { recursive: true, force: true });
makeDemoHome(home);
const env = { ...process.env, HOME: home, PORT: process.env.PORT || '4318' };
for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'APPDATA']) delete env[k];
console.log(`Demo data: ${home}`);
spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server.mjs'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
