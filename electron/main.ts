import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;

type OpenAiRealtimeConfig = {
  apiKey: string;
  transcriptionModel: string;
  language: string;
  prompt: string;
  webRtcUrl: string;
};

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const DEFAULT_WEBRTC_URL = 'https://api.openai.com/v1/realtime/calls';
const LOCAL_WHISPER_SIDECAR = path.join(__dirname, '..', 'python', 'local_whisper_sidecar.py');
const DEFAULT_PROCESS_READY_TIMEOUT_MS = 30000;
const DEFAULT_MODEL_READY_TIMEOUT_MS = 180000;
const PROVIDER_STATUS_TEXT = new Set([
  'sidecar is running',
  'local whisper sidecar is running',
  'model loading',
  'model loaded',
  'process started',
  'ready'
]);

type LocalWhisperSettings = {
  pythonExecutablePath: string;
  modelName: string;
  device: string;
  computeType: string;
  chunkDurationSeconds: number;
};

type LocalWhisperStatus = {
  providerId: 'local-whisper';
  configured: boolean;
  sidecarRunning: boolean;
  modelPhase: 'stopped' | 'starting' | 'process-started' | 'model-loading' | 'ready' | 'transcribing' | 'returned-empty-transcript' | 'error';
  listening: boolean;
  status: 'idle' | 'starting' | 'listening' | 'error' | 'stopped';
  lastTranscriptDelta: string;
  errorMessage: string | null;
  mic: {
    captureState:
      | 'not-requested'
      | 'requesting-permission'
      | 'permission-granted'
      | 'permission-denied'
      | 'stream-active'
      | 'stream-muted-ended'
      | 'media-recorder-recording'
      | 'chunk-sent'
      | 'chunk-returned';
    inputLevel: number;
    deviceLabel: string;
    monitorActive: boolean;
    errorMessage: string | null;
    log: string[];
  };
  chunk: {
    chunksRecorded: number;
    chunksQueued: number;
    chunksSentToMain: number;
    chunksDropped: number;
    chunksReceivedBySidecar: number;
    chunksReturnedFromSidecar: number;
    chunksEmpty: number;
    chunksFailed: number;
    queueLength: number;
    maxQueueLength: number;
    estimatedQueueLatencyMs: number;
    lastChunkSequence: number;
    processingSequence: number;
    lastTranscriptionDurationMs: number;
    avgTranscriptionDurationMs: number;
    lastRealtimeFactor: number;
    avgRealtimeFactor: number;
    droppedDueToOverflow: number;
    droppedDueToSilence: number;
    staleChunksDropped: number;
    silenceChunksSuppressed: number;
    lastChunkBytes: number;
    lastChunkFormat: string;
    lastMimeType: string;
    lastFileExtension: string;
    lastHeaderSignature: string;
    lastSampleRate: number;
    lastChunkDurationSeconds: number;
    lastTranscriptText: string;
    lastSidecarError: string | null;
    warningMessage: string | null;
    pendingResponses: number;
  };
  transcriptHistory: Array<{
    text: string;
    displayText: string;
    isEmpty: boolean;
    isFinal: boolean;
    timestampMs: number;
    source: 'local-whisper';
  }>;
  bridge: {
    electronBridgeAvailable: boolean;
    localWhisperBridgeAvailable: boolean;
    ipcHandlersRegistered: boolean | null;
    errorMessage: string | null;
    prompterApiType: string;
    pingType: string;
    pingResult: string | null;
    appPath: string | null;
    cwd: string | null;
    mainDirname: string | null;
    preloadPath: string | null;
    preloadExists: boolean | null;
    isDev: boolean | null;
    viteDevServerUrl: string | null;
    preloadErrorMessage: string | null;
    preloadErrorStack: string | null;
    preloadDiagnosticStarted: boolean | null;
    preloadDiagnosticExposed: boolean | null;
    preloadDiagnosticErrorMessage: string | null;
    preloadDiagnosticErrorStack: string | null;
  };
};

type PreloadExposeDiagnostics = {
  started: boolean;
  exposed: boolean;
  errorMessage: string | null;
  errorStack: string | null;
};

