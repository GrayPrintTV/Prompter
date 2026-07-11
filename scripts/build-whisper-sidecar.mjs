import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonExe = process.env.LOCAL_WHISPER_BUILD_PYTHON?.trim() ||
  path.join(root, '.venv', 'Scripts', 'python.exe');
const specPath = path.join(root, 'packaging', 'whisper-sidecar', 'whisper-sidecar.spec');
const sidecarSource = path.join(root, 'python', 'local_whisper_sidecar.py');
const lockFile = path.join(root, 'python', 'requirements-whisper-lock.txt');
const buildRoot = path.join(root, 'build', 'whisper-sidecar');
const distPath = path.join(buildRoot, 'dist');
const workPath = path.join(buildRoot, 'work');
const outputExe = path.join(distPath, 'whisper-sidecar', 'whisper-sidecar.exe');

function newerThanInputs(output, inputs) {
  if (!existsSync(output)) return false;
  const outputTime = statSync(output).mtimeMs;
  return inputs.every((input) => existsSync(input) && outputTime >= statSync(input).mtimeMs);
}

if (!existsSync(pythonExe)) {
  console.error(`Local Whisper build Python was not found: ${pythonExe}`);
  console.error('Create/use the project .venv or set LOCAL_WHISPER_BUILD_PYTHON to the locked Python environment.');
  process.exit(1);
}

if (process.env.WHISPER_SIDECAR_FORCE_REBUILD !== '1' && newerThanInputs(outputExe, [specPath, sidecarSource, lockFile])) {
  console.log(`Reusing existing Local Whisper sidecar: ${path.relative(root, outputExe)}`);
  process.exit(0);
}

const result = spawnSync(
  pythonExe,
  [
    '-m',
    'PyInstaller',
    '--clean',
    '--noconfirm',
    '--distpath',
    distPath,
    '--workpath',
    workPath,
    specPath
  ],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(outputExe)) {
  console.error(`PyInstaller completed but did not create ${outputExe}`);
  process.exit(1);
}

console.log(`Built Local Whisper sidecar: ${path.relative(root, outputExe)}`);
