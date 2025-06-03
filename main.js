const { app, Tray, Menu, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const { autoUpdater } = require("electron-updater");

const expressApp = express();
expressApp.use(cors());
const server = http.createServer(expressApp);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

const PORT = 3000;
let tray = null;
let splashWindow = null;

// Maneja la solicitud para obtener la versión actual
ipcMain.handle("get-version", () => {
    return app.getVersion();
});

// Crear la ventana de splash
function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 500,
        height: 400,
        transparent: false,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    splashWindow.loadFile("splash.html");

    // Evitar que la ventana de splash se cierre con Esc
    splashWindow.on("close", (e) => {
        if (app.quitting) {
            splashWindow = null;
        } else {
            e.preventDefault();
            splashWindow.hide();
        }
    });
}

// Configuración del auto actualizador
function setupAutoUpdater() {
    // Comprobar actualizaciones inmediatamente al iniciar
    autoUpdater.checkForUpdatesAndNotify();

    // Configurar comprobaciones periódicas cada 6 horas
    setInterval(() => {
        autoUpdater.checkForUpdatesAndNotify();
    }, 6 * 60 * 60 * 1000);

    // Eventos de actualización
    autoUpdater.on("checking-for-update", () => {
        console.log("Comprobando si hay actualizaciones...");
    });

    autoUpdater.on("update-available", (info) => {
        console.log("Actualización disponible:", info.version);
    });

    autoUpdater.on("update-not-available", (info) => {
        console.log("No hay actualizaciones disponibles");
    });

    autoUpdater.on("error", (err) => {
        console.error("Error al actualizar:", err);
    });

    autoUpdater.on("download-progress", (progressObj) => {
        let logMessage = `Velocidad de descarga: ${progressObj.bytesPerSecond}`;
        logMessage += ` - Descargado ${progressObj.percent}%`;
        logMessage += ` (${progressObj.transferred}/${progressObj.total})`;
        console.log(logMessage);
    });

    autoUpdater.on("update-downloaded", (info) => {
        console.log("Actualización descargada. Se instalará al reiniciar.");
        // La aplicación se reiniciará automáticamente después de la instalación
    });
}

function setupAutoLaunch() {
    app.setLoginItemSettings({
        openAtLogin: true,
        path: app.getPath("exe"),
    });
}

function getIPAddress() {
    const interfaces = os.networkInterfaces();
    let ipAddress = "No disponible";

    Object.keys(interfaces).forEach((interfaceName) => {
        interfaces[interfaceName].forEach((iface) => {
            if (iface.family === "IPv4" && !iface.internal) {
                ipAddress = iface.address;
            }
        });
    });

    return ipAddress;
}

function setupServer() {
    expressApp.get("/ip", (req, res) => {
        res.json({ ip: getIPAddress() });
    });

    io.on("connection", (socket) => {
        console.log("Cliente conectado");
        socket.emit("ip-address", { ip: getIPAddress() });

        socket.on("get-ip", () => {
            socket.emit("ip-address", { ip: getIPAddress() });
        });

        socket.on("disconnect", () => {
            console.log("Cliente desconectado");
        });
    });

    server.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

function hideSplashWindow() {
    // Una vez que el servidor está funcionando, cierra la ventana de splash después de un breve retraso
    if (splashWindow) {
        setTimeout(() => {
            splashWindow.close();
            splashWindow = null;
        }, 3000); // Cierra después de 3 segundos para dar tiempo a ver la animación
    }
}

function createTray() {
    const iconPath = path.join(__dirname, "icon.png");
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: `IP actual: ${getIPAddress()}`,
            enabled: false,
        },
        {
            type: "separator",
        },
        {
            label: "Buscar actualizaciones",
            click: () => {
                autoUpdater.checkForUpdatesAndNotify();
            },
        },
        {
            label: "Salir",
            click: () => {
                app.quitting = true;
                app.quit();
            },
        },
    ]);

    tray.setToolTip("IP Server");
    tray.setContextMenu(contextMenu);

    setInterval(() => {
        const newContextMenu = Menu.buildFromTemplate([
            {
                label: `IP actual: ${getIPAddress()}`,
                enabled: false,
            },
            {
                type: "separator",
            },
            {
                label: "Buscar actualizaciones",
                click: () => {
                    console.log("🔄 Comprobación manual de actualizaciones iniciada");
                    updateTrayStatus("Comprobando...");
                    autoUpdater.checkForUpdatesAndNotify();
                },
            },
            {
                label: "Salir",
                click: () => {
                    app.quitting = true;
                    app.quit();
                },
            },
        ]);
        tray.setContextMenu(newContextMenu);
    }, 30000);
}

app.whenReady().then(() => {
    console.log(`🚀 Iniciando VerentiaIP v${app.getVersion()}`);
    console.log(`📦 Aplicación empaquetada: ${app.isPackaged ? 'Sí' : 'No'}`);
    
    // Primero crea la ventana de splash
    createSplashWindow();

    // Luego inicia el resto de la aplicación
    createTray();
    setupServer();
    setupAutoLaunch();
    setupAutoUpdater(); // Iniciamos el sistema de auto actualización

    hideSplashWindow();
});

app.on("window-all-closed", (e) => {
    e.preventDefault();
});