type MainPreloadError = {
  preloadPath: string;
  message: string;
  stack: string | null;
};

type MainRuntimeDiagnostics = {
  appPath: string | null;
  cwd: string | null;
  mainDirname: string | null;
  preloadPath: string | null;
  preloadExists: boolean | null;
  isDev: boolean | null;
  viteDevServerUrl: string | null;
  preloadErrorMessage: string | null;
  preloadErrorStack: string | null;
  preloadDiagnosticStarted: boolean | null;
  preloadDiagnosticExposed: boolean | null;
  preloadDiagnosticErrorMessage: string | null;
  preloadDiagnosticErrorStack: string | null;
};

type PendingWhisperRequest = {
  resolve(result: { text: string; durationSeconds?: number }): void;
  reject(error: Error): void;
  audioPath: string;
};

type SidecarReadyWaiter = {
  resolve(): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

let localWhisperProcess: ChildProcessWithoutNullStreams | null = null;
let localWhisperBuffer = '';
let localWhisperSettings: LocalWhisperSettings | null = null;
let localWhisperProcessReady = false;
let localWhisperModelReady = false;
let localWhisperModelConfigKey = '';
const pendingWhisperRequests = new Map<string, PendingWhisperRequest>();
const processReadyWaiters = new Set<SidecarReadyWaiter>();
const modelReadyWaiters = new Set<SidecarReadyWaiter>();
let nextWhisperRequestId = 1;
let latestPreloadDiagnostics: PreloadExposeDiagnostics | null = null;
let latestPreloadError: MainPreloadError | null = null;
let localWhisperStatus: LocalWhisperStatus = {
  providerId: 'local-whisper',
  configured: true,
  sidecarRunning: false,
  modelPhase: 'stopped',
  listening: false,
  status: 'idle',
  lastTranscriptDelta: '',
  errorMessage: null,
  mic: {
    captureState: 'not-requested',
    inputLevel: 0,
    deviceLabel: '',
    monitorActive: false,
    errorMessage: null,
    log: []
  },
  chunk: {
    chunksRecorded: 0,
    chunksQueued: 0,
    chunksSentToMain: 0,
    chunksDropped: 0,
    chunksReceivedBySidecar: 0,
    chunksReturnedFromSidecar: 0,
    chunksEmpty: 0,
    chunksFailed: 0,
    queueLength: 0,
    maxQueueLength: 4,
    estimatedQueueLatencyMs: 0,
    lastChunkSequence: 0,
    processingSequence: 0,
    lastTranscriptionDurationMs: 0,
    avgTranscriptionDurationMs: 0,
    lastRealtimeFactor: 0,
    avgRealtimeFactor: 0,
    droppedDueToOverflow: 0,
    droppedDueToSilence: 0,
    staleChunksDropped: 0,
    silenceChunksSuppressed: 0,
    lastChunkBytes: 0,
    lastChunkFormat: '',
    lastMimeType: '',
    lastFileExtension: '',
    lastHeaderSignature: '',
    lastSampleRate: 0,
    lastChunkDurationSeconds: 0,
    lastTranscriptText: '',
    lastSidecarError: null,
    warningMessage: null,
    pendingResponses: 0
  },
  transcriptHistory: [],
  bridge: {
    electronBridgeAvailable: true,
    localWhisperBridgeAvailable: true,
    ipcHandlersRegistered: true,
    errorMessage: null,
    prompterApiType: 'object',
    pingType: 'function',
    pingResult: 'pong',
    appPath: null,
    cwd: null,
    mainDirname: null,
    preloadPath: null,
    preloadExists: null,
    isDev: null,
    viteDevServerUrl: null,
    preloadErrorMessage: null,
    preloadErrorStack: null,
    preloadDiagnosticStarted: null,
    preloadDiagnosticExposed: null,
    preloadDiagnosticErrorMessage: null,
    preloadDiagnosticErrorStack: null
  }
};

function safeString(value: () => string) {
  try {
    return value();
  } catch (error) {
    return error instanceof Error ? `Unavailable: ${error.message}` : 'Unavailable';
  }
}

function configuredTimeoutMs(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isProviderStatusText(text: string) {
  return PROVIDER_STATUS_TEXT.has(text.trim().replace(/\.$/, '').toLowerCase());
}

function audioHeaderSignature(buffer: Buffer) {
  if (buffer.length >= 12) {
    const riff = buffer.subarray(0, 4).toString('ascii');
    const wave = buffer.subarray(8, 12).toString('ascii');
    if (riff === 'RIFF' && wave === 'WAVE') return 'RIFF/WAVE';
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'WebM';
  }
  return Array.from(buffer.subarray(0, 8))
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function runtimeDiagnostics(preloadPath: string): MainRuntimeDiagnostics {
  return {
    appPath: safeString(() => app.getAppPath()),
    cwd: safeString(() => process.cwd()),
    mainDirname: __dirname,
    preloadPath,
    preloadExists: existsSync(preloadPath),
    isDev,
    viteDevServerUrl: process.env.VITE_DEV_SERVER_URL ?? null,
    preloadErrorMessage: latestPreloadError?.message ?? null,
    preloadErrorStack: latestPreloadError?.stack ?? null,
    preloadDiagnosticStarted: latestPreloadDiagnostics?.started ?? null,
    preloadDiagnosticExposed: latestPreloadDiagnostics?.exposed ?? null,
    preloadDiagnosticErrorMessage: latestPreloadDiagnostics?.errorMessage ?? null,
    preloadDiagnosticErrorStack: latestPreloadDiagnostics?.errorStack ?? null
  };
}

function currentPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function mainBridgeDiagnostics() {
  const diagnostics = runtimeDiagnostics(currentPreloadPath());
  return {
    electronBridgeAvailable: true,
    localWhisperBridgeAvailable: true,
    ipcHandlersRegistered: true,
    errorMessage: latestPreloadError?.message ?? latestPreloadDiagnostics?.errorMessage ?? null,
    prompterApiType: 'object',
    pingType: 'function',
    pingResult: 'pong',
    ...diagnostics
  };
}

function localWhisperStatusForRenderer(): LocalWhisperStatus {
  return {
    ...localWhisperStatus,
    bridge: mainBridgeDiagnostics()
  };
}

function logRuntimeDiagnostics(preloadPath: string) {
  const diagnostics = runtimeDiagnostics(preloadPath);
  console.log('[main] Electron runtime diagnostics', diagnostics);
}

function publishPreloadErrorToRenderer() {
  if (!mainWindow || !latestPreloadError) return;
  const payload = JSON.stringify(latestPreloadError).replace(/</g, '\\u003c');
  void mainWindow.webContents.executeJavaScript(
    `window.__prompterMainPreloadError = ${payload};` +
      `window.dispatchEvent(new CustomEvent('prompter-main-preload-error', { detail: ${payload} }));`
  ).catch((error) => {
    console.error('[main] failed to publish preload error to renderer', error);
  });
}

function parseEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const existing = process.env[key];
    if (existing) continue;

    const rawValue = trimmed.slice(separator + 1).trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

function loadLocalEnv() {
  const roots = Array.from(new Set([process.cwd(), app.getAppPath()]));
  for (const root of roots) {
    parseEnvFile(path.join(root, '.env.local'));
    parseEnvFile(path.join(root, '.env'));
  }
}

function getOpenAiRealtimeConfig(): OpenAiRealtimeConfig | null {
  loadLocalEnv();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    transcriptionModel:
      process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
    language: process.env.OPENAI_REALTIME_LANGUAGE?.trim() || 'en',
    prompt: process.env.OPENAI_REALTIME_TRANSCRIPTION_PROMPT?.trim() || '',
    webRtcUrl: process.env.OPENAI_REALTIME_WEBRTC_URL?.trim() || DEFAULT_WEBRTC_URL
  };
}

function configuredRealtimeStatus() {
  const config = getOpenAiRealtimeConfig();
  return {
    configured: Boolean(config),
    providerId: 'openai-realtime' as const,
    model: config?.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL,
    language: config?.language ?? 'en',
    promptConfigured: Boolean(config?.prompt)
  };
}

function sanitizeOpenAiError(status: number, body: string) {
  if (status === 401) return 'OpenAI authentication failed. Check OPENAI_API_KEY.';
  if (status === 429) return 'OpenAI Realtime rate limit hit. Try again later.';
  if (status >= 500) return 'OpenAI Realtime service error. Try again later.';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message || `OpenAI Realtime request failed with status ${status}.`;
  } catch {
    return `OpenAI Realtime request failed with status ${status}.`;
  }
}

function localWhisperConfigured(settings: LocalWhisperSettings) {
  return Boolean(settings.pythonExecutablePath.trim() && settings.modelName.trim());
}

function localWhisperSettingsKey(settings: LocalWhisperSettings) {
  return `${settings.modelName}\n${settings.device}\n${settings.computeType}`;
}

function patchLocalWhisperStatus(patch: Partial<LocalWhisperStatus>) {
  localWhisperStatus = {
    ...localWhisperStatus,
    ...patch,
    providerId: 'local-whisper',
    configured: localWhisperSettings ? localWhisperConfigured(localWhisperSettings) : true,
    mic: {
      ...localWhisperStatus.mic,
      ...patch.mic,
      log: patch.mic?.log ?? localWhisperStatus.mic.log
    },
    chunk: {
      ...localWhisperStatus.chunk,
      ...patch.chunk
    },
    transcriptHistory: patch.transcriptHistory ?? localWhisperStatus.transcriptHistory
  };
  mainWindow?.webContents.send('local-whisper:status', localWhisperStatusForRenderer());
}

function localWhisperTranscriptHistoryItem(text: string) {
  const trimmed = text.trim();
  return {
    text: trimmed,
    displayText: trimmed || '[empty transcript]',
    isEmpty: trimmed.length === 0,
    isFinal: true,
    timestampMs: Date.now(),
    source: 'local-whisper' as const
  };
}

function sidecarPath() {
  const devPath = path.join(process.cwd(), 'python', 'local_whisper_sidecar.py');
  return existsSync(devPath) ? devPath : LOCAL_WHISPER_SIDECAR;
}

function sendLocalWhisperCommand(command: Record<string, unknown>) {
  if (!localWhisperProcess?.stdin.writable) {
    throw new Error('Local Whisper sidecar is not running.');
  }
  localWhisperProcess.stdin.write(`${JSON.stringify(command)}\n`);
}

function resolveProcessReadyWaiters() {
  localWhisperProcessReady = true;
  for (const waiter of processReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
  processReadyWaiters.clear();
}

function resolveModelReadyWaiters() {
  localWhisperModelReady = true;
  for (const waiter of modelReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
  modelReadyWaiters.clear();
}

function rejectProcessReadyWaiters(error: Error) {
  localWhisperProcessReady = false;
  for (const waiter of processReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  processReadyWaiters.clear();
}

function rejectModelReadyWaiters(error: Error) {
  localWhisperModelReady = false;
  for (const waiter of modelReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  modelReadyWaiters.clear();
}

function waitForProcessReady(timeoutMs = DEFAULT_PROCESS_READY_TIMEOUT_MS) {
  if (localWhisperProcessReady) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter: SidecarReadyWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        processReadyWaiters.delete(waiter);
        reject(new Error('Local Whisper sidecar process did not become ready. Check Python setup.'));
      }, timeoutMs)
    };
    processReadyWaiters.add(waiter);
  });
}

