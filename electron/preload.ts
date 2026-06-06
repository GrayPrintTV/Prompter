import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('prompterApi', {
  openTextFile: () => ipcRenderer.invoke('dialog:openTextFile'),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggleAlwaysOnTop'),
  getOpenAiRealtimeConfigStatus: () => ipcRenderer.invoke('openai-realtime:getConfigStatus'),
  createOpenAiRealtimeClientSession: () => ipcRenderer.invoke('openai-realtime:createClientSession'),
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
