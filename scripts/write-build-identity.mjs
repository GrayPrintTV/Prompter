import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const git = args => execFileSync('git', args, { encoding:'utf8', windowsHide:true }).trim();
if (git(['status','--porcelain','--untracked-files=no'])) throw new Error('Commit the reviewed source before writing release identity.');
const hash = name => createHash('sha256').update(readFileSync(name)).digest('hex');
mkdirSync('build', { recursive:true });
writeFileSync(path.join('build','build-identity.json'), JSON.stringify({
  version:JSON.parse(readFileSync('package.json','utf8')).version,
  sourceCommit:git(['rev-parse','HEAD']), sourceDate:git(['show','-s','--format=%cI','HEAD']),
  npmLockSha256:hash('package-lock.json'), pythonLockSha256:hash('python/requirements-whisper-lock.txt'), modelLockSha256:hash('packaging/model-lock.json')
},null,2)+'\n');
