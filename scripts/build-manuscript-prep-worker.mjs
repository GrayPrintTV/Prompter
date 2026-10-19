import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonExe = process.env.MANUSCRIPT_PREP_BUILD_PYTHON?.trim() || path.join(root, '.venv', 'Scripts', 'python.exe');
const spec = path.join(root, 'packaging', 'manuscript-prep-worker', 'manuscript-prep-worker.spec');
const source = path.join(root, 'python', 'manuscript_prep_worker.py');
const buildRoot = path.join(root, 'build', 'manuscript-prep-worker');
const output = path.join(buildRoot, 'dist', 'manuscript-prep-worker', 'manuscript-prep-worker.exe');
if (!existsSync(pythonExe)) { console.error(`Manuscript Prep build Python was not found: ${pythonExe}`); process.exit(1); }
if (process.env.PREP_WORKER_ALLOW_REUSE === '1' && existsSync(output) && [spec, source].every((file) => statSync(output).mtimeMs >= statSync(file).mtimeMs)) { console.log(`Reusing Manuscript Prep worker: ${path.relative(root, output)}`); process.exit(0); }
const result = spawnSync(pythonExe, ['-m', 'PyInstaller', '--clean', '--noconfirm', '--distpath', path.join(buildRoot, 'dist'), '--workpath', path.join(buildRoot, 'work'), spec], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.status !== 0 || !existsSync(output)) process.exit(result.status ?? 1);
console.log(`Built Manuscript Prep worker: ${path.relative(root, output)}`);
