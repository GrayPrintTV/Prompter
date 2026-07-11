import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  LocalWhisperServiceStatus as LocalWhisperStatus,
  LocalWhisperSettings
} from '#prompter-shared/domain/types.js';
import {
  REQUIRED_WHISPER_MODEL_FILES,
  isPathLikeExecutable,
  localWhisperSpawnErrorMessage,
  missingBundledModelMessage,
  missingBundledSidecarMessage,
  missingPythonExecutableMessage,
  missingSidecarMessage,
  resolveLocalWhisperLaunchPlan,
  type LocalWhisperLaunchPlan,
  type RuntimePathContext
} from '../runtimePaths.js';

export type WhisperRuntimeDiagnostics = {
  localWhisperSidecarExecutablePath: string | null;
  localWhisperSidecarScriptPath: string | null;
  localWhisperModelPath: string | null;
  localWhisperSidecarWorkingDirectory: string | null;
  localWhisperUsesBundledSidecar: boolean | null;
  localWhisperSidecarProcessId: number | null;
};

export type WhisperTranscriptionPayload = {
  audioData: ArrayBuffer;
  mimeType: string;
  format?: string;
  extension?: string;
  sampleRate?: number;
  durationSeconds?: number;
  headerSignature?: string;
  settings: LocalWhisperSettings;
};

type PendingRequest = {
  resolve(result: { text: string; durationSeconds?: number }): void;
  reject(error: Error): void;
  audioPath: string;
  timeout: NodeJS.Timeout;
};

