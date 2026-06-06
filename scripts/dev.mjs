import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const nodeModuleScript = (...segments) => path.join(root, 'node_modules', ...segments);
const electronBinary = isWindows
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', '.bin', 'electron');
const children = [];

function buildEnv(extraEnv = {}) {
  const merged = { ...process.env, ...extraEnv };
  if (!isWindows) return merged;

  const pathValue = merged.Path ?? merged.PATH ?? merged.path;
  const normalized = {};
  for (const [key, value] of Object.entries(merged)) {
    if (key.toLowerCase() !== 'path') {
      normalized[key] = value;
    }
  }
  if (pathValue) {
    normalized.Path = pathValue;
  }
  return normalized;
}

function spawnLogged(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: buildEnv(extraEnv),
    stdio: 'inherit',
    shell: false
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
    }
  });
  children.push(child);
  return child;
}

async function waitForFile(filePath, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(filePath)) {
      try {
        await access(filePath);
        return;
      } catch {
        // Try again while TypeScript is still writing.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(600, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

spawnLogged('renderer', process.execPath, [
  nodeModuleScript('vite', 'bin', 'vite.js'),
  '--host',
  '127.0.0.1',
  '--port',
  '5173'
]);
spawnLogged('electron-tsc', process.execPath, [
  nodeModuleScript('typescript', 'bin', 'tsc'),
  '-p',
  'tsconfig.electron.json',
  '--watch',
  '--preserveWatchOutput'
]);

await Promise.all([
  waitForPort(5173),
  waitForFile(path.join(root, 'dist-electron', 'main.js'))
]);

spawnLogged('electron', electronBinary, ['.'], {
  VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173'
});
