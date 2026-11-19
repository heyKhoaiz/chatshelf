// Builds the VS Code extension package (vscode/chatshelf-<version>.vsix). Changes nothing else.
// It copies the app files into vscode/app (no transform, so the app itself still has no build
// step), then runs vsce. Publishing is a separate, manual step. Usage: npm run pack:vscode
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, 'vscode');
const APP = path.join(EXT, 'app');

fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(APP);
for (const f of ['core.mjs', 'sources.mjs']) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
fs.cpSync(path.join(ROOT, 'public'), path.join(APP, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(EXT, 'LICENSE'));

execFileSync('npx', ['--yes', '@vscode/vsce@3', 'package', '--no-dependencies'], { cwd: EXT, stdio: 'inherit' });
