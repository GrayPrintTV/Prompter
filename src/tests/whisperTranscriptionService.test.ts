import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  WhisperTranscriptionService
} from '../../electron/whisper/WhisperTranscriptionService';
import type { LocalWhisperSettings } from '../domain/types';

const SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'base.en',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 2
};

function fakeProcess(onCommand?: (command: Record<string, unknown>, process: any) => void) {
  const process = new EventEmitter() as any;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.pid = 4321;
  process.kill = vi.fn(() => {
    queueMicrotask(() => process.emit('exit', 0, null));
    return true;
  });
  let input = '';
  process.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      onCommand?.(JSON.parse(line), process);
      newline = input.indexOf('\n');
    }
  });
  return process;
}

function createHarness(options: { packaged?: boolean } = {}) {
  const commands: Record<string, unknown>[] = [];
  const published: any[] = [];
  const unlinked: string[] = [];
  const spawnCalls: any[] = [];
  const process = fakeProcess((command, child) => {
    commands.push(command);
    if (command.type === 'configure') {
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({
        type: 'model-loaded',
        modelName: command.modelName,
        modelPath: command.modelPath,
        localFilesOnly: command.localFilesOnly,
        device: command.device,
        computeType: command.computeType
      })}\n`));
    }
    if (command.type === 'transcribe') {
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({
        type: 'transcribe-start', requestId: command.requestId, fileSizeBytes: command.fileSizeBytes,
        audioFormat: command.audioFormat, mimeType: command.mimeType, headerSignature: command.headerSignature
      })}\n${JSON.stringify({ type: 'transcript', requestId: command.requestId, text: 'fixture transcript', durationSeconds: 2 })}\n`));
    }
  });
  const service = new WhisperTranscriptionService({
    runtimePathContext: () => ({
      isPackaged: Boolean(options.packaged),
      appPath: 'C:\\dev\\Prompter',
      mainDirname: 'C:\\dev\\Prompter\\dist-electron',
      resourcesPath: 'C:\\Program Files\\Prompter\\resources',
      env: {}
    }),
    getUserDataPath: () => 'C:\\Users\\Ada\\AppData\\Roaming\\Prompter',
    getTempPath: () => 'C:\\Temp',
    exists: () => true,
    mkdirSync: vi.fn(),
    mkdir: vi.fn(async () => undefined) as any,
    writeFile: vi.fn(async () => undefined) as any,
    unlink: vi.fn(async (filePath: string) => { unlinked.push(filePath); }) as any,
    spawnProcess: vi.fn((executable, args, spawnOptions) => {
      spawnCalls.push({ executable, args, spawnOptions });
      queueMicrotask(() => process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`));
      return process;
    }) as any,
    publishStatus: (status) => published.push(status),
    now: () => 123456
  });
  return { service, process, commands, published, unlinked, spawnCalls };
}

describe('WhisperTranscriptionService', () => {
  it('owns development spawn, readiness, model configuration, and windowsHide', async () => {
    const harness = createHarness();
    const status = await harness.service.start(SETTINGS);

    expect(harness.spawnCalls[0]).toMatchObject({
      executable: 'python',
      spawnOptions: { stdio: 'pipe', windowsHide: true }
    });
    expect(harness.spawnCalls[0].args[0]).toContain('python\\local_whisper_sidecar.py');
    expect(harness.commands[0]).toMatchObject({
      type: 'configure', modelName: 'base.en', device: 'cpu', computeType: 'int8', localFilesOnly: false
    });
    expect(status).toMatchObject({ sidecarRunning: true, modelPhase: 'ready', status: 'listening' });
  });

  it('uses bundled executable/model resolution without process.cwd dependencies', async () => {
    const harness = createHarness({ packaged: true });
    await harness.service.start(SETTINGS);

    expect(harness.spawnCalls[0].executable).toContain('whisper-sidecar\\whisper-sidecar.exe');
    expect(harness.spawnCalls[0].args).toEqual([]);
    expect(harness.commands[0]).toMatchObject({
      type: 'configure', modelName: 'base.en', localFilesOnly: true
    });
    expect(String(harness.commands[0].modelPath)).toContain('models\\base.en');
  });

  it('writes a temporary chunk, resolves transcript JSONL, and removes the temporary file', async () => {
    const harness = createHarness();
    const wav = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]).buffer;
    const result = await harness.service.transcribe({
      audioData: wav,
      mimeType: 'audio/wav',
      sampleRate: 16000,
      durationSeconds: 2,
      settings: SETTINGS
    });

    expect(result).toEqual({ text: 'fixture transcript', durationSeconds: 2 });
    expect(harness.commands.find((command) => command.type === 'transcribe')).toMatchObject({
      audioFormat: 'wav', mimeType: 'audio/wav', headerSignature: 'RIFF/WAVE', sampleRate: 16000
    });
    expect(harness.unlinked).toHaveLength(1);
    expect(harness.service.getStatus().lastTranscriptDelta).toBe('fixture transcript');
  });

  it('shuts down intentionally and leaves a stopped non-error status', async () => {
    const harness = createHarness();
    await harness.service.start(SETTINGS);
    const status = await harness.service.stop();

    expect(harness.commands.at(-1)).toMatchObject({ type: 'shutdown' });
    expect(harness.process.kill).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ sidecarRunning: false, modelPhase: 'stopped', status: 'stopped', errorMessage: null });
  });

  it('publishes an unexpected sidecar exit while the application is alive', async () => {
    const harness = createHarness();
    await harness.service.start(SETTINGS);
    const before = harness.published.length;
    harness.process.emit('exit', 1, null);

    expect(harness.published.length).toBe(before + 1);
    expect(harness.service.getStatus()).toMatchObject({ status: 'stopped', errorMessage: 'Local Whisper sidecar stopped unexpectedly.' });
  });

  it('makes duplicate exit events during explicit shutdown harmless', async () => {
    const harness = createHarness();
    await harness.service.start(SETTINGS);
    await harness.service.stop();
    await Promise.resolve(); // fake process emits its intentional exit in a microtask
    const afterIntentionalExit = harness.published.length;
    harness.process.emit('exit', 0, null);

    expect(harness.published.length).toBe(afterIntentionalExit);
    expect(harness.service.getStatus()).toMatchObject({ status: 'stopped', errorMessage: null });
  });

  it('updates its own stopped state but does not publish late child events after publication disposal', async () => {
    const harness = createHarness();
    await harness.service.start(SETTINGS);
    const before = harness.published.length;
    harness.service.disposeStatusPublication();
    harness.service.disposeStatusPublication();
    expect(() => harness.process.emit('exit', 0, null)).not.toThrow();

    expect(harness.published).toHaveLength(before);
    expect(harness.service.getStatus()).toMatchObject({ sidecarRunning: false, status: 'stopped' });
  });
});
