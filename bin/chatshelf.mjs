#!/usr/bin/env node
// Starts Chatshelf. Re-runs Node with the SQLite "experimental" warning hidden.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'server.mjs');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', server, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