function waitForModelReady(timeoutMs = configuredTimeoutMs('LOCAL_WHISPER_MODEL_READY_TIMEOUT_MS', DEFAULT_MODEL_READY_TIMEOUT_MS)) {
  if (localWhisperModelReady) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter: SidecarReadyWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        modelReadyWaiters.delete(waiter);
        reject(new Error('Local Whisper model did not finish loading. Check model name, device, compute type, and faster-whisper setup.'));
      }, timeoutMs)
    };
    modelReadyWaiters.add(waiter);
  });
}

function rejectPendingWhisperRequests(error: Error) {
  for (const request of pendingWhisperRequests.values()) {
    request.reject(error);
    void unlink(request.audioPath).catch(() => undefined);
  }
  pendingWhisperRequests.clear();
}

function handleLocalWhisperMessage(message: Record<string, unknown>) {
  const messageType = message.type;
  if (messageType === 'ready') {
    patchLocalWhisperStatus({
      sidecarRunning: true,
      modelPhase: 'process-started',
      status: 'starting',
      errorMessage: null
    });
    resolveProcessReadyWaiters();
    return;
  }
  if (messageType === 'model-loading') {
    localWhisperModelReady = false;
    patchLocalWhisperStatus({ sidecarRunning: true, modelPhase: 'model-loading', status: 'starting', errorMessage: null });
    return;
  }
  if (messageType === 'model-loaded') {
    localWhisperModelConfigKey = [
      String(message.modelName ?? localWhisperSettings?.modelName ?? ''),
      String(message.device ?? localWhisperSettings?.device ?? ''),
      String(message.computeType ?? localWhisperSettings?.computeType ?? '')
    ].join('\n');
    resolveModelReadyWaiters();
    patchLocalWhisperStatus({ modelPhase: 'ready', status: 'listening', sidecarRunning: true });
    return;
  }
  if (messageType === 'transcribe-start') {
    patchLocalWhisperStatus({
      modelPhase: 'transcribing',
      chunk: {
        ...localWhisperStatus.chunk,
        lastChunkBytes: Number(message.fileSizeBytes ?? localWhisperStatus.chunk.lastChunkBytes) || localWhisperStatus.chunk.lastChunkBytes,
        lastChunkFormat: String(message.audioFormat ?? localWhisperStatus.chunk.lastChunkFormat ?? ''),
        lastMimeType: String(message.mimeType ?? localWhisperStatus.chunk.lastMimeType ?? ''),
        lastHeaderSignature: String(message.headerSignature ?? localWhisperStatus.chunk.lastHeaderSignature ?? ''),
        warningMessage: null
      }
    });
    return;
  }
  if (messageType === 'transcript') {
    const requestId = String(message.requestId ?? '');
    const pending = pendingWhisperRequests.get(requestId);
    if (!pending) return;
    pendingWhisperRequests.delete(requestId);
    const text = String(message.text ?? '');
    if (isProviderStatusText(text)) {
      patchLocalWhisperStatus({
        modelPhase: 'ready',
        chunk: {
          ...localWhisperStatus.chunk,
          pendingResponses: Math.max(0, localWhisperStatus.chunk.pendingResponses - 1),
          warningMessage: null
        }
      });
      pending.resolve({ text: '' });
      void unlink(pending.audioPath).catch(() => undefined);
      return;
    }
    const historyItem = localWhisperTranscriptHistoryItem(text);
    patchLocalWhisperStatus({
      modelPhase: historyItem.isEmpty ? 'returned-empty-transcript' : 'ready',
      lastTranscriptDelta: historyItem.displayText,
      chunk: {
        ...localWhisperStatus.chunk,
        chunksReturnedFromSidecar: localWhisperStatus.chunk.chunksReturnedFromSidecar + 1,
        lastTranscriptText: historyItem.displayText,
        lastSidecarError: null,
        warningMessage: null,
        pendingResponses: Math.max(0, localWhisperStatus.chunk.pendingResponses - 1)
      },
      transcriptHistory: [...localWhisperStatus.transcriptHistory, historyItem].slice(-25)
    });
    pending.resolve({
      text,
      durationSeconds: typeof message.durationSeconds === 'number' ? message.durationSeconds : undefined
    });
    void unlink(pending.audioPath).catch(() => undefined);
    return;
  }
  if (messageType === 'error') {
    const error = new Error(String(message.message ?? 'Local Whisper sidecar error.'));
    const requestId = String(message.requestId ?? '');
    const pending = requestId ? pendingWhisperRequests.get(requestId) : undefined;
    if (pending) {
      pendingWhisperRequests.delete(requestId);
      pending.reject(error);
      void unlink(pending.audioPath).catch(() => undefined);
      patchLocalWhisperStatus({
        modelPhase: 'error',
        status: 'error',
        errorMessage: error.message,
        chunk: {
          ...localWhisperStatus.chunk,
          chunksReturnedFromSidecar: localWhisperStatus.chunk.chunksReturnedFromSidecar + 1,
          lastSidecarError: error.message,
          warningMessage: error.message,
          pendingResponses: Math.max(0, localWhisperStatus.chunk.pendingResponses - 1)
        }
      });
      return;
    }
    patchLocalWhisperStatus({
      modelPhase: 'error',
      status: 'error',
      errorMessage: error.message,
      chunk: {
        ...localWhisperStatus.chunk,
        lastSidecarError: error.message,
        warningMessage: error.message,
        pendingResponses: 0
      }
    });
    rejectProcessReadyWaiters(error);
    rejectModelReadyWaiters(error);
    rejectPendingWhisperRequests(error);
  }
}

