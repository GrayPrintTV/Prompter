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

function fakeProcess(
  onCommand?: (command: Record<string, unknown>, process: any) => void,
  autoExitOnKill = true
) {
  const process = new EventEmitter() as any;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.pid = 4321;
  process.kill = vi.fn(() => {
    if (autoExitOnKill) queueMicrotask(() => process.emit('exit', 0, null));
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

function createHarness(options: {
  packaged?: boolean;
  respondToTranscribe?: boolean;
  autoExitOnKill?: boolean;
  respondToReady?: boolean;
  startupCleanupGate?: Promise<void>;
  abandonedTempFiles?: Array<{ name: string; mtimeMs: number }>;
} = {}) {
  const commands: Record<string, unknown>[] = [];
  const published: any[] = [];
  const unlinked: string[] = [];
  const spawnCalls: any[] = [];
  const processes: any[] = [];
  const createProcess = () => {
    const child = fakeProcess((command, commandProcess) => {
      commands.push(command);
      if (command.type === 'configure') {
        queueMicrotask(() => commandProcess.stdout.write(`${JSON.stringify({
          type: 'model-loaded',
          modelName: command.modelName,
          modelPath: command.modelPath,
          localFilesOnly: command.localFilesOnly,
          device: command.device,
          computeType: command.computeType
        })}\n`));
      }
      if (command.type === 'transcribe') {
        queueMicrotask(() => commandProcess.stdout.write(`${JSON.stringify({
          type: 'transcribe-start', requestId: command.requestId, fileSizeBytes: command.fileSizeBytes,
          audioFormat: command.audioFormat, mimeType: command.mimeType, headerSignature: command.headerSignature,
          inferenceStartedAtMs: Date.now()
        })}\n`));
        if (options.respondToTranscribe !== false) {
          queueMicrotask(() => commandProcess.stdout.write(`${JSON.stringify({ type: 'transcript', requestId: command.requestId, text: 'fixture transcript', durationSeconds: 2, inferenceDurationMs: 321 })}\n`));
        }
      }
    }, options.autoExitOnKill !== false);
    processes.push(child);
    return child;
  };
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
    readdir: vi.fn(async () => {
      await options.startupCleanupGate;
      return (options.abandonedTempFiles ?? []).map((entry) => ({
        name: entry.name,
        isFile: () => true
      }));
    }) as any,
    stat: vi.fn(async (filePath: string) => ({
      mtimeMs: options.abandonedTempFiles?.find((entry) => filePath.endsWith(entry.name))?.mtimeMs ?? Date.now()
    })) as any,
    writeFile: vi.fn(async () => undefined) as any,
    unlink: vi.fn(async (filePath: string) => { unlinked.push(filePath); }) as any,
    spawnProcess: vi.fn((executable, args, spawnOptions) => {
      spawnCalls.push({ executable, args, spawnOptions });
      const child = createProcess();
      if (options.respondToReady !== false || processes.length > 1) {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`));
      }
      return child;
    }) as any,
    publishStatus: (status) => published.push(status),
    now: () => Date.now()
  });
  return { service, get process() { return processes[0]; }, processes, commands, published, unlinked, spawnCalls };
}

describe('WhisperTranscriptionService', () => {
  it('owns development spawn, readiness, model configuration, and windowsHide', async () => {
    const harness = createHarness();
    const status = await harness.service.start(SETTINGS);

    expect(harness.spawnCalls[0]).toMatchObject({
      executable: 'python',
      spawnOptions: {
        stdio: 'pipe', windowsHide: true,
        env: expect.objectContaining({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
      }
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

    expect(result).toMatchObject({
      text: 'fixture transcript',
      durationSeconds: 2,
      telemetry: {
        requestId: '1',
        mainQueueDepthAtReceive: 0,
        mainQueueDepthAtDispatch: 1,
        mainQueueDepthAtCompletion: 0,
        sidecarInferenceMs: 321
      }
    });
    expect(harness.commands.find((command) => command.type === 'transcribe')).toMatchObject({
      audioFormat: 'wav', mimeType: 'audio/wav', headerSignature: 'RIFF/WAVE', sampleRate: 16000
    });
    expect(harness.unlinked).toHaveLength(1);
    expect(harness.service.getStatus().lastTranscriptDelta).toBe('fixture transcript');
  });

  it('removes only abandoned owned temp chunks during safe startup cleanup', async () => {
    const now = Date.now();
    const harness = createHarness({
      abandonedTempFiles: [
        { name: 'chunk-100-1.wav', mtimeMs: now - 25 * 60 * 60 * 1000 },
        { name: 'chunk-200-2.wav', mtimeMs: now - 60 * 1000 },
        { name: 'unrelated.wav', mtimeMs: now - 25 * 60 * 60 * 1000 }
      ]
    });

    await harness.service.start(SETTINGS);

    expect(harness.unlinked).toEqual([expect.stringContaining('chunk-100-1.wav')]);
  });

  it('keeps a delayed request and its audio alive after the soft timeout', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ respondToTranscribe: false });
      const pending = harness.service.transcribe({
        audioData: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]).buffer,
        mimeType: 'audio/wav', sampleRate: 16000, durationSeconds: 2, settings: SETTINGS
      });
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(harness.unlinked).toEqual([]);
      expect(harness.process.kill).not.toHaveBeenCalled();
      expect(harness.service.getStatus().chunk.warningMessage).toContain('still waiting');
      expect(harness.service.takeQueueTelemetry()).toEqual({ current: 1, max: 1 });

      const request = harness.commands.find((command) => command.type === 'transcribe');
      harness.process.stdout.write(`${JSON.stringify({
        type: 'transcript', requestId: request?.requestId, text: 'late ā but valid', durationSeconds: 2
      })}\n`);
      await expect(pending).resolves.toMatchObject({ text: 'late ā but valid', durationSeconds: 2 });
      expect(harness.unlinked).toHaveLength(1);
      expect(harness.service.takeQueueTelemetry()).toEqual({ current: 0, max: 1 });
      expect(harness.service.takeQueueTelemetry()).toEqual({ current: 0, max: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts after the hard watchdog and cleans audio only after process exit', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ respondToTranscribe: false, autoExitOnKill: false });
      const pending = harness.service.transcribe({
        audioData: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]).buffer,
        mimeType: 'audio/wav', sampleRate: 16000, durationSeconds: 2, settings: SETTINGS
      });
      const rejected = expect(pending).rejects.toThrow('hard watchdog');
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.process.kill).toHaveBeenCalledOnce();
      expect(harness.unlinked).toEqual([]);
      harness.process.emit('exit', null, 'SIGTERM');
      await rejected;
      await vi.runAllTicks();
      expect(harness.unlinked).toHaveLength(1);
      expect(harness.spawnCalls).toHaveLength(2);

      const staleRequest = harness.commands.find((command) => command.type === 'transcribe');
      harness.process.stdout.write(`${JSON.stringify({
        type: 'transcript', requestId: staleRequest?.requestId, text: 'stale generation'
      })}\n`);
      expect(harness.service.getStatus().lastTranscriptDelta).not.toBe('stale generation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shuts down intentionally and leaves a stopped non-error status', async () => {
    const harness = createHarness();
    await harness.service.start(SETTINGS);
    const status = await harness.service.stop();

    expect(harness.commands.at(-1)).toMatchObject({ type: 'shutdown' });
    expect(harness.process.kill).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ sidecarRunning: false, modelPhase: 'stopped', status: 'stopped', errorMessage: null });
  });

  it('settles an in-flight startup when Stop terminates the starting generation', async () => {
    const harness = createHarness({ respondToReady: false });
    const starting = harness.service.start(SETTINGS);
    const startupResult = expect(starting).rejects.toThrow('sidecar stopped');
    await vi.waitFor(() => expect(harness.spawnCalls).toHaveLength(1));

    await expect(harness.service.stop()).resolves.toMatchObject({ status: 'stopped' });
    await startupResult;

    await harness.service.start(SETTINGS);
    expect(harness.spawnCalls).toHaveLength(2);
    expect(harness.service.getStatus()).toMatchObject({ status: 'listening' });
  });

  it('does not spawn a sidecar when Stop wins during asynchronous startup cleanup', async () => {
    let releaseCleanup!: () => void;
    const startupCleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const harness = createHarness({ startupCleanupGate });
    const starting = harness.service.start(SETTINGS);
    const startupResult = expect(starting).rejects.toThrow('stopped during startup');

    await Promise.resolve();
    await harness.service.stop();
    releaseCleanup();
    await startupResult;

    expect(harness.spawnCalls).toHaveLength(0);
    await harness.service.start(SETTINGS);
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('retains cancelled request audio until shutdown exit acknowledgement', async () => {
    const harness = createHarness({ respondToTranscribe: false, autoExitOnKill: false });
    await harness.service.start(SETTINGS);
    const pending = harness.service.transcribe({
      audioData: new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]).buffer,
      mimeType: 'audio/wav', sampleRate: 16000, durationSeconds: 2, settings: SETTINGS
    });
    await vi.waitFor(() => expect(harness.commands.some((command) => command.type === 'transcribe')).toBe(true));

    const stopping = harness.service.stop();
    expect(harness.unlinked).toEqual([]);
    harness.process.emit('exit', 0, null);

    await expect(pending).resolves.toEqual({ text: '' });
    await expect(stopping).resolves.toMatchObject({ status: 'stopped', errorMessage: null });
    expect(harness.unlinked).toHaveLength(1);
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
