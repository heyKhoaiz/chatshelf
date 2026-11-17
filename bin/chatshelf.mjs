#!/usr/bin/env node
// Starts Chatshelf. Re-runs Node with the SQLite "experimental" warning hidden.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const port = process.env.PORT || '4317';

if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Chatshelf ${version}: one place for your AI coding chats

Usage
  chatshelf              start and open http://chatshelf.localhost:${port}
                         (if it's already running, this just opens the browser)
  chatshelf --no-open    start without opening the browser
  chatshelf --version    print the version
  chatshelf --help       show this help

Settings (environment variables)
  PORT=5000                  use another port
  CHATSHELF_TERMINAL=kitty   terminal for "Open in terminal"

Stop it with Ctrl+C. If the address doesn't open in your browser, use http://127.0.0.1:${port}.
Docs: https://github.com/heyKhoaiz/chatshelf`);
  process.exit(0);
}

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`Chatshelf needs Node.js 22.5 or newer. You have ${process.versions.node}. Get it at https://nodejs.org`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server.mjs'), ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
