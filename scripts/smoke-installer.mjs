import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const installerPath = path.join(root, 'release', `Prompter-Setup-${packageJson.version}-x64.exe`);
const appDataDir = path.join(process.env.APPDATA || '', 'Prompter');
const windowStatePath = path.join(appDataDir, 'window-state.json');
const localStorageMarker = `installer-smoke-${packageJson.version}`;

function fail(message) {
  throw new Error(message);
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'pipe',
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 600000
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${label} failed with status ${result.status}${output ? `:\n${output}` : ''}`);
  }
  return result;
}

function powershell(script, label, options = {}) {
  const powershellExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(powershellExe, ['-NoProfile', '-Command', script], label, options);
}

function walkFiles(dir, predicate, maxDepth = 5, depth = 0) {
  if (!dir || !existsSync(dir) || depth > maxDepth) return [];
  const matches = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...walkFiles(entryPath, predicate, maxDepth, depth + 1));
    } else if (predicate(entryPath)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function findInstalledExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Prompter', 'Prompter.exe'),
    ...walkFiles(path.join(process.env.LOCALAPPDATA || '', 'Programs'), (file) => path.basename(file).toLowerCase() === 'prompter.exe')
  ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function findUninstaller(installedExe) {
  const installDir = path.dirname(installedExe);
  const candidates = walkFiles(installDir, (file) => /^uninstall prompter.*\.exe$/i.test(path.basename(file)), 2);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function findShortcuts() {
  const startMenuRoot = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktopRoots = [
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    path.join(process.env.OneDrive || '', 'Desktop')
  ];
  return {
    startMenu: walkFiles(startMenuRoot, (file) => /^prompter.*\.lnk$/i.test(path.basename(file)), 5),
    desktop: desktopRoots.flatMap((dir) => walkFiles(dir, (file) => /^prompter.*\.lnk$/i.test(path.basename(file)), 1))
  };
}

function stopPrompterProcesses() {
  powershell(
    "Get-Process -Name Prompter -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-Process -Name whisper-sidecar -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0",
    'stop existing Prompter processes'
  );
}

function install(label) {
  run(installerPath, ['/S'], label, { timeout: 900000 });
  const installedExe = findInstalledExe();
  if (!installedExe) fail('Installed Prompter.exe was not found after install.');
  if (statSync(installedExe).size === 0) fail('Installed Prompter.exe is empty.');
  return installedExe;
}

function uninstall(uninstallerPath) {
  run(uninstallerPath, ['/S'], 'uninstall Prompter', { timeout: 600000 });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(predicate, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    sleepSync(500);
  }
  fail(`Timed out waiting for ${label}.`);
}

function launchShortcut(shortcutPath) {
  powershell(`Start-Process -FilePath '${shortcutPath.replace(/'/g, "''")}'`, 'launch Start-menu shortcut');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = powershell(
      "Get-Process -Name Prompter -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
      'check shortcut-launched process'
    );
    if (result.stdout.trim()) return result.stdout.trim();
  }
  fail('Start-menu shortcut did not launch a Prompter process.');
}

function runInstalledAppSmoke(installedExe, env = {}) {
  run(process.execPath, [path.join(root, 'scripts', 'smoke-packaged-app.mjs'), installedExe], 'installed app smoke', {
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 480000
  });
}

function assertRemoved(filePath, label) {
  if (existsSync(filePath)) fail(`${label} was not removed: ${filePath}`);
}

if (!existsSync(installerPath)) {
  fail(`Installer not found: ${installerPath}`);
}

stopPrompterProcesses();

const initialInstalledExe = install('initial silent per-user install');
let shortcuts = findShortcuts();
if (shortcuts.startMenu.length === 0) fail('Start-menu shortcut was not created.');
const shortcutLaunchPath = launchShortcut(shortcuts.startMenu[0]);
stopPrompterProcesses();

runInstalledAppSmoke(initialInstalledExe, { PROMPTER_SMOKE_SET_LOCAL_STORAGE: localStorageMarker });
const savedWindowState = existsSync(windowStatePath) ? readFileSync(windowStatePath, 'utf8') : '';
if (!savedWindowState) fail(`Window state was not written under userData: ${windowStatePath}`);

powershell(`Start-Process -FilePath '${initialInstalledExe.replace(/'/g, "''")}'`, 'launch installed app before reinstall');
install('same-version install while Prompter is open');
stopPrompterProcesses();

install('same-version upgrade/reinstall while closed');
if (!existsSync(windowStatePath)) fail('Window state disappeared after same-version reinstall.');
const afterUpgradeWindowState = readFileSync(windowStatePath, 'utf8');
if (afterUpgradeWindowState !== savedWindowState) fail('Window state changed during installer upgrade/reinstall.');

runInstalledAppSmoke(initialInstalledExe, { PROMPTER_SMOKE_EXPECT_LOCAL_STORAGE: localStorageMarker });

const uninstallerPath = findUninstaller(initialInstalledExe);
if (!uninstallerPath) fail('Generated uninstaller was not found.');
uninstall(uninstallerPath);
stopPrompterProcesses();
waitUntil(() => !existsSync(initialInstalledExe), 'installed executable removal');
waitUntil(() => {
  const currentShortcuts = findShortcuts();
  return currentShortcuts.startMenu.length === 0 && currentShortcuts.desktop.length === 0;
}, 'shortcut removal');
assertRemoved(initialInstalledExe, 'Installed executable');
shortcuts = findShortcuts();
if (shortcuts.startMenu.length > 0) fail(`Start-menu shortcut was not removed: ${shortcuts.startMenu[0]}`);
if (shortcuts.desktop.length > 0) fail(`Desktop shortcut was not removed: ${shortcuts.desktop[0]}`);
if (!existsSync(windowStatePath)) fail('UserData window state was removed on uninstall; expected preservation.');

const reinstalledExe = install('reinstall after uninstall');
shortcuts = findShortcuts();
if (shortcuts.startMenu.length === 0) fail('Start-menu shortcut was not recreated after reinstall.');
runInstalledAppSmoke(reinstalledExe, { PROMPTER_SMOKE_EXPECT_LOCAL_STORAGE: localStorageMarker });

console.log('Installer smoke test passed:');
console.log(`- installer: ${installerPath}`);
console.log(`- initial installed exe: ${initialInstalledExe}`);
console.log(`- Start-menu shortcut launch path: ${shortcutLaunchPath}`);
console.log(`- desktop shortcuts: ${shortcuts.desktop.length ? shortcuts.desktop.join('; ') : 'not found during silent install'}`);
console.log(`- uninstaller: ${uninstallerPath}`);
console.log(`- userData preserved: ${windowStatePath}`);
console.log(`- reinstalled exe: ${reinstalledExe}`);
