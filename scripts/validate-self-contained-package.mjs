import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(root, 'release', 'win-unpacked');
const resourcesDir = path.join(packageDir, 'resources');
const sidecarDir = path.join(resourcesDir, 'whisper-sidecar');
const sidecarExe = path.join(sidecarDir, 'whisper-sidecar.exe');
const modelDir = path.join(resourcesDir, 'models', 'base.en');
const requiredModelFiles = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];

const requiredPaths = [
  path.join(packageDir, 'Prompter.exe'),
  path.join(resourcesDir, 'app.asar'),
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

console.log('Self-contained package resources validated:');
console.log(`- ${path.relative(root, sidecarExe)}`);
console.log(`- ${path.relative(root, modelDir)}`);
