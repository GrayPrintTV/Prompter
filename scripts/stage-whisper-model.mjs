import { cp, mkdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelName = 'base.en';
const repoCacheName = 'models--Systran--faster-whisper-base.en';
const requiredFiles = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];
const targetDir = path.join(root, 'build', 'models', modelName);

function defaultHubCacheDir() {
  if (process.env.HUGGINGFACE_HUB_CACHE?.trim()) return process.env.HUGGINGFACE_HUB_CACHE.trim();
  if (process.env.HF_HOME?.trim()) return path.join(process.env.HF_HOME.trim(), 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function resolveModelSourceDir() {
  const override = process.env.LOCAL_WHISPER_MODEL_SOURCE_DIR?.trim();
  if (override) return path.resolve(override);

  const repoDir = path.join(defaultHubCacheDir(), repoCacheName);
  const refPath = path.join(repoDir, 'refs', 'main');
  if (!existsSync(refPath)) return '';

  const revision = readFileSync(refPath, 'utf8').trim();
  return path.join(repoDir, 'snapshots', revision);
}

async function missingFiles(dir) {
  const missing = [];
  for (const fileName of requiredFiles) {
    try {
      const info = await stat(path.join(dir, fileName));
      if (!info.isFile()) missing.push(fileName);
    } catch {
      missing.push(fileName);
    }
  }
  return missing;
}

async function sameRequiredFiles(sourceDir, destinationDir) {
  for (const fileName of requiredFiles) {
    try {
      const sourceInfo = await stat(path.join(sourceDir, fileName));
      const targetInfo = await stat(path.join(destinationDir, fileName));
      if (!sourceInfo.isFile() || !targetInfo.isFile()) return false;
      if (sourceInfo.size !== targetInfo.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const sourceDir = resolveModelSourceDir();
if (!sourceDir || !existsSync(sourceDir)) {
  console.error('Could not find the cached faster-whisper base.en model.');
  console.error('Run Local Whisper once in development or set LOCAL_WHISPER_MODEL_SOURCE_DIR to a complete local model directory.');
  process.exit(1);
}

const missingSourceFiles = await missingFiles(sourceDir);
if (missingSourceFiles.length > 0) {
  console.error(`Model source is incomplete: ${sourceDir}`);
  console.error(`Missing: ${missingSourceFiles.join(', ')}`);
  process.exit(1);
}

await mkdir(path.dirname(targetDir), { recursive: true });
if (await sameRequiredFiles(sourceDir, targetDir)) {
  console.log(`Reusing staged model: ${path.relative(root, targetDir)}`);
  process.exit(0);
}

await cp(sourceDir, targetDir, {
  recursive: true,
  dereference: true,
  force: true
});

const missingTargetFiles = await missingFiles(targetDir);
if (missingTargetFiles.length > 0) {
  console.error(`Staged model is incomplete: ${targetDir}`);
  console.error(`Missing: ${missingTargetFiles.join(', ')}`);
  process.exit(1);
}

console.log(`Staged Local Whisper model from ${sourceDir}`);
console.log(`Model output: ${path.relative(root, targetDir)}`);
