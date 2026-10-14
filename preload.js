const { contextBridge, ipcRenderer } = require('electron');

// Exponer funcionalidades protegidas a la ventana de renderizado
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  getInterfaceChoice: () => ipcRenderer.invoke('get-interface-choice'),
  chooseInterface: (name) => ipcRenderer.invoke('choose-interface', name),
  getCmcConfig: () => ipcRenderer.invoke('get-cmc-config'),
  saveCmcConfig: (config) => ipcRenderer.invoke('save-cmc-config', config),
  probeCmcTarget: (target) => ipcRenderer.invoke('probe-cmc-target', target),
  getCmcStatus: () => ipcRenderer.invoke('get-cmc-status'),
});

window.addEventListener('DOMContentLoaded', () => {
  const ipElement = document.getElementById('ip-address');
  
  if (ipElement) {
    ipcRenderer.on('ip-address', (event, ip) => {
      ipElement.innerText = ip;
    });
  }
});
