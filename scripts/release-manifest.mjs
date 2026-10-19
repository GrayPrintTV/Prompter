import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage, extractFile } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'release', 'win-unpacked'));
const output = path.resolve(process.argv[3] || path.join(root, 'release', 'resource-manifest.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
function walk(folder) {
  for (const e of readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = path.join(folder, e.name);
    if (e.isSymbolicLink()) throw new Error('Release contains a symbolic link');
    if (e.isDirectory()) walk(p);
    else files.push({ path: path.relative(dir, p).replaceAll('\\', '/'), bytes: statSync(p).size, sha256: digest(readFileSync(p)) });
  }
}
walk(dir);
const asar = path.join(dir, 'resources', 'app.asar');
const entries = [];
for (const name of listPackage(asar)) {
  try { const bytes = extractFile(asar, name.replace(/^[/\\]/, '')); entries.push({ path: name.replaceAll('\\','/'), bytes: bytes.length, sha256: digest(bytes) }); }
  catch (error) { if (!String(error).includes('is a directory')) throw error; }
}
const lock = JSON.parse(readFileSync(path.join(root,'package-lock.json'),'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse','HEAD'], { cwd:root, encoding:'utf8' }).trim();
const manifest = { schemaVersion:1, version:lock.version, sourceCommit,
  node:process.version, npmLockSha256:digest(readFileSync(path.join(root,'package-lock.json'))),
  pythonLockSha256:digest(readFileSync(path.join(root,'python','requirements-whisper-lock.txt'))),
  model:JSON.parse(readFileSync(path.join(root,'packaging','model-lock.json'),'utf8')),
  dependencies:Object.entries(lock.packages).filter(([p])=>p).map(([p,v])=>({path:p,version:v.version,integrity:v.integrity,license:v.license})),
  files, asarEntries:entries };
writeFileSync(output, JSON.stringify(manifest,null,2)+'\n');
console.log(`Manifest: ${files.length} files and ${entries.length} archive entries; source ${sourceCommit}`);
