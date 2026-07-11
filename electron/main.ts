import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOpenAiRealtimeTranscriptionSession,
  inspectOpenAiRealtimeSdpOffer,
  isOpenAiRealtimeFlagEnabled,
  validateOpenAiRealtimeSdpOffer
} from './openAiRealtimeSession.js';
import { importManuscriptFile } from './manuscriptImport.js';
import {
  devEnvFileRoots,
  resolveRendererIndexPath,
  type RuntimePathContext
} from './runtimePaths.js';
import {
  WhisperTranscriptionService
} from './whisper/WhisperTranscriptionService.js';
import type { LocalWhisperSettings } from '#prompter-shared/domain/types.js';
import type { RendererSessionSync } from '#prompter-shared/protocol/messages.js';
import { PairedDeviceStore } from './server/PairedDeviceStore.js';
import { PairingService } from './server/PairingService.js';
import { DiscoveryService } from './server/DiscoveryService.js';
import { ServerSessionBridge } from './server/ServerSessionBridge.js';
import { PrompterServer } from './server/PrompterServer.js';
import { ProtocolValidator } from './server/ProtocolValidator.js';
import { TrayController } from './tray/TrayController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'com.narrationprompter.prompter';
const isDev = !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow: BrowserWindow | null = null;
let lastKnownWindowMaximized = false;
let prompterServer: PrompterServer | null = null;
let trayController: TrayController | null = null;
let quitting = false;
const serverSession = new ServerSessionBridge();

type OpenAiRealtimeConfig = {
  apiKey: string;
  transcriptionModel: string;
  language: string;
  prompt?: string;
};

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const DEFAULT_WEBRTC_URL = 'https://api.openai.com/v1/realtime/calls';
const WINDOW_STATE_FILE = 'window-state.json';
const APP_LOG_FILE = 'prompter-main.log';

app.setAppUserModelId(APP_ID);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

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
  localWhisperSidecarExecutablePath: string | null;
  localWhisperSidecarScriptPath: string | null;
  localWhisperModelPath: string | null;
  localWhisperSidecarWorkingDirectory: string | null;
  localWhisperUsesBundledSidecar: boolean | null;
  localWhisperSidecarProcessId: number | null;
};

let latestPreloadDiagnostics: PreloadExposeDiagnostics | null = null;
let latestPreloadError: MainPreloadError | null = null;

function safeString(value: () => string) {
  try {
    return value();
  } catch (error) {
    return error instanceof Error ? `Unavailable: ${error.message}` : 'Unavailable';
  }
}

function runtimePathContext(): RuntimePathContext {
  return {
    isPackaged: app.isPackaged,
    appPath: safeString(() => app.getAppPath()),
    mainDirname: __dirname,
    resourcesPath: process.resourcesPath,
    env: process.env
  };
}

function appendDiagnosticLog(event: string, data: Record<string, unknown>) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      path.join(logDir, APP_LOG_FILE),
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn('[main] failed to write diagnostic log', error);
  }
}

function stableServerId() {
  const serverDirectory = path.join(app.getPath('userData'), 'tablet-server');
  const serverIdPath = path.join(serverDirectory, 'server-id.txt');
  try {
    const existing = readFileSync(serverIdPath, 'utf8').trim();
    if (existing) return existing;
  } catch { /* created below */ }
  const serverId = randomUUID();
  mkdirSync(serverDirectory, { recursive: true });
  writeFileSync(serverIdPath, serverId, 'utf8');
  return serverId;
}

