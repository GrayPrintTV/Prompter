import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appExe = path.resolve(process.argv[2] || path.join(root, 'release', 'win-unpacked', 'Prompter.exe'));
const remotePort = Number(process.env.PROMPTER_SMOKE_CDP_PORT || 9231);
const localStorageSmokeKey = 'prompterInstallerSmokeLocalStorage';
const localStorageSeed = process.env.PROMPTER_SMOKE_SET_LOCAL_STORAGE || '';
const expectedLocalStorageValue = process.env.PROMPTER_SMOKE_EXPECT_LOCAL_STORAGE || '';
const localWhisperSettings = {
  pythonExecutablePath: 'C:\\definitely-not-python\\python.exe',
  modelName: 'not-used-in-packaged-mode',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 2
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out opening CDP websocket.')), 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('CDP websocket failed to open.'));
    }, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) {
      waiter.reject(new Error(`${waiter.method} failed: ${message.error.message}`));
    } else {
      waiter.resolve(message.result);
    }
  });

  function send(method, params = {}) {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out.`));
      }, 240000);
      pending.set(id, { method, resolve, reject, timeout });
    });
  }

  return {
    send,
    close() {
      socket.close();
    }
  };
}

async function evaluate(cdp, expression, timeoutMs = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed.');
  }
  return result.result?.value;
}

async function waitForRendererReady(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    lastState = await evaluate(cdp, 'document.readyState').catch(() => 'unavailable');
    if (lastState === 'interactive' || lastState === 'complete') return lastState;
    await delay(500);
  }
  const detail = await evaluate(cdp, '({ readyState: document.readyState, url: location.href, title: document.title })')
    .catch(() => ({ readyState: lastState, url: 'unavailable', title: 'unavailable' }));
  throw new Error(`Renderer did not load: ${JSON.stringify(detail)}`);
}

function makeRestrictedEnv(tempRoot) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    ...process.env,
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: path.join(tempRoot, 'temp'),
    TMP: path.join(tempRoot, 'temp'),
    PATH: [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
    HF_HOME: path.join(tempRoot, 'hf-home'),
    HUGGINGFACE_HUB_CACHE: path.join(tempRoot, 'hf-hub'),
    TRANSFORMERS_CACHE: path.join(tempRoot, 'transformers-cache'),
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    NO_COLOR: '1'
  };
}

function processTree(rootPid) {
  const script = `
$all = Get-CimInstance Win32_Process
$seen = @{}
$queue = @(${rootPid})
$desc = @()
while ($queue.Count -gt 0) {
  $parent = $queue[0]
  if ($queue.Count -gt 1) { $queue = $queue[1..($queue.Count - 1)] } else { $queue = @() }
  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
    if (-not $seen.ContainsKey([string]$child.ProcessId)) {
      $seen[[string]$child.ProcessId] = $true
      $desc += $child
      $queue += $child.ProcessId
    }
  }
}
$desc | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 4
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function namedProcesses() {
  const script = `
Get-CimInstance Win32_Process -Filter "Name = 'whisper-sidecar.exe' OR Name = 'python.exe' OR Name = 'node.exe'" |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine |
  ConvertTo-Json -Depth 4
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    const fallback = spawnSync(powershell, [
      '-NoProfile',
      '-Command',
      "Get-Process -Name whisper-sidecar,python,node -ErrorAction SilentlyContinue | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='Name';Expression={$_.ProcessName + '.exe'}},Path | ConvertTo-Json -Depth 3"
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    if (fallback.status !== 0 || !fallback.stdout.trim()) return [];
    const fallbackParsed = JSON.parse(fallback.stdout);
    return Array.isArray(fallbackParsed) ? fallbackParsed : [fallbackParsed];
  }
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function visibleConsoleWindows(processes) {
  const consoleProcessIds = processes
    .filter((item) => /^(conhost|cmd|powershell|pwsh)\.exe$/i.test(String(item.Name)))
    .map((item) => Number(item.ProcessId))
    .filter(Number.isInteger);
  if (consoleProcessIds.length === 0) return [];

  const script = `
Get-Process -Id ${consoleProcessIds.join(',')} -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object Id,ProcessName,MainWindowTitle,MainWindowHandle |
  ConvertTo-Json -Depth 4
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function launchApp(tempRoot, port = remotePort) {
  const env = makeRestrictedEnv(tempRoot);
  const proc = spawn(appExe, [`--remote-debugging-port=${port}`], {
    cwd: tempRoot,
    env,
    stdio: 'ignore',
    windowsHide: true
  });
  const targets = await waitForJson(`http://127.0.0.1:${port}/json`, 60000);
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || targets[0];
  assert(target?.webSocketDebuggerUrl, 'No debuggable Electron renderer target was exposed.');
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  return { proc, cdp, target, env };
}

async function closeApp(proc, cdp) {
  try {
    await evaluate(cdp, 'window.close()');
  } catch {
    try {
      await cdp.send('Browser.close');
    } catch {
      proc.kill();
    }
  }
  const deadline = Date.now() + 15000;
  while (!proc.killed && proc.exitCode === null && Date.now() < deadline) {
    await delay(250);
  }
  if (proc.exitCode === null) proc.kill();
  cdp.close();
}

if (!existsSync(appExe)) {
  console.error(`Packaged executable not found: ${appExe}`);
  process.exit(1);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'prompter-packaged-app-smoke-'));