type ReadyWaiter = {
  resolve(): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

export type WhisperServiceDependencies = {
  runtimePathContext(): RuntimePathContext;
  getUserDataPath(): string;
  getTempPath(): string;
  publishStatus?(status: LocalWhisperStatus): void;
  appendDiagnosticLog?(event: string, data: Record<string, unknown>): void;
  spawnProcess?: typeof spawn;
  exists?: typeof existsSync;
  mkdirSync?: typeof mkdirSync;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  unlink?: typeof unlink;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_PROCESS_READY_TIMEOUT_MS = 30000;
const DEFAULT_MODEL_READY_TIMEOUT_MS = 180000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15000;
const DEFAULT_SETTINGS: LocalWhisperSettings = {
  pythonExecutablePath: 'python',
  modelName: 'base.en',
  device: 'cpu',
  computeType: 'int8',
  chunkDurationSeconds: 2
};
const PROVIDER_STATUS_TEXT = new Set([
  'sidecar is running',
  'local whisper sidecar is running',
  'model loading',
  'model loaded',
  'process started',
  'ready'
]);

function createInitialStatus(): LocalWhisperStatus {
  return {
    providerId: 'local-whisper', configured: true, sidecarRunning: false, modelPhase: 'stopped', listening: false,
    status: 'idle', lastTranscriptDelta: '', errorMessage: null,
    mic: { captureState: 'not-requested', inputLevel: 0, deviceLabel: '', monitorActive: false, errorMessage: null, log: [] },
    chunk: {
      chunksRecorded: 0, chunksQueued: 0, chunksSentToMain: 0, chunksDropped: 0,
      chunksReceivedBySidecar: 0, chunksReturnedFromSidecar: 0, chunksEmpty: 0, chunksFailed: 0,
      queueLength: 0, maxQueueLength: 4, estimatedQueueLatencyMs: 0, lastChunkSequence: 0,
      processingSequence: 0, lastTranscriptionDurationMs: 0, avgTranscriptionDurationMs: 0,
      lastRealtimeFactor: 0, avgRealtimeFactor: 0, droppedDueToOverflow: 0, droppedDueToSilence: 0,
      staleChunksDropped: 0, silenceChunksSuppressed: 0, lastChunkBytes: 0, lastChunkFormat: '',
      lastMimeType: '', lastFileExtension: '', lastHeaderSignature: '', lastSampleRate: 0,
      lastChunkDurationSeconds: 0, lastTranscriptText: '', lastSidecarError: null,
      warningMessage: null, pendingResponses: 0
    },
    transcriptHistory: []
  };
}

export class WhisperTranscriptionService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private settings: LocalWhisperSettings | null = null;
  private processReady = false;
  private modelReady = false;
  private modelConfigKey = '';
  private generation = 0;
  private intentionallyStoppingGeneration: number | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly processWaiters = new Set<ReadyWaiter>();
  private readonly modelWaiters = new Set<ReadyWaiter>();
  private status = createInitialStatus();

  constructor(private readonly deps: WhisperServiceDependencies) {}

  getStatus(): LocalWhisperStatus {
    return {
      ...this.status,
      mic: { ...this.status.mic, log: [...this.status.mic.log] },
      chunk: { ...this.status.chunk },
      transcriptHistory: [...this.status.transcriptHistory]
    };
  }

  getRuntimeDiagnostics(): WhisperRuntimeDiagnostics {
    try {
      const plan = this.launchPlan();
      return {
        localWhisperSidecarExecutablePath: plan.executablePath,
        localWhisperSidecarScriptPath: plan.scriptPath,
        localWhisperModelPath: plan.modelPath,
        localWhisperSidecarWorkingDirectory: plan.workingDirectory,
        localWhisperUsesBundledSidecar: plan.bundled,
        localWhisperSidecarProcessId: this.process?.pid ?? null
      };
    } catch {
      return {
        localWhisperSidecarExecutablePath: null, localWhisperSidecarScriptPath: null,
        localWhisperModelPath: null, localWhisperSidecarWorkingDirectory: null,
        localWhisperUsesBundledSidecar: null, localWhisperSidecarProcessId: null
      };
    }
  }

  async start(settings: LocalWhisperSettings): Promise<LocalWhisperStatus> {
    this.settings = settings;
    const plan = this.launchPlan(settings);
    const requestedModelKey = this.settingsKey(settings, plan);
    if (this.modelConfigKey && this.modelConfigKey !== requestedModelKey) this.modelReady = false;
    this.validatePlan(plan);

    if (!this.process) {
      this.stdoutBuffer = '';
      this.processReady = false;
      this.modelReady = false;
      this.modelConfigKey = '';
      this.patch({
        sidecarRunning: false, modelPhase: 'starting', listening: true, status: 'starting', errorMessage: null,
        lastTranscriptDelta: '', transcriptHistory: [],
        chunk: { ...this.status.chunk, lastTranscriptText: '', lastSidecarError: null, warningMessage: null, pendingResponses: 0 }
      });
      (this.deps.mkdirSync ?? mkdirSync)(plan.workingDirectory, { recursive: true });
      const ready = this.waitForProcessReady();
      this.deps.appendDiagnosticLog?.('local-whisper-spawn', {
        executablePath: plan.executablePath, args: plan.args, scriptPath: plan.scriptPath,
        modelName: plan.modelName, modelPath: plan.modelPath, localFilesOnly: plan.localFilesOnly,
        bundled: plan.bundled, workingDirectory: plan.workingDirectory
      });
      const spawned = (this.deps.spawnProcess ?? spawn)(plan.executablePath, plan.args, {
        cwd: plan.workingDirectory, stdio: 'pipe', windowsHide: true
      });
      this.process = spawned;
      const thisGeneration = ++this.generation;
      Object.assign(spawned, { _generation: thisGeneration });
      spawned.stdout.on('data', (chunk) => this.handleStdout(chunk));
      spawned.stderr.on('data', (chunk) => this.handleStderr(chunk, plan));
      spawned.on('error', (error: NodeJS.ErrnoException) => this.handleProcessError(spawned, error, plan));
      spawned.on('exit', (code, signal) => this.handleProcessExit(spawned, thisGeneration, code, signal, plan));
      await ready;
    } else if (!this.processReady) {
      await this.waitForProcessReady();
    }

    this.patch({ sidecarRunning: true, listening: true, status: 'starting' });
    if (!this.modelReady || this.modelConfigKey !== requestedModelKey) {
      const ready = this.waitForModelReady();
      try {
        this.send({
          type: 'configure', modelName: plan.modelName, modelPath: plan.modelPath ?? undefined,
          localFilesOnly: plan.localFilesOnly, device: settings.device, computeType: settings.computeType
        });
      } catch (error) {
        this.rejectWaiters(this.modelWaiters, error instanceof Error ? error : new Error('Local Whisper configure command failed.'));
        throw error;
      }
      await ready;
    }
    this.patch({ sidecarRunning: true, listening: true, status: 'listening', modelPhase: 'ready' });
    return this.getStatus();
  }

  async transcribe(payload: WhisperTranscriptionPayload): Promise<{ text: string; durationSeconds?: number }> {
    await this.start(payload.settings);
    const plan = this.launchPlan(payload.settings);
    const tempDirectory = path.join(this.deps.getTempPath(), 'narration-prompter-local-whisper');
    await (this.deps.mkdir ?? mkdir)(tempDirectory, { recursive: true });
    const audioBuffer = Buffer.from(payload.audioData);
    const format = payload.format || (payload.mimeType.includes('wav') ? 'wav' : payload.mimeType.includes('ogg') ? 'ogg' : payload.mimeType.includes('webm') ? 'webm' : 'other');
    const extension = payload.extension || (payload.mimeType.includes('wav') ? 'wav' : payload.mimeType.includes('ogg') ? 'ogg' : payload.mimeType.includes('webm') ? 'webm' : 'bin');
    const headerSignature = payload.headerSignature || this.audioHeaderSignature(audioBuffer);
    const requestId = String(this.nextRequestId++);
    const audioPath = path.join(tempDirectory, `chunk-${this.now()}-${requestId}.${extension}`);
    await (this.deps.writeFile ?? writeFile)(audioPath, audioBuffer);

    return new Promise<{ text: string; durationSeconds?: number }>((resolve, reject) => {
      const timeout = this.timerSet(() => {
        const request = this.pending.get(requestId);
        if (!request) return;
        this.pending.delete(requestId);
        void this.removeFile(request.audioPath);
        reject(new Error('Local Whisper transcription timed out.'));
      }, this.configuredTimeout('LOCAL_WHISPER_TRANSCRIPTION_TIMEOUT_MS', DEFAULT_TRANSCRIPTION_TIMEOUT_MS));
      this.pending.set(requestId, { resolve, reject, audioPath, timeout });
      try {
        this.send({
          type: 'transcribe', requestId, audioPath, audioFormat: format, mimeType: payload.mimeType,
          fileSizeBytes: audioBuffer.byteLength, headerSignature, sampleRate: payload.sampleRate,
          chunkDurationSeconds: payload.durationSeconds, modelName: plan.modelName,
          modelPath: plan.modelPath ?? undefined, localFilesOnly: plan.localFilesOnly,
          device: payload.settings.device, computeType: payload.settings.computeType
        });
      } catch (error) {
        this.pending.delete(requestId);
        this.timerClear(timeout);
        void this.removeFile(audioPath);
        reject(error);
        return;
      }
      this.patch({
        modelPhase: 'transcribing',
        chunk: {
          ...this.status.chunk, chunksReceivedBySidecar: this.status.chunk.chunksReceivedBySidecar + 1,
          lastChunkBytes: audioBuffer.byteLength, lastChunkFormat: format, lastMimeType: payload.mimeType,
          lastFileExtension: extension, lastHeaderSignature: headerSignature,
          lastSampleRate: payload.sampleRate ?? 0, lastChunkDurationSeconds: payload.durationSeconds ?? 0,
          pendingResponses: this.status.chunk.pendingResponses + 1, warningMessage: null
        }
      });
    });
  }

  async stop(): Promise<LocalWhisperStatus> {
    const current = this.process;
    if (current) {
      this.intentionallyStoppingGeneration = Number((current as ChildProcessWithoutNullStreams & { _generation?: number })._generation ?? 0);
      if (current.stdin?.writable) {
        try { this.send({ type: 'shutdown' }); } catch { /* forced termination below is authoritative */ }
      }
      current.kill();
      this.process = null;
      this.processReady = false;
      this.modelReady = false;
      this.modelConfigKey = '';
      this.resolvePendingAsStopped();
    }
    this.patch({
      sidecarRunning: false, modelPhase: 'stopped', listening: false, status: 'stopped', errorMessage: null,
      chunk: { ...this.status.chunk, pendingResponses: 0 }
    });
    return this.getStatus();
  }

  private launchPlan(settings = this.settings ?? DEFAULT_SETTINGS) {
    return resolveLocalWhisperLaunchPlan(
      this.deps.runtimePathContext(), settings.pythonExecutablePath, settings.modelName,
      this.deps.getUserDataPath(), this.deps.env ?? process.env
    );
  }

  private validatePlan(plan: LocalWhisperLaunchPlan) {
    const exists = this.deps.exists ?? existsSync;
    if (plan.bundled) {
      if (!exists(plan.executablePath)) throw new Error(missingBundledSidecarMessage(plan.executablePath));
      const modelPath = plan.modelPath ?? '';
      const missing = modelPath ? REQUIRED_WHISPER_MODEL_FILES.filter((file) => !exists(path.join(modelPath, file))) : [...REQUIRED_WHISPER_MODEL_FILES];
      if (!modelPath || missing.length > 0) throw new Error(missingBundledModelMessage(modelPath || '(not resolved)', missing));
      return;
    }
    if (!plan.executablePath || !plan.modelName.trim()) throw new Error('Local Whisper is not configured. Set Python executable and model name.');
    if (!plan.scriptPath || !exists(plan.scriptPath)) throw new Error(missingSidecarMessage(plan.scriptPath ?? '(not resolved)'));
    if (isPathLikeExecutable(plan.executablePath) && !exists(plan.executablePath)) throw new Error(missingPythonExecutableMessage(plan.executablePath));
  }

  private settingsKey(settings: LocalWhisperSettings, plan: LocalWhisperLaunchPlan) {
    return [plan.modelName.trim(), settings.device.trim(), settings.computeType.trim(), plan.modelPath ?? '', plan.localFilesOnly ? 'local' : 'remote'].join('|');
  }

  private patch(patch: Partial<LocalWhisperStatus>) {
    const settings = this.settings;
    this.status = {
      ...this.status, ...patch, providerId: 'local-whisper',
      configured: this.deps.runtimePathContext().isPackaged || (settings ? Boolean(settings.pythonExecutablePath.trim() && settings.modelName.trim()) : true),
      mic: { ...this.status.mic, ...patch.mic, log: patch.mic?.log ?? this.status.mic.log },
      chunk: { ...this.status.chunk, ...patch.chunk },
      transcriptHistory: patch.transcriptHistory ?? this.status.transcriptHistory
    };
    this.deps.publishStatus?.(this.getStatus());
  }

  private send(command: Record<string, unknown>) {
    if (!this.process?.stdin.writable) throw new Error('Local Whisper sidecar is not running.');
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private waitForProcessReady() {
    if (this.processReady) return Promise.resolve();
    return this.makeWaiter(this.processWaiters, this.configuredTimeout('LOCAL_WHISPER_PROCESS_READY_TIMEOUT_MS', DEFAULT_PROCESS_READY_TIMEOUT_MS), 'Local Whisper sidecar process did not become ready. Check Python setup.');
  }

  private waitForModelReady() {
    if (this.modelReady) return Promise.resolve();
    return this.makeWaiter(this.modelWaiters, this.configuredTimeout('LOCAL_WHISPER_MODEL_READY_TIMEOUT_MS', DEFAULT_MODEL_READY_TIMEOUT_MS), 'Local Whisper model did not finish loading. Check model name, device, compute type, and faster-whisper setup.');
  }

  private makeWaiter(set: Set<ReadyWaiter>, timeoutMs: number, message: string) {
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve, reject,
        timeout: this.timerSet(() => { set.delete(waiter); reject(new Error(message)); }, timeoutMs)
      };
      set.add(waiter);
    });
  }

  private resolveWaiters(set: Set<ReadyWaiter>) {
    for (const waiter of set) { this.timerClear(waiter.timeout); waiter.resolve(); }
    set.clear();
  }

  private rejectWaiters(set: Set<ReadyWaiter>, error: Error) {
    for (const waiter of set) { this.timerClear(waiter.timeout); waiter.reject(error); }
    set.clear();
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      this.timerClear(request.timeout); request.reject(error); void this.removeFile(request.audioPath);
    }
    this.pending.clear();
  }

  private resolvePendingAsStopped() {
    for (const request of this.pending.values()) {
      this.timerClear(request.timeout); request.resolve({ text: '' }); void this.removeFile(request.audioPath);
    }
    this.pending.clear();
  }

  private handleStdout(chunk: Buffer) {
    this.stdoutBuffer += chunk.toString('utf8');
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try { this.handleMessage(JSON.parse(line) as Record<string, unknown>); }
        catch {
          this.patch({ modelPhase: 'error', status: 'error', errorMessage: 'Invalid Local Whisper sidecar response.', chunk: { ...this.status.chunk, lastSidecarError: 'Invalid Local Whisper sidecar response.', warningMessage: 'Invalid Local Whisper sidecar response.' } });
        }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(message: Record<string, unknown>) {
    const type = message.type;
    if (type === 'ready') {
      this.processReady = true; this.resolveWaiters(this.processWaiters);
      this.patch({ sidecarRunning: true, modelPhase: 'process-started', status: 'starting', errorMessage: null });
      return;
    }
    if (type === 'model-loading') {
      this.modelReady = false; this.patch({ sidecarRunning: true, modelPhase: 'model-loading', status: 'starting', errorMessage: null }); return;
    }
    if (type === 'model-loaded') {
      const localFilesOnly = message.localFilesOnly === true || String(message.localFilesOnly ?? '').toLowerCase() === 'true';
      this.modelConfigKey = [String(message.modelName ?? this.settings?.modelName ?? '').trim(), String(message.device ?? this.settings?.device ?? '').trim(), String(message.computeType ?? this.settings?.computeType ?? '').trim(), String(message.modelPath ?? ''), localFilesOnly ? 'local' : 'remote'].join('|');
      this.modelReady = true; this.resolveWaiters(this.modelWaiters);
      this.patch({ modelPhase: 'ready', status: 'listening', sidecarRunning: true }); return;
    }
    if (type === 'transcribe-start') {
      this.patch({ modelPhase: 'transcribing', chunk: { ...this.status.chunk, lastChunkBytes: Number(message.fileSizeBytes ?? this.status.chunk.lastChunkBytes) || this.status.chunk.lastChunkBytes, lastChunkFormat: String(message.audioFormat ?? this.status.chunk.lastChunkFormat), lastMimeType: String(message.mimeType ?? this.status.chunk.lastMimeType), lastHeaderSignature: String(message.headerSignature ?? this.status.chunk.lastHeaderSignature), warningMessage: null } });
      return;
    }
    if (type === 'transcript') {
      const requestId = String(message.requestId ?? '');
      const request = this.pending.get(requestId);
      if (!request) return;
      this.pending.delete(requestId); this.timerClear(request.timeout);
      const text = String(message.text ?? '');
      const ignoredStatus = PROVIDER_STATUS_TEXT.has(text.trim().replace(/\.$/, '').toLowerCase());
      const trimmed = ignoredStatus ? '' : text.trim();
      const item = { text: trimmed, displayText: trimmed || '[empty transcript]', isEmpty: !trimmed, isFinal: true, timestampMs: this.now(), source: 'local-whisper' as const };
      this.patch({
        modelPhase: ignoredStatus ? 'ready' : item.isEmpty ? 'returned-empty-transcript' : 'ready',
        ...(ignoredStatus ? {} : { lastTranscriptDelta: item.displayText }),
        chunk: { ...this.status.chunk, chunksReturnedFromSidecar: ignoredStatus ? this.status.chunk.chunksReturnedFromSidecar : this.status.chunk.chunksReturnedFromSidecar + 1, lastTranscriptText: ignoredStatus ? this.status.chunk.lastTranscriptText : item.displayText, lastSidecarError: null, warningMessage: null, pendingResponses: Math.max(0, this.status.chunk.pendingResponses - 1) },
        transcriptHistory: ignoredStatus ? this.status.transcriptHistory : [...this.status.transcriptHistory, item].slice(-25)
      });
      request.resolve({ text: trimmed, durationSeconds: typeof message.durationSeconds === 'number' ? message.durationSeconds : undefined });
      void this.removeFile(request.audioPath); return;
    }
    if (type === 'error') this.handleSidecarError(message);
  }

  private handleSidecarError(message: Record<string, unknown>) {
    const requestId = String(message.requestId ?? '');
    const request = requestId ? this.pending.get(requestId) : undefined;
    if (this.intentionallyStoppingGeneration != null) {
      if (request) { this.pending.delete(requestId); this.timerClear(request.timeout); request.resolve({ text: '' }); void this.removeFile(request.audioPath); }
      this.patch({ modelPhase: 'stopped', status: 'stopped', errorMessage: null, chunk: { ...this.status.chunk, pendingResponses: Math.max(0, this.status.chunk.pendingResponses - 1) } });
      return;
    }
    const error = new Error(String(message.message ?? 'Local Whisper sidecar error.'));
    if (request) {
      this.pending.delete(requestId); this.timerClear(request.timeout); request.reject(error); void this.removeFile(request.audioPath);
      this.patch({ modelPhase: 'error', status: 'error', errorMessage: error.message, chunk: { ...this.status.chunk, chunksReturnedFromSidecar: this.status.chunk.chunksReturnedFromSidecar + 1, lastSidecarError: error.message, warningMessage: error.message, pendingResponses: Math.max(0, this.status.chunk.pendingResponses - 1) } });
      return;
    }
    this.patch({ modelPhase: 'error', status: 'error', errorMessage: error.message, chunk: { ...this.status.chunk, lastSidecarError: error.message, warningMessage: error.message, pendingResponses: 0 } });
    this.rejectWaiters(this.processWaiters, error); this.rejectWaiters(this.modelWaiters, error); this.rejectPending(error);
  }

  private handleStderr(chunk: Buffer, plan: LocalWhisperLaunchPlan) {
    const message = String(chunk).trim();
    if (!message) return;
    const errorMessage = message.slice(0, 500);
    this.deps.appendDiagnosticLog?.('local-whisper-stderr', { message: errorMessage, bundled: plan.bundled });
    this.patch({ errorMessage, chunk: { ...this.status.chunk, lastSidecarError: errorMessage } });
  }

  private handleProcessError(processInstance: ChildProcessWithoutNullStreams, error: NodeJS.ErrnoException, plan: LocalWhisperLaunchPlan) {
    const spawnError = new Error(localWhisperSpawnErrorMessage(error, plan.executablePath, plan.bundled));
    if (this.process === processInstance) this.process = null;
    this.intentionallyStoppingGeneration = null;
    this.patch({ sidecarRunning: false, modelPhase: 'error', listening: false, status: 'error', errorMessage: spawnError.message });
    this.rejectWaiters(this.processWaiters, spawnError); this.rejectWaiters(this.modelWaiters, spawnError); this.rejectPending(spawnError);
  }

  private handleProcessExit(processInstance: ChildProcessWithoutNullStreams, generation: number, code: number | null, signal: NodeJS.Signals | null, plan: LocalWhisperLaunchPlan) {
    if (this.process === processInstance) this.process = null;
    this.processReady = false; this.modelReady = false; this.modelConfigKey = '';
    const intentional = this.intentionallyStoppingGeneration === generation;
    this.intentionallyStoppingGeneration = null;
    this.deps.appendDiagnosticLog?.('local-whisper-exit', { code, signal, intentional, bundled: plan.bundled });
    this.patch({ sidecarRunning: false, modelPhase: 'stopped', listening: false, status: 'stopped', errorMessage: intentional ? null : 'Local Whisper sidecar stopped unexpectedly.', chunk: { ...this.status.chunk, pendingResponses: 0 } });
    if (intentional) this.resolvePendingAsStopped();
    else {
      const error = new Error('Local Whisper sidecar stopped.');
      this.rejectWaiters(this.processWaiters, error); this.rejectWaiters(this.modelWaiters, error); this.rejectPending(error);
    }
  }

  private configuredTimeout(name: string, fallback: number) {
    const raw = (this.deps.env ?? process.env)[name]?.trim();
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private audioHeaderSignature(buffer: Buffer) {
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'RIFF/WAVE';
    if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'WebM';
    return Array.from(buffer.subarray(0, 8)).map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  private now() { return this.deps.now?.() ?? Date.now(); }
  private timerSet(callback: () => void, delay: number) { return (this.deps.setTimeout ?? setTimeout)(callback, delay); }
  private timerClear(timeout: NodeJS.Timeout) { (this.deps.clearTimeout ?? clearTimeout)(timeout); }
  private removeFile(filePath: string) { return (this.deps.unlink ?? unlink)(filePath).catch(() => undefined); }
}
