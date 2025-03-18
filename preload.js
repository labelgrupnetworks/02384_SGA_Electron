window.addEventListener('DOMContentLoaded', () => {
    const ipElement = document.getElementById('ip-address');
    
    ipcMain.on('ip-address', (event, ip) => {
      if (ipElement) {
        ipElement.innerText = ip;
      }
    });
  });
  