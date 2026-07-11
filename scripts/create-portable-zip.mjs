import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'release', 'win-unpacked');
const zipPath = path.join(root, 'release', 'Prompter-win-unpacked.zip');

if (!existsSync(sourceDir)) {
  console.error(`Unpacked package directory not found: ${sourceDir}`);
  process.exit(1);
}

if (existsSync(zipPath)) {
  rmSync(zipPath, { force: true });
}

const command = [
  '$ErrorActionPreference = "Stop"',
  `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
].join('; ');

const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(zipPath)) {
  console.error(`Portable ZIP was not created: ${zipPath}`);
  process.exit(1);
}

console.log(`Created portable ZIP: ${path.relative(root, zipPath)}`);
