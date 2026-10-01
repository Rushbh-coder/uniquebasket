const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('setup', { save: c => ipcRenderer.invoke('save', c), defaults: () => ipcRenderer.invoke('defaults') });