async function initializeTabletServer() {
  const devices = PairedDeviceStore.underUserData(app.getPath('userData'), safeStorage);
  await devices.load();
  const pairing = new PairingService(devices, async (request) => {
    const options: Electron.MessageBoxOptions = {
      type: 'question', title: 'Pair tablet', message: `Pair ${request.deviceName}?`,
      detail: `Model: ${request.model ?? 'Unknown'}\nDevice ID: ${request.deviceId}\nAddress: ${request.remoteAddress}`,
      buttons: ['Approve', 'Deny'], defaultId: 1, cancelId: 1, noLink: true
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    return { approved: result.response === 0 };
  });
  const discovery = new DiscoveryService();
  const protocolSchemaRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'protocol-schemas')
    : path.join(app.getAppPath(), 'shared', 'protocol', 'schemas');
  prompterServer = new PrompterServer({
    serverId: stableServerId(), productVersion: app.getVersion(), computerName: hostname(),
    port: Number(process.env.PROMPTER_SERVER_PORT || 43127), pairing, devices, discovery, session: serverSession,
    protocolValidator: new ProtocolValidator(protocolSchemaRoot),
    whisperSettings: {
      pythonExecutablePath: 'python', modelName: 'base.en', device: 'cpu', computeType: 'int8', chunkDurationSeconds: 2
    },
    transcribe: (chunk, settings) => whisperService.transcribe({
      audioData: Uint8Array.from(chunk.wav).buffer,
      mimeType: 'audio/wav', format: 'wav', extension: 'wav', sampleRate: chunk.sampleRate,
      durationSeconds: chunk.durationSeconds, headerSignature: chunk.wav.subarray(0, 12).toString('hex'), settings
    })
  });
  trayController = new TrayController({
    openPrompter: restoreMainWindow,
    toggleServer: async () => {
      try {
        if (prompterServer?.getStatus().enabled) await prompterServer.disable();
        else await prompterServer?.enable();
      } catch (error) {
        appendDiagnosticLog('tablet-server-toggle-error', { message: error instanceof Error ? error.message : String(error) });
      }
    },
    pairTablet: () => {
      try { prompterServer?.startPairing(); }
      catch (error) { dialog.showErrorBox('Tablet pairing unavailable', error instanceof Error ? error.message : String(error)); }
    },
    disconnectDevice: (deviceId) => prompterServer?.disconnectDevice(deviceId),
    forgetDevice: async (deviceId) => { await prompterServer?.forgetDevice(deviceId); },
    showDiagnostics: () => void dialog.showMessageBox({
      title: 'Prompter tablet server diagnostics', type: 'info', buttons: ['OK'],
      message: 'Tablet server diagnostics', detail: JSON.stringify(prompterServer?.diagnostics() ?? { enabled: false }, null, 2)
    }),
    quit: shutdownAndQuit
  });
  trayController.create(prompterServer.getStatus());
  prompterServer.onStatus((status) => {
    trayController?.update(status);
    mainWindow?.webContents.send('tablet-server:status', status);
    appendDiagnosticLog('tablet-server-status', {
      state: status.state, bindAddress: status.bindAddress, port: status.port, lastError: status.lastError
    });
  });
  serverSession.onState((state) => {
    if (serverSession.getAuthority() === 'tablet') mainWindow?.webContents.send('tablet-server:sessionState', {
      origin: 'tablet', deviceId: serverSession.getControllerDeviceId(), state
    });
  });
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

async function shutdownAndQuit() {
  if (quitting) return;
  quitting = true;
  try {
    prompterServer?.stopPairing();
    await prompterServer?.shutdown();
    await whisperService.stop();
    trayController?.destroy();
  } finally {
    app.quit();
  }
}

const whisperService = new WhisperTranscriptionService({
  runtimePathContext,
  getUserDataPath: () => app.getPath('userData'),
  getTempPath: () => app.getPath('temp'),
  appendDiagnosticLog,
  publishStatus: (status) => {
    mainWindow?.webContents.send('local-whisper:status', {
      ...status,
      bridge: mainBridgeDiagnostics()
    });
  }
});

function runtimeDiagnostics(preloadPath: string): MainRuntimeDiagnostics {
  return {
    appPath: safeString(() => app.getAppPath()),
    cwd: safeString(() => process.cwd()),
    mainDirname: __dirname,
    preloadPath,
    preloadExists: existsSync(preloadPath),
    isDev,
    viteDevServerUrl: isDev ? process.env.VITE_DEV_SERVER_URL ?? null : null,
    preloadErrorMessage: latestPreloadError?.message ?? null,
    preloadErrorStack: latestPreloadError?.stack ?? null,
    preloadDiagnosticStarted: latestPreloadDiagnostics?.started ?? null,
    preloadDiagnosticExposed: latestPreloadDiagnostics?.exposed ?? null,
    preloadDiagnosticErrorMessage: latestPreloadDiagnostics?.errorMessage ?? null,
    preloadDiagnosticErrorStack: latestPreloadDiagnostics?.errorStack ?? null,
    ...whisperService.getRuntimeDiagnostics()
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

function localWhisperStatusForRenderer() {
  return {
    ...whisperService.getStatus(),
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
  for (const root of devEnvFileRoots(runtimePathContext())) {
    parseEnvFile(path.join(root, '.env.local'));
    parseEnvFile(path.join(root, '.env'));
  }
}

function isOpenAiRealtimeEnabled() {
  loadLocalEnv();
  return isOpenAiRealtimeFlagEnabled(process.env.OPENAI_REALTIME_ENABLED);
}

function getOpenAiRealtimeConfig(): OpenAiRealtimeConfig | null {
  loadLocalEnv();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  const prompt = process.env.OPENAI_REALTIME_TRANSCRIPTION_PROMPT?.trim();

  return {
    apiKey,
    transcriptionModel:
      process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL,
    language: process.env.OPENAI_REALTIME_LANGUAGE?.trim() || 'en',
    ...(prompt ? { prompt } : {})
  };
}

function configuredRealtimeStatus() {
  const enabled = isOpenAiRealtimeEnabled();
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      providerId: 'openai-realtime' as const,
      model: DEFAULT_TRANSCRIPTION_MODEL,
      language: 'en',
      promptConfigured: false
    };
  }

  const config = getOpenAiRealtimeConfig();
  return {
    enabled: true,
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
    return body || `OpenAI Realtime request failed with status ${status}.`;
  }
}

function sanitizeOpenAiDiagnosticText(value: string, prompt?: string) {
  let sanitized = value
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted-key]')
    .replace(/"(api_key|client_secret|value)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"');
  if (prompt) sanitized = sanitized.split(prompt).join('[redacted-prompt]');
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function openAiFetchErrorDetails(error: unknown, prompt?: string) {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause
      ? `; cause=${error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}` : String(error.cause)}`
      : '';
    return sanitizeOpenAiDiagnosticText(`${error.name}: ${error.message}${cause}`, prompt);
  }
  return sanitizeOpenAiDiagnosticText(String(error), prompt);
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

type WindowBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

type PersistedWindowState = {
  normalBounds: WindowBounds;
  isMaximized: boolean;
};

function rectsIntersect(r1: { x: number; y: number; width: number; height: number }, r2: { x: number; y: number; width: number; height: number }): boolean {
  return !(r1.x + r1.width < r2.x ||
           r1.x > r2.x + r2.width ||
           r1.y + r1.height < r2.y ||
           r1.y > r2.y + r2.height);
}

function persistedBoundsCandidate(saved: any): any {
  return saved && typeof saved.normalBounds === 'object' ? saved.normalBounds : saved;
}

function getValidatedWindowBounds(saved: any): WindowBounds {
  const defaults = { width: 1440, height: 920 };
  const bounds = persistedBoundsCandidate(saved);
  if (!bounds || typeof bounds.width !== 'number' || typeof bounds.height !== 'number') {
    return defaults;
  }
  const candidate = {
    x: typeof bounds.x === 'number' ? bounds.x : 0,
    y: typeof bounds.y === 'number' ? bounds.y : 0,
    width: Math.max(1080, Math.round(bounds.width)),
    height: Math.max(720, Math.round(bounds.height))
  };
  const displays = screen.getAllDisplays();
  const visible = displays.some(d => rectsIntersect(candidate, d.bounds));
  if (visible) {
    return candidate;
  }
  // saved monitor missing or off-screen: center on primary
  const primary = screen.getPrimaryDisplay().bounds;
  return {
    width: candidate.width,
    height: candidate.height,
    x: Math.round(primary.x + (primary.width - candidate.width) / 2),
    y: Math.round(primary.y + (primary.height - candidate.height) / 2)
  };
}

function loadWindowStateSync(): PersistedWindowState | null {
  const statePath = getWindowStatePath();
  if (!existsSync(statePath)) return null;

  try {
    const raw = readFileSync(statePath, 'utf8');
    const saved = JSON.parse(raw);
    return {
      normalBounds: getValidatedWindowBounds(saved),
      isMaximized: Boolean(saved?.isMaximized)
    };
  } catch (err) {
    console.warn('[main] failed to load/validate window state, using defaults', err);
    return null;
  }
}

function saveWindowStateSync(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const normalBounds = mainWindow.getNormalBounds();
    const isMaximized =
      !mainWindow.isFullScreen() &&
      (mainWindow.isMaximized() || (mainWindow.isMinimized() && lastKnownWindowMaximized));
    const state: PersistedWindowState = {
      normalBounds,
      isMaximized
    };
    const statePath = getWindowStatePath();
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  } catch (err) {
    console.warn('[main] failed to save window state', err);
  }
}

function createMainWindow() {
  const preloadPath = currentPreloadPath();
  logRuntimeDiagnostics(preloadPath);

  // Restore persisted bounds if valid against current displays.
  let windowOptions: Electron.BrowserWindowConstructorOptions = {
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
  };

  const savedWindowState = loadWindowStateSync();
  if (savedWindowState) {
    windowOptions = {
      ...windowOptions,
      x: savedWindowState.normalBounds.x,
      y: savedWindowState.normalBounds.y,
      width: savedWindowState.normalBounds.width,
      height: savedWindowState.normalBounds.height
    };
  }

  lastKnownWindowMaximized = Boolean(savedWindowState?.isMaximized);
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.on('maximize', () => {
    lastKnownWindowMaximized = true;
  });

  mainWindow.on('unmaximize', () => {
    lastKnownWindowMaximized = false;
  });

  mainWindow.on('close', () => {
    saveWindowStateSync();
  });

  // Ensure bounds are persisted on app quit paths (File → Exit, etc.)
  app.on('before-quit', () => {
    saveWindowStateSync();
  });

  if (savedWindowState?.isMaximized) {
    mainWindow.maximize();
  }

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
    mainWindow.loadFile(resolveRendererIndexPath(runtimePathContext()));
  }
}

app.on('second-instance', restoreMainWindow);

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  createMainWindow();
  await initializeTabletServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void shutdownAndQuit();
  }
});

app.on('before-quit', (event) => {
  if (!quitting) {
    event.preventDefault();
    void shutdownAndQuit();
  }
});

async function openManuscriptFile() {
  const owner = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const options = {
    title: 'Import manuscript',
    properties: ['openFile'],
    filters: [
      { name: 'Supported manuscripts', extensions: ['txt', 'md', 'docx', 'pdf'] },
      { name: 'Text and Markdown', extensions: ['txt', 'md'] },
      { name: 'Word documents', extensions: ['docx'] },
      { name: 'PDF documents', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  } satisfies Electron.OpenDialogOptions;
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return importManuscriptFile(result.filePaths[0]);
}

ipcMain.handle('dialog:openManuscriptFile', openManuscriptFile);
ipcMain.handle('dialog:openTextFile', openManuscriptFile);

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

ipcMain.handle('openai-realtime:exchangeSdp', async (_event, offerSdp: unknown) => {
  if (!isOpenAiRealtimeEnabled()) {
    throw new Error(
      'OpenAI Realtime is experimental and disabled. Set OPENAI_REALTIME_ENABLED=true to enable it.'
    );
  }

  const config = getOpenAiRealtimeConfig();
  if (!config) {
    throw new Error('Live OpenAI Realtime is not configured. Set OPENAI_API_KEY outside the renderer.');
  }

  const receivedSdpDiagnostics = inspectOpenAiRealtimeSdpOffer(offerSdp);
  console.info('[main] OpenAI Realtime SDP received over IPC', receivedSdpDiagnostics);

  let validatedOffer: ReturnType<typeof validateOpenAiRealtimeSdpOffer>;
  try {
    validatedOffer = validateOpenAiRealtimeSdpOffer(offerSdp);
  } catch (error) {
    throw new Error(openAiFetchErrorDetails(error, config.prompt));
  }
  if (validatedOffer.sdp.length > 1_000_000) {
    throw new Error('OpenAI Realtime calls POST was not attempted because the SDP offer was unexpectedly large.');
  }

  let sessionBuild: ReturnType<typeof buildOpenAiRealtimeTranscriptionSession>;
  try {
    sessionBuild = buildOpenAiRealtimeTranscriptionSession(config);
  } catch (error) {
    throw new Error(
      `OpenAI Realtime session config build failed: ${openAiFetchErrorDetails(error, config.prompt)}`
    );
  }

  const { session, diagnostics } = sessionBuild;
  const endpointLabel = 'OpenAI /v1/realtime/calls';
  console.info('[main] OpenAI Realtime SDP exchange starting', {
    operation: 'OpenAI calls POST',
    endpointLabel,
    authentication: 'standard API key held in Electron main',
    ephemeralKeyUsed: false,
    offerSdpLength: validatedOffer.sdp.length,
    offerSdpStartsWithV0: validatedOffer.diagnostics.startsWithV0,
    offerSdpFirstLine: validatedOffer.diagnostics.firstLine,
    offerSdpEndsWithLineBreak: validatedOffer.diagnostics.endsWithLineBreak,
    formDataFieldNames: ['sdp', 'session'],
    ...diagnostics
  });

  const formData = new FormData();
  formData.set('sdp', validatedOffer.sdp);
  formData.set('session', JSON.stringify(session));

  let response: Response;
  try {
    response = await fetch(DEFAULT_WEBRTC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      },
      body: formData
    });
  } catch (error) {
    const details = openAiFetchErrorDetails(error, config.prompt);
    console.error('[main] OpenAI Realtime calls POST transport failure', {
      endpointLabel,
      error: details
    });
    throw new Error(`OpenAI Realtime calls POST failed before an HTTP response: ${details}`);
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw new Error(
      `OpenAI Realtime calls POST returned ${response.status} ${response.statusText || '(no status text)'}, but reading the SDP response failed: ${openAiFetchErrorDetails(error, config.prompt)}`
    );
  }
  if (!response.ok) {
    const safeBody = sanitizeOpenAiDiagnosticText(bodyText, config.prompt);
    console.error('[main] OpenAI Realtime calls POST rejected', {
      endpointLabel,
      status: response.status,
      statusText: response.statusText,
      body: safeBody
    });
    throw new Error(
      `OpenAI Realtime calls POST failed: ${response.status} ${response.statusText || '(no status text)'}. ${sanitizeOpenAiError(response.status, safeBody)}`
    );
  }

  if (!bodyText.trim()) {
    throw new Error(
      `OpenAI Realtime calls POST returned ${response.status} ${response.statusText || '(no status text)'} with an empty SDP answer.`
    );
  }

  console.info('[main] OpenAI Realtime SDP exchange completed', {
    endpointLabel,
    status: response.status,
    statusText: response.statusText,
    answerSdpLength: bodyText.length,
    model: config.transcriptionModel
  });

  return {
    answerSdp: bodyText,
    endpointLabel,
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

ipcMain.handle('tablet-server:syncSession', (_event, sync: RendererSessionSync) => {
  const result = serverSession.applyRendererSync(sync);
  if (result.accepted && !result.duplicate) prompterServer?.broadcastSnapshot();
  return result;
});
ipcMain.handle('tablet-server:getStatus', () => prompterServer?.getStatus() ?? null);
ipcMain.handle('tablet-server:getDiagnostics', () => prompterServer?.diagnostics() ?? null);

ipcMain.handle('local-whisper:getStatus', () => localWhisperStatusForRenderer());

ipcMain.handle('local-whisper:start', async (_event, settings: LocalWhisperSettings) => {
  await whisperService.start(settings);
  return localWhisperStatusForRenderer();
});

ipcMain.handle('local-whisper:stop', async () => {
  await whisperService.stop();
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
  }) => whisperService.transcribe(payload)
);