function handleLocalWhisperStdout(chunk: Buffer) {
  localWhisperBuffer += chunk.toString('utf8');
  let newlineIndex = localWhisperBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = localWhisperBuffer.slice(0, newlineIndex).trim();
    localWhisperBuffer = localWhisperBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        handleLocalWhisperMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        patchLocalWhisperStatus({
          modelPhase: 'error',
          status: 'error',
          errorMessage: 'Invalid Local Whisper sidecar response.',
          chunk: {
            ...localWhisperStatus.chunk,
            lastSidecarError: 'Invalid Local Whisper sidecar response.',
            warningMessage: 'Invalid Local Whisper sidecar response.'
          }
        });
      }
    }
    newlineIndex = localWhisperBuffer.indexOf('\n');
  }
}

async function startLocalWhisperSidecar(settings: LocalWhisperSettings) {
  localWhisperSettings = settings;
  const requestedModelKey = localWhisperSettingsKey(settings);
  if (localWhisperModelConfigKey && localWhisperModelConfigKey !== requestedModelKey) {
    localWhisperModelReady = false;
  }
  if (!localWhisperConfigured(settings)) {
    throw new Error('Local Whisper is not configured. Set Python executable and model name.');
  }

  if (!localWhisperProcess) {
    localWhisperBuffer = '';
    localWhisperProcessReady = false;
    localWhisperModelReady = false;
    localWhisperModelConfigKey = '';
    patchLocalWhisperStatus({
      configured: true,
      sidecarRunning: false,
      modelPhase: 'starting',
      listening: true,
      status: 'starting',
      errorMessage: null,
      lastTranscriptDelta: '',
      transcriptHistory: [],
      chunk: {
        ...localWhisperStatus.chunk,
        lastTranscriptText: '',
        lastSidecarError: null,
        warningMessage: null,
        pendingResponses: 0
        // new latency/stale/silence/rt fields carried via spread
      }
    });
    const processReady = waitForProcessReady();
    localWhisperProcess = spawn(settings.pythonExecutablePath, [sidecarPath()], {
      cwd: process.cwd(),
      windowsHide: true
    });
    localWhisperProcess.stdout.on('data', handleLocalWhisperStdout);
    localWhisperProcess.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        const errorMessage = message.slice(0, 500);
        patchLocalWhisperStatus({
          errorMessage,
          chunk: {
            ...localWhisperStatus.chunk,
            lastSidecarError: errorMessage
          }
        });
      }
    });
    localWhisperProcess.on('error', (error) => {
      localWhisperProcess = null;
      patchLocalWhisperStatus({
        sidecarRunning: false,
        modelPhase: 'error',
        listening: false,
        status: 'error',
        errorMessage: error.message
      });
      rejectProcessReadyWaiters(error);
      rejectModelReadyWaiters(error);
      rejectPendingWhisperRequests(error);
    });
    localWhisperProcess.on('exit', () => {
      localWhisperProcess = null;
      localWhisperProcessReady = false;
      localWhisperModelReady = false;
      localWhisperModelConfigKey = '';
      patchLocalWhisperStatus({
        sidecarRunning: false,
        modelPhase: 'stopped',
        listening: false,
        status: 'stopped',
        chunk: {
          ...localWhisperStatus.chunk,
          pendingResponses: 0
        }
      });
      const stoppedError = new Error('Local Whisper sidecar stopped.');
      rejectProcessReadyWaiters(stoppedError);
      rejectModelReadyWaiters(stoppedError);
      rejectPendingWhisperRequests(stoppedError);
    });
    await processReady;
  } else if (!localWhisperProcessReady) {
    await waitForProcessReady();
  }

  patchLocalWhisperStatus({ sidecarRunning: true, listening: true, status: 'starting' });
  if (!localWhisperModelReady || localWhisperModelConfigKey !== requestedModelKey) {
    const modelReady = waitForModelReady();
    try {
      sendLocalWhisperCommand({
        type: 'configure',
        modelName: settings.modelName,
        device: settings.device,
        computeType: settings.computeType
      });
    } catch (error) {
      rejectModelReadyWaiters(error instanceof Error ? error : new Error('Local Whisper configure command failed.'));
      throw error;
    }
    await modelReady;
  }
  patchLocalWhisperStatus({ sidecarRunning: true, listening: true, status: 'listening', modelPhase: 'ready' });
  return localWhisperStatusForRenderer();
}

