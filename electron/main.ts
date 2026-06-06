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
  modelPhase: 'stopped' | 'starting' | 'model-loading' | 'ready' | 'transcribing' | 'returned-empty-transcript' | 'error';
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
    chunksSentToMain: number;
    chunksReceivedBySidecar: number;
    chunksReturnedFromSidecar: number;
    lastChunkBytes: number;
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
  };
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
let localWhisperSidecarReady = false;
const pendingWhisperRequests = new Map<string, PendingWhisperRequest>();
const sidecarReadyWaiters = new Set<SidecarReadyWaiter>();
let nextWhisperRequestId = 1;
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
    chunksSentToMain: 0,
    chunksReceivedBySidecar: 0,
    chunksReturnedFromSidecar: 0,
    lastChunkBytes: 0,
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
    errorMessage: null
  }
};

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
  mainWindow?.webContents.send('local-whisper:status', localWhisperStatus);
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

function resolveSidecarReadyWaiters() {
  localWhisperSidecarReady = true;
  for (const waiter of sidecarReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }
  sidecarReadyWaiters.clear();
}

function rejectSidecarReadyWaiters(error: Error) {
  localWhisperSidecarReady = false;
  for (const waiter of sidecarReadyWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  sidecarReadyWaiters.clear();
}

function waitForSidecarReady(timeoutMs = 10000) {
  if (localWhisperSidecarReady) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter: SidecarReadyWaiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        sidecarReadyWaiters.delete(waiter);
        reject(new Error('Local Whisper sidecar did not become ready. Check Python and faster-whisper setup.'));
      }, timeoutMs)
    };
    sidecarReadyWaiters.add(waiter);
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
    resolveSidecarReadyWaiters();
    return;
  }
  if (messageType === 'model-loading') {
    patchLocalWhisperStatus({ modelPhase: 'model-loading', status: 'starting', errorMessage: null });
    return;
  }
  if (messageType === 'model-loaded') {
    patchLocalWhisperStatus({ modelPhase: 'ready', status: 'listening', sidecarRunning: true });
    return;
  }
  if (messageType === 'transcript') {
    const requestId = String(message.requestId ?? '');
    const pending = pendingWhisperRequests.get(requestId);
    if (!pending) return;
    pendingWhisperRequests.delete(requestId);
    const text = String(message.text ?? '');
    const historyItem = localWhisperTranscriptHistoryItem(text);
    patchLocalWhisperStatus({
      modelPhase: historyItem.isEmpty ? 'returned-empty-transcript' : 'ready',
      lastTranscriptDelta: historyItem.displayText,
      chunk: {
        ...localWhisperStatus.chunk,
        chunksReturnedFromSidecar: localWhisperStatus.chunk.chunksReturnedFromSidecar + 1,
        lastTranscriptText: historyItem.displayText,
        pendingResponses: Math.max(0, localWhisperStatus.chunk.pendingResponses - 1)
      },
      transcriptHistory: [...localWhisperStatus.transcriptHistory, historyItem].slice(-12)
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
    rejectSidecarReadyWaiters(error);
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
  if (!localWhisperConfigured(settings)) {
    throw new Error('Local Whisper is not configured. Set Python executable and model name.');
  }

  if (!localWhisperProcess) {
    localWhisperBuffer = '';
    localWhisperSidecarReady = false;
    patchLocalWhisperStatus({
      configured: true,
      sidecarRunning: false,
      modelPhase: 'starting',
      listening: true,
      status: 'starting',
      errorMessage: null
    });
    const ready = waitForSidecarReady();
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
      rejectSidecarReadyWaiters(error);
      rejectPendingWhisperRequests(error);
    });
    localWhisperProcess.on('exit', () => {
      localWhisperProcess = null;
      localWhisperSidecarReady = false;
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
      rejectSidecarReadyWaiters(stoppedError);
      rejectPendingWhisperRequests(stoppedError);
    });
    await ready;
  } else if (!localWhisperSidecarReady) {
    await waitForSidecarReady();
  }

  patchLocalWhisperStatus({ sidecarRunning: true, listening: true, status: 'starting' });
  sendLocalWhisperCommand({
    type: 'configure',
    modelName: settings.modelName,
    device: settings.device,
    computeType: settings.computeType
  });
  return localWhisperStatus;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#101418',
    title: 'Narration Prompter',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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

ipcMain.handle('bridge:getDiagnostics', () => ({
  electronBridgeAvailable: true,
  localWhisperBridgeAvailable: true,
  ipcHandlersRegistered: true,
  errorMessage: null
}));

ipcMain.handle('local-whisper:getStatus', () => localWhisperStatus);

ipcMain.handle('local-whisper:start', async (_event, settings: LocalWhisperSettings) => {
  return startLocalWhisperSidecar(settings);
});

ipcMain.handle('local-whisper:stop', () => {
  if (localWhisperProcess?.stdin.writable) {
    sendLocalWhisperCommand({ type: 'shutdown' });
  }
  localWhisperProcess?.kill();
  localWhisperProcess = null;
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
  return localWhisperStatus;
});

ipcMain.handle(
  'local-whisper:transcribeChunk',
  async (_event, payload: { audioData: ArrayBuffer; mimeType: string; settings: LocalWhisperSettings }) => {
    await startLocalWhisperSidecar(payload.settings);
    const tempDir = path.join(app.getPath('temp'), 'narration-prompter-local-whisper');
    await mkdir(tempDir, { recursive: true });
    const extension = payload.mimeType.includes('wav')
      ? 'wav'
      : payload.mimeType.includes('ogg')
        ? 'ogg'
        : 'webm';
    const requestId = String(nextWhisperRequestId++);
    const audioPath = path.join(tempDir, `chunk-${Date.now()}-${requestId}.${extension}`);
    await writeFile(audioPath, Buffer.from(payload.audioData));

    const result = await new Promise<{ text: string; durationSeconds?: number }>((resolve, reject) => {
      pendingWhisperRequests.set(requestId, { resolve, reject, audioPath });
      sendLocalWhisperCommand({
        type: 'transcribe',
        requestId,
        audioPath,
        modelName: payload.settings.modelName,
        device: payload.settings.device,
        computeType: payload.settings.computeType
      });
      patchLocalWhisperStatus({
        modelPhase: 'transcribing',
        chunk: {
          ...localWhisperStatus.chunk,
          chunksReceivedBySidecar: localWhisperStatus.chunk.chunksReceivedBySidecar + 1,
          lastChunkBytes: payload.audioData.byteLength,
          pendingResponses: localWhisperStatus.chunk.pendingResponses + 1,
          warningMessage: null
        }
      });
    });
    return result;
  }
);