await mkdir(path.join(tempRoot, 'temp'), { recursive: true });
await mkdir(path.join(tempRoot, 'user'), { recursive: true });
await mkdir(path.join(tempRoot, 'hf-home'), { recursive: true });
await mkdir(path.join(tempRoot, 'hf-hub'), { recursive: true });
await mkdir(path.join(tempRoot, 'transformers-cache'), { recursive: true });

let firstLaunch;
let secondLaunch;

try {
  firstLaunch = await launchApp(tempRoot, remotePort);
  const { proc, cdp, target, env } = firstLaunch;
  const readyState = await waitForRendererReady(cdp);
  if (expectedLocalStorageValue) {
    const observedValue = await evaluate(cdp, `localStorage.getItem(${JSON.stringify(localStorageSmokeKey)})`);
    assert(
      observedValue === expectedLocalStorageValue,
      `localStorage marker was not preserved. Expected ${JSON.stringify(expectedLocalStorageValue)}, observed ${JSON.stringify(observedValue)}.`
    );
  }
  if (localStorageSeed) {
    const storedValue = await evaluate(
      cdp,
      `(() => { localStorage.setItem(${JSON.stringify(localStorageSmokeKey)}, ${JSON.stringify(localStorageSeed)}); return localStorage.getItem(${JSON.stringify(localStorageSmokeKey)}); })()`
    );
    assert(storedValue === localStorageSeed, 'localStorage marker could not be written.');
  }
  const expectedRestartStorageValue = localStorageSeed || expectedLocalStorageValue;

  const bridgeFunctions = await evaluate(cdp, `({
    openManuscriptFile: typeof window.prompterApi?.openManuscriptFile,
    openTextFile: typeof window.prompterApi?.openTextFile,
    startLocalWhisper: typeof window.prompterApi?.startLocalWhisper,
    transcribeLocalWhisperChunk: typeof window.prompterApi?.transcribeLocalWhisperChunk
  })`);
  assert(bridgeFunctions.openManuscriptFile === 'function', 'Manuscript import bridge is missing.');
  assert(bridgeFunctions.openTextFile === 'function', 'Text import bridge is missing.');
  assert(bridgeFunctions.startLocalWhisper === 'function', 'Local Whisper start bridge is missing.');
  assert(bridgeFunctions.transcribeLocalWhisperChunk === 'function', 'Local Whisper transcribe bridge is missing.');

  const diagnostics = await evaluate(cdp, '(async () => await window.prompterApi.getBridgeDiagnostics())()');
  assert(diagnostics.localWhisperUsesBundledSidecar === true, 'Packaged diagnostics did not report bundled sidecar use.');
  const normalizedSidecarPath = String(diagnostics.localWhisperSidecarExecutablePath).replaceAll('/', '\\').toLowerCase();
  const normalizedModelPath = String(diagnostics.localWhisperModelPath).replaceAll('/', '\\').toLowerCase();
  assert(normalizedSidecarPath.endsWith('resources\\whisper-sidecar\\whisper-sidecar.exe'), `Diagnostics did not report the bundled sidecar executable path: ${diagnostics.localWhisperSidecarExecutablePath}`);
  assert(normalizedModelPath.endsWith('resources\\models\\base.en'), `Diagnostics did not report the bundled model path: ${diagnostics.localWhisperModelPath}`);
  assert(!String(diagnostics.cwd).toLowerCase().startsWith(root.toLowerCase()), `App cwd unexpectedly used the source repo: ${diagnostics.cwd}`);

  const firstBounds = await evaluate(cdp, `(() => {
    window.moveTo(120, 120);
    window.resizeTo(1234, 812);
    return { outerWidth: window.outerWidth, outerHeight: window.outerHeight };
  })()`);
  await delay(1000);

  const startStatus = await evaluate(
    cdp,
    `(async () => await window.prompterApi.startLocalWhisper(${JSON.stringify(localWhisperSettings)}))()`,
    240000
  );
  assert(startStatus.modelPhase === 'ready', `Local Whisper did not become ready: ${startStatus.errorMessage || startStatus.modelPhase}`);
  const runningDiagnostics = await evaluate(cdp, '(async () => await window.prompterApi.getBridgeDiagnostics())()');
  assert(
    Number.isInteger(runningDiagnostics.localWhisperSidecarProcessId) &&
      runningDiagnostics.localWhisperSidecarProcessId > 0,
    `Electron main did not report a running sidecar process id: ${JSON.stringify(runningDiagnostics)}`
  );

  const treeDuringWhisper = processTree(proc.pid);
  const namedDuringWhisper = namedProcesses();
  const observedProcesses = treeDuringWhisper.length > 0 ? treeDuringWhisper : namedDuringWhisper;
  if (observedProcesses.length > 0) {
    assert(
      observedProcesses.some((item) => String(item.Name).toLowerCase() === 'whisper-sidecar.exe'),
      `Bundled whisper-sidecar.exe was not found while Local Whisper was ready. Observed: ${JSON.stringify(observedProcesses)}`
    );
    assert(
      !observedProcesses.some((item) => String(item.Name).toLowerCase() === 'python.exe'),
      `Packaged app spawned python.exe. Observed: ${JSON.stringify(observedProcesses)}`
    );
    assert(
      !observedProcesses.some((item) => String(item.Name).toLowerCase() === 'node.exe'),
      `Packaged app spawned node.exe. Observed: ${JSON.stringify(observedProcesses)}`
    );
    const visibleConsoleDescendants = visibleConsoleWindows(observedProcesses);
    assert(
      visibleConsoleDescendants.length === 0,
      `Packaged app exposed a visible console window. Observed: ${JSON.stringify(visibleConsoleDescendants)}`
    );
  }

  const transcript = await evaluate(cdp, `(async () => {
    const sampleRate = 16000;
    const durationSeconds = 0.75;
    const samples = Math.floor(sampleRate * durationSeconds);
    const bytesPerSample = 2;
    const dataSize = samples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    function text(offset, value) {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    }
    text(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let index = 0; index < samples; index += 1) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.15 * 32767);
      view.setInt16(44 + index * bytesPerSample, value, true);
    }
    return await window.prompterApi.transcribeLocalWhisperChunk({
      audioData: buffer,
      mimeType: 'audio/wav',
      format: 'wav',
      extension: 'wav',
      sampleRate,
      durationSeconds,
      settings: ${JSON.stringify(localWhisperSettings)}
    });
  })()`, 180000);
  assert(typeof transcript.text === 'string', 'Packaged app transcription did not return a text field.');

  const stoppedStatus = await evaluate(cdp, '(async () => await window.prompterApi.stopLocalWhisper())()', 30000);
  assert(stoppedStatus.modelPhase === 'stopped', 'Local Whisper did not stop cleanly.');
  await closeApp(proc, cdp);

  const userDataDir = path.dirname(diagnostics.localWhisperSidecarWorkingDirectory);
  const windowStatePath = path.join(userDataDir, 'window-state.json');
  assert(existsSync(windowStatePath), `Window state file was not written: ${windowStatePath}`);
  const savedWindowState = JSON.parse(readFileSync(windowStatePath, 'utf8'));
  assert(savedWindowState.normalBounds?.width >= 1080, 'Saved window width was invalid.');
  assert(savedWindowState.normalBounds?.height >= 720, 'Saved window height was invalid.');

  secondLaunch = await launchApp(tempRoot, remotePort + 1);
  await waitForRendererReady(secondLaunch.cdp);
  if (expectedRestartStorageValue) {
    const restoredValue = await evaluate(secondLaunch.cdp, `localStorage.getItem(${JSON.stringify(localStorageSmokeKey)})`);
    assert(
      restoredValue === expectedRestartStorageValue,
      `localStorage marker was not restored after restart. Expected ${JSON.stringify(expectedRestartStorageValue)}, observed ${JSON.stringify(restoredValue)}.`
    );
  }
  const secondBounds = await evaluate(secondLaunch.cdp, '({ outerWidth: window.outerWidth, outerHeight: window.outerHeight })');
  await closeApp(secondLaunch.proc, secondLaunch.cdp);

  console.log('Packaged app smoke test passed:');
  console.log(`- executable: ${appExe}`);
  console.log(`- renderer readyState: ${readyState}`);
  console.log(`- bundled sidecar: ${diagnostics.localWhisperSidecarExecutablePath}`);
  console.log(`- bundled model: ${diagnostics.localWhisperModelPath}`);
  console.log(`- working cwd: ${diagnostics.cwd}`);
  console.log(`- restricted PATH: ${env.PATH}`);
  console.log(`- cache roots: ${env.HF_HOME}; ${env.HUGGINGFACE_HUB_CACHE}`);
  console.log(`- sidecar process id: ${runningDiagnostics.localWhisperSidecarProcessId}`);
  console.log(`- observed processes while listening: ${observedProcesses.length ? observedProcesses.map((item) => item.Name).join(', ') : 'process enumeration unavailable'}`);
  console.log(`- actual audio request processed: yes`);
  console.log(`- transcript text: ${JSON.stringify(transcript.text || '')}`);
  console.log(`- requested launch bounds: ${JSON.stringify(firstBounds)}`);
  console.log(`- window state file: ${windowStatePath}`);
  console.log(`- restored launch bounds: ${JSON.stringify(secondBounds)}`);
  if (expectedRestartStorageValue) console.log(`- localStorage marker preserved: ${localStorageSmokeKey}`);
  console.log(`- import bridge functions present: DOCX/PDF dialog path available`);
} catch (error) {
  if (firstLaunch) await closeApp(firstLaunch.proc, firstLaunch.cdp).catch(() => undefined);
  if (secondLaunch) await closeApp(secondLaunch.proc, secondLaunch.cdp).catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

process.exit(process.exitCode ?? 0);
