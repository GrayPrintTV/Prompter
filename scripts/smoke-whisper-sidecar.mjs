import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecarExe = path.resolve(
  process.argv[2] || path.join(root, 'release', 'win-unpacked', 'resources', 'whisper-sidecar', 'whisper-sidecar.exe')
);
const modelDir = path.resolve(
  process.argv[3] || path.join(root, 'release', 'win-unpacked', 'resources', 'models', 'base.en')
);
const requiredModelFiles = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(sidecarExe)) fail(`Sidecar executable not found: ${sidecarExe}`);
for (const fileName of requiredModelFiles) {
  const filePath = path.join(modelDir, fileName);
  if (!existsSync(filePath)) fail(`Model file not found: ${filePath}`);
}

function makeRestrictedEnv(tempRoot) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: path.join(tempRoot, 'temp'),
    TMP: path.join(tempRoot, 'temp'),
    USERPROFILE: path.join(tempRoot, 'user'),
    PATH: [path.dirname(sidecarExe), system32, systemRoot].join(path.delimiter),
    HF_HOME: path.join(tempRoot, 'hf-home'),
    HUGGINGFACE_HUB_CACHE: path.join(tempRoot, 'hf-hub'),
    TRANSFORMERS_CACHE: path.join(tempRoot, 'transformers-cache'),
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    NO_COLOR: '1'
  };
}

async function writeToneWav(filePath, sampleRate = 16000, durationSeconds = 0.75) {
  const samples = Math.floor(sampleRate * durationSeconds);
  const bytesPerSample = 2;
  const dataSize = samples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.15 * 32767);
    buffer.writeInt16LE(value, 44 + index * bytesPerSample);
  }
  await writeFile(filePath, buffer);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'prompter-whisper-smoke-'));
await mkdir(path.join(tempRoot, 'temp'), { recursive: true });
await mkdir(path.join(tempRoot, 'user'), { recursive: true });
await mkdir(path.join(tempRoot, 'hf-home'), { recursive: true });
await mkdir(path.join(tempRoot, 'hf-hub'), { recursive: true });
await mkdir(path.join(tempRoot, 'transformers-cache'), { recursive: true });
const stderrChunks = [];
const messages = [];
const waiters = [];
let processExited = false;
let fatalError = null;
let stdoutBuffer = '';

function stderrTail() {
  return stderrChunks.join('').slice(-2000).trim();
}

function rejectWaiters(error) {
  fatalError = error;
  while (waiters.length > 0) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
}

function deliver(message) {
  for (let index = 0; index < waiters.length; index += 1) {
    const waiter = waiters[index];
    if (waiter.predicate(message)) {
      waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
  }
  messages.push(message);
}

function waitForMessage(predicate, label, timeoutMs) {
  if (fatalError) return Promise.reject(fatalError);
  const index = messages.findIndex(predicate);
  if (index >= 0) {
    const [message] = messages.splice(index, 1);
    return Promise.resolve(message);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const detail = stderrTail();
      reject(new Error(`${label} timed out after ${timeoutMs}ms${detail ? `; stderr: ${detail}` : ''}`));
    }, timeoutMs);
    waiters.push({ predicate, resolve, reject, timeout });
  });
}

function send(proc, command) {
  proc.stdin.write(`${JSON.stringify(command)}\n`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const env = makeRestrictedEnv(tempRoot);
const proc = spawn(sidecarExe, [], {
  cwd: tempRoot,
  env,
  stdio: 'pipe',
  windowsHide: true
});

proc.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString('utf8');
  let newlineIndex = stdoutBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        deliver(JSON.parse(line));
      } catch (error) {
        rejectWaiters(new Error(`Malformed sidecar JSONL output: ${line}`));
      }
    }
    newlineIndex = stdoutBuffer.indexOf('\n');
  }
});

proc.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk.toString('utf8'));
});

proc.on('error', (error) => {
  rejectWaiters(error);
});

const exitPromise = new Promise((resolve) => {
  proc.on('exit', (code, signal) => {
    processExited = true;
    if (code !== 0) {
      rejectWaiters(new Error(`Sidecar exited with code ${code}${signal ? ` and signal ${signal}` : ''}; stderr: ${stderrTail()}`));
    }
    resolve({ code, signal });
  });
});

try {
  const ready = await waitForMessage((message) => message.type === 'ready', 'ready message', 120000);
  if (ready.type !== 'ready') throw new Error('Unexpected sidecar startup response.');

  send(proc, {
    type: 'configure',
    modelName: 'base.en',
    modelPath: modelDir,
    device: 'cpu',
    computeType: 'int8',
    localFilesOnly: true
  });

  const configured = await waitForMessage(
    (message) => message.type === 'model-loaded' || message.type === 'error',
    'model-loaded message',
    240000
  );
  if (configured.type === 'error') {
    throw new Error(`Model configure failed: ${configured.message || 'unknown error'}; stderr: ${stderrTail()}`);
  }

  const audioPath = path.join(tempRoot, 'smoke-tone.wav');
  await writeToneWav(audioPath);
  send(proc, {
    type: 'transcribe',
    requestId: 'smoke-1',
    audioPath,
    audioFormat: 'wav',
    mimeType: 'audio/wav',
    fileSizeBytes: 0,
    headerSignature: 'RIFF/WAVE',
    sampleRate: 16000,
    chunkDurationSeconds: 0.75,
    modelName: 'base.en',
    modelPath: modelDir,
    device: 'cpu',
    computeType: 'int8',
    localFilesOnly: true
  });

  await waitForMessage(
    (message) => message.type === 'transcribe-start' && message.requestId === 'smoke-1',
    'transcribe-start message',
    30000
  );
  const transcript = await waitForMessage(
    (message) => (message.type === 'transcript' || message.type === 'error') && message.requestId === 'smoke-1',
    'transcript message',
    120000
  );
  if (transcript.type === 'error') {
    throw new Error(`Transcription failed: ${transcript.message || 'unknown error'}; stderr: ${stderrTail()}`);
  }

  send(proc, { type: 'shutdown' });
  await waitForMessage((message) => message.type === 'stopped', 'stopped message', 10000);
  proc.stdin.end();
  await exitPromise;

  console.log('Local Whisper sidecar smoke test passed:');
  console.log(`- executable: ${sidecarExe}`);
  console.log(`- model: ${modelDir}`);
  console.log(`- restricted PATH: ${env.PATH}`);
  console.log(`- cache roots: ${env.HF_HOME}; ${env.HUGGINGFACE_HUB_CACHE}`);
  console.log(`- actual audio request processed: yes`);
  console.log(`- transcript text: ${JSON.stringify(transcript.text || '')}`);
} catch (error) {
  if (!processExited) proc.kill();
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!processExited) {
    if (!proc.killed) proc.kill();
    await Promise.race([exitPromise, delay(5000)]).catch(() => undefined);
  }
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