function createMainWindow() {
  const preloadPath = currentPreloadPath();
  logRuntimeDiagnostics(preloadPath);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#101418',
    title: 'Narration Prompter',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.on('preload-error', (_event, failedPreloadPath, error) => {
    latestPreloadError = {
      preloadPath: failedPreloadPath,
      message: error.message,
      stack: error.stack ?? null
    };
    console.error('[main] preload-error', latestPreloadError);
    publishPreloadErrorToRenderer();
  });

  mainWindow.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    const levelName = ['verbose', 'info', 'warning', 'error'][level] ?? String(level);
    console.log(`[renderer-console:${levelName}] ${message} (${sourceId}:${lineNumber})`);
  });

  mainWindow.webContents.on('did-finish-load', publishPreloadErrorToRenderer);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:openTextFile', async () => {
  const owner = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options = {
    title: 'Import manuscript',
    properties: ['openFile'],
    filters: [
      { name: 'Text and Markdown', extensions: ['txt', 'md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  } satisfies Electron.OpenDialogOptions;
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const text = await readFile(filePath, 'utf8');
  return {
    filePath,
    name: path.basename(filePath),
    text
  };
});

ipcMain.handle('window:toggleFullScreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

ipcMain.handle('window:toggleAlwaysOnTop', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver');
  return win.isAlwaysOnTop();
});

ipcMain.handle('openai-realtime:getConfigStatus', () => configuredRealtimeStatus());

ipcMain.handle('openai-realtime:createClientSession', async () => {
  const config = getOpenAiRealtimeConfig();
  if (!config) {
    throw new Error('Live OpenAI Realtime is not configured. Set OPENAI_API_KEY outside the renderer.');
  }

  const session = {
    type: 'transcription',
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        transcription: {
          model: config.transcriptionModel,
          language: config.language,
          prompt: config.prompt
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }
  };

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ session })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(sanitizeOpenAiError(response.status, bodyText));
  }

  const data = JSON.parse(bodyText) as {
    value?: string;
    expires_at?: number;
    client_secret?: {
      value?: string;
      expires_at?: number;
    };
  };
  const clientSecret = data.client_secret?.value ?? data.value;
  const expiresAt = data.client_secret?.expires_at ?? data.expires_at;

  if (!clientSecret) {
    throw new Error('OpenAI Realtime did not return an ephemeral client secret.');
  }

  return {
    clientSecret,
    expiresAt,
    webRtcUrl: config.webRtcUrl,
    model: config.transcriptionModel
  };
});

