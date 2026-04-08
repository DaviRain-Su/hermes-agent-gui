const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showNotification: (title, body) => ipcRenderer.send('show-notification', title, body),
  getWindowFocusState: () => ipcRenderer.invoke('get-window-focus-state'),
});
