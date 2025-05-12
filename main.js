const { app, Tray, Menu } = require('electron');
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const expressApp = express();
expressApp.use(cors());
const server = http.createServer(expressApp);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;
let tray = null;

function setupAutoLaunch() {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe')
  });
}

function getIPAddress() {
  const interfaces = os.networkInterfaces();
  let ipAddress = 'No disponible';
  
  Object.keys(interfaces).forEach((interfaceName) => {
    interfaces[interfaceName].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        ipAddress = iface.address;
      }
    });
  });
  
  return ipAddress;
}

function setupServer() {
  expressApp.get('/ip', (req, res) => {
    res.json({ ip: getIPAddress() });
  });

  io.on('connection', (socket) => {
    console.log('Cliente conectado');
        socket.emit('ip-address', { ip: getIPAddress() });
    
    socket.on('get-ip', () => {
      socket.emit('ip-address', { ip: getIPAddress() });
    });
    
    socket.on('disconnect', () => {
      console.log('Cliente desconectado');
    });
  });

  server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: `IP actual: ${getIPAddress()}`, 
      enabled: false 
    },
    {
      type: 'separator'
    },
    { 
      label: 'Salir', 
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('IP Server');
  tray.setContextMenu(contextMenu);
  
  setInterval(() => {
    const newContextMenu = Menu.buildFromTemplate([
      { 
        label: `IP actual: ${getIPAddress()}`, 
        enabled: false 
      },
      {
        type: 'separator'
      },
      { 
        label: 'Salir', 
        click: () => {
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(newContextMenu);
  }, 30000);
}

app.whenReady().then(() => {
  createTray();
  setupServer();
  setupAutoLaunch();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
