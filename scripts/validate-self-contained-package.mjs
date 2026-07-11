import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'release', 'win-unpacked');
const resourcesDir = path.join(packageDir, 'resources');
const sidecarDir = path.join(resourcesDir, 'whisper-sidecar');
const sidecarExe = path.join(sidecarDir, 'whisper-sidecar.exe');
const modelDir = path.join(resourcesDir, 'models', 'base.en');
const requiredModelFiles = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];
const gpuFilePattern = /cuda|cudnn|cublas|cufft|curand|cusolver|cusparse|nvidia|rocm|hip/i;

const requiredPaths = [
  path.join(packageDir, 'Prompter.exe'),
  path.join(resourcesDir, 'app.asar'),
  path.join(resourcesDir, 'THIRD_PARTY_NOTICES.md'),
  sidecarExe,
  modelDir,
  ...requiredModelFiles.map((fileName) => path.join(modelDir, fileName))
];

const missing = requiredPaths.filter((entry) => !existsSync(entry));
if (missing.length > 0) {
  console.error('Self-contained package validation failed. Missing:');
  for (const entry of missing) {
    console.error(`- ${path.relative(root, entry)}`);
  }
  process.exit(1);
}

const sidecarSize = statSync(sidecarExe).size;
const modelSize = statSync(path.join(modelDir, 'model.bin')).size;
if (sidecarSize === 0 || modelSize === 0) {
  console.error('Self-contained package validation failed: sidecar executable or model.bin is empty.');
  process.exit(1);
}

const sidecarEntries = [];
const pendingDirs = [sidecarDir];
while (pendingDirs.length > 0) {
  const currentDir = pendingDirs.pop();
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      pendingDirs.push(entryPath);
    } else {
      sidecarEntries.push(entryPath);
    }
  }
}

const gpuFiles = sidecarEntries.filter((entry) => gpuFilePattern.test(path.basename(entry)));
if (gpuFiles.length > 0) {
  console.error('Self-contained package validation failed: GPU/CUDA files were found in the sidecar:');
  for (const entry of gpuFiles) {
    console.error(`- ${path.relative(root, entry)}`);
  }
  process.exit(1);
}

console.log('Self-contained package resources validated:');
console.log(`- ${path.relative(root, sidecarExe)}`);
console.log(`- ${path.relative(root, modelDir)}`);
