const { contextBridge, ipcRenderer } = require('electron');

// Exponer funcionalidades protegidas a la ventana de renderizado
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
});

window.addEventListener('DOMContentLoaded', () => {
  const ipElement = document.getElementById('ip-address');
  
  if (ipElement) {
    ipcRenderer.on('ip-address', (event, ip) => {
      ipElement.innerText = ip;
    });
  }
});