ipcMain.on('preload:diagnostic', (_event, diagnostics: PreloadExposeDiagnostics) => {
  latestPreloadDiagnostics = {
    started: Boolean(diagnostics.started),
    exposed: Boolean(diagnostics.exposed),
    errorMessage: diagnostics.errorMessage ? String(diagnostics.errorMessage) : null,
    errorStack: diagnostics.errorStack ? String(diagnostics.errorStack) : null
  };
  console.log('[main] preload diagnostic', latestPreloadDiagnostics);
});

ipcMain.handle('bridge:getDiagnostics', () => {
  return mainBridgeDiagnostics();
});

ipcMain.handle('local-whisper:getStatus', () => localWhisperStatusForRenderer());

ipcMain.handle('local-whisper:start', async (_event, settings: LocalWhisperSettings) => {
  return startLocalWhisperSidecar(settings);
});

ipcMain.handle('local-whisper:stop', () => {
  if (localWhisperProcess?.stdin.writable) {
    sendLocalWhisperCommand({ type: 'shutdown' });
  }
  localWhisperProcess?.kill();
  localWhisperProcess = null;
  localWhisperProcessReady = false;
  localWhisperModelReady = false;
  localWhisperModelConfigKey = '';
  patchLocalWhisperStatus({
    sidecarRunning: false,
    modelPhase: 'stopped',
    listening: false,
    status: 'stopped',
    errorMessage: null,
    chunk: {
      ...localWhisperStatus.chunk,
      pendingResponses: 0
    }
  });
  return localWhisperStatusForRenderer();
});

