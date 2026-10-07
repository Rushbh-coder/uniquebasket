// Only these functions are visible to the screens. No Node, no file system, no secrets.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pos', {
  print: (o) => ipcRenderer.invoke('pos:print', { html: String(o.html || ''), deviceName: String(o.deviceName || ''), copies: +o.copies || 1, silent: o.silent !== false, paper: String(o.paper || '80mm'), save: String(o.save || 'OFF'), fileName: String(o.fileName || '').slice(0, 120), heightMm: +o.heightMm || 0 }),
  openBills: () => ipcRenderer.invoke('pos:openBills'),
  printers: () => ipcRenderer.invoke('pos:printers'),
});
contextBridge.exposeInMainWorld('setup', { save: (c) => ipcRenderer.invoke('setup:save', c), defaults: () => ipcRenderer.invoke('setup:defaults') });
