import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(root, 'android');
const wrapper = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const task = process.argv[2];
if (!task) throw new Error('An Android Gradle task is required.');
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return ''; }
};
const environment = {
  ...process.env,
  PROMPTER_ANDROID_BUILD_TIMESTAMP: new Date().toISOString(),
  PROMPTER_ANDROID_GIT_HASH: git('rev-parse', '--short=12', 'HEAD') || 'unavailable',
  PROMPTER_ANDROID_GIT_DIRTY: String(Boolean(git('status', '--porcelain')))
};
const result = spawnSync(wrapper, [task, '--stacktrace'], {
  cwd: androidRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: environment
});
process.exit(result.status ?? 1);
