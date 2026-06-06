import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('prompterApi', {
    openTextFile: () => ipcRenderer.invoke('dialog:openTextFile'),
    toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggleAlwaysOnTop')
});
