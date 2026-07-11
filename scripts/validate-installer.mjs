import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const installerName = `Prompter-Setup-${packageJson.version}-x64.exe`;
const installerPath = path.join(root, 'release', installerName);
const sidecarDir = path.join(root, 'release', 'win-unpacked', 'resources', 'whisper-sidecar');
const minimumInstallerSizeBytes = 200 * 1024 * 1024;
const gpuFilePattern = /cuda|cudnn|cublas|cufft|curand|cusolver|cusparse|nvidia|rocm|hip/i;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const selfContainedValidation = spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-self-contained-package.mjs')], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true
});
if (selfContainedValidation.status !== 0) {
  fail('Installer validation failed because self-contained package validation failed.');
}

if (!existsSync(installerPath)) {
  fail(`Installer not found: ${path.relative(root, installerPath)}`);
}

const installerSize = statSync(installerPath).size;
if (installerSize < minimumInstallerSizeBytes) {
  fail(`Installer is unexpectedly small: ${installerSize} bytes`);
}

if (!installerName.includes(packageJson.version) || !installerName.includes('x64')) {
  fail(`Installer filename must include version and x64 architecture: ${installerName}`);
}

const pendingDirs = [sidecarDir];
const gpuFiles = [];
while (pendingDirs.length > 0) {
  const currentDir = pendingDirs.pop();
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      pendingDirs.push(entryPath);
    } else if (gpuFilePattern.test(entry.name)) {
      gpuFiles.push(entryPath);
    }
  }
}

if (gpuFiles.length > 0) {
  fail(`GPU/CUDA files were found in the packaged sidecar:\n${gpuFiles.map((file) => `- ${path.relative(root, file)}`).join('\n')}`);
}

console.log('Installer validated:');
console.log(`- ${path.relative(root, installerPath)}`);
console.log(`- ${Math.round((installerSize / 1024 / 1024) * 100) / 100} MiB`);
