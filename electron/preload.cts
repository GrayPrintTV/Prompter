import { contextBridge, ipcRenderer } from 'electron';

type PreloadExposeDiagnostics = {
  started: boolean;
  exposed: boolean;
  errorMessage: string | null;
  errorStack: string | null;
};

const preloadDiagnostics: PreloadExposeDiagnostics = {
  started: true,
  exposed: false,
  errorMessage: null,
  errorStack: null
};

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack ?? null
    };
  }
  return {
    message: String(error),
    stack: null
  };
}

function sendPreloadDiagnostics() {
  try {
    ipcRenderer.send('preload:diagnostic', { ...preloadDiagnostics });
  } catch {
    // The terminal console log still records preload progress when IPC is unavailable.
  }
}

function safeSdpDiagnostics(value: unknown) {
  const sdp = typeof value === 'string' ? value : '';
  const firstLine = sdp.split(/\r?\n/, 1)[0] ?? '';
  return {
    receivedType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    characterLength: sdp.length,
    startsWithV0: sdp.startsWith('v=0'),
    firstLine: firstLine === 'v=0' ? 'v=0' : firstLine ? '[unexpected]' : '[empty]',
    endsWithLineBreak: /(?:\r\n|\n)$/.test(sdp)
  };
}

console.log('[preload] preload starting');
sendPreloadDiagnostics();

try {
  contextBridge.exposeInMainWorld('prompterPreloadDiagnostics', {
    getDiagnostics: () => ({ ...preloadDiagnostics })
  });
} catch (error) {
  const details = errorDetails(error);
  console.error('[preload] prompterPreloadDiagnostics expose failed', details.message, details.stack);
}

try {
  contextBridge.exposeInMainWorld('prompterApi', {
    ping: () => 'pong',
    openTextFile: () => ipcRenderer.invoke('dialog:openTextFile'),
    toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggleAlwaysOnTop'),
    getOpenAiRealtimeConfigStatus: () => ipcRenderer.invoke('openai-realtime:getConfigStatus'),
    exchangeOpenAiRealtimeSdp: (offerSdp: string) => {
      console.info('[preload] OpenAI Realtime SDP forwarding over IPC', safeSdpDiagnostics(offerSdp));
      return ipcRenderer.invoke('openai-realtime:exchangeSdp', offerSdp);
    },
    getBridgeDiagnostics: () => ipcRenderer.invoke('bridge:getDiagnostics'),
    getLocalWhisperStatus: () => ipcRenderer.invoke('local-whisper:getStatus'),
    startLocalWhisper: (settings: unknown) => ipcRenderer.invoke('local-whisper:start', settings),
    stopLocalWhisper: () => ipcRenderer.invoke('local-whisper:stop'),
    transcribeLocalWhisperChunk: (payload: unknown) => ipcRenderer.invoke('local-whisper:transcribeChunk', payload),
    onLocalWhisperStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('local-whisper:status', listener);
      return () => ipcRenderer.removeListener('local-whisper:status', listener);
    }
  });
  preloadDiagnostics.exposed = true;
  preloadDiagnostics.errorMessage = null;
  preloadDiagnostics.errorStack = null;
  console.log('[preload] prompterApi exposed');
  sendPreloadDiagnostics();
} catch (error) {
  const details = errorDetails(error);
  preloadDiagnostics.errorMessage = details.message;
  preloadDiagnostics.errorStack = details.stack;
  console.error('[preload] prompterApi expose failed', details.message, details.stack);
  sendPreloadDiagnostics();
}