ipcMain.handle(
  'local-whisper:transcribeChunk',
  async (_event, payload: {
    audioData: ArrayBuffer;
    mimeType: string;
    format?: string;
    extension?: string;
    sampleRate?: number;
    durationSeconds?: number;
    headerSignature?: string;
    settings: LocalWhisperSettings;
  }) => {
    await startLocalWhisperSidecar(payload.settings);
    const tempDir = path.join(app.getPath('temp'), 'narration-prompter-local-whisper');
    await mkdir(tempDir, { recursive: true });
    const audioBuffer = Buffer.from(payload.audioData);
    const detectedHeaderSignature = audioHeaderSignature(audioBuffer);
    const format = payload.format || (payload.mimeType.includes('wav') ? 'wav' : payload.mimeType.includes('ogg') ? 'ogg' : payload.mimeType.includes('webm') ? 'webm' : 'other');
    const extension = payload.extension || (payload.mimeType.includes('wav')
      ? 'wav'
      : payload.mimeType.includes('ogg')
        ? 'ogg'
        : payload.mimeType.includes('webm')
          ? 'webm'
          : 'bin');
    const headerSignature = payload.headerSignature || detectedHeaderSignature;
    const requestId = String(nextWhisperRequestId++);
    const audioPath = path.join(tempDir, `chunk-${Date.now()}-${requestId}.${extension}`);
    await writeFile(audioPath, audioBuffer);

    const result = await new Promise<{ text: string; durationSeconds?: number }>((resolve, reject) => {
      pendingWhisperRequests.set(requestId, { resolve, reject, audioPath });
      sendLocalWhisperCommand({
        type: 'transcribe',
        requestId,
        audioPath,
        audioFormat: format,
        mimeType: payload.mimeType,
        fileSizeBytes: audioBuffer.byteLength,
        headerSignature,
        sampleRate: payload.sampleRate,
        chunkDurationSeconds: payload.durationSeconds,
        modelName: payload.settings.modelName,
        device: payload.settings.device,
        computeType: payload.settings.computeType
      });
      patchLocalWhisperStatus({
        modelPhase: 'transcribing',
        chunk: {
          ...localWhisperStatus.chunk,
          chunksReceivedBySidecar: localWhisperStatus.chunk.chunksReceivedBySidecar + 1,
          lastChunkBytes: audioBuffer.byteLength,
          lastChunkFormat: format,
          lastMimeType: payload.mimeType,
          lastFileExtension: extension,
          lastHeaderSignature: headerSignature,
          lastSampleRate: payload.sampleRate ?? 0,
          lastChunkDurationSeconds: payload.durationSeconds ?? 0,
          pendingResponses: localWhisperStatus.chunk.pendingResponses + 1,
          warningMessage: null
        }
      });
    });
    return result;
  }
);
