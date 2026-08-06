const { app, Tray, Menu, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { registerLegacyRoutes } = require("./src/server/legacy-routes");
const { registerScaleRoutes } = require("./src/server/scale-routes");
const { createStore } = require("./src/config/store");
const { resolveLocalIp } = require("./src/network/resolve");
const { registerIpRoute } = require("./src/server/ip-route");

// Migración a update-electron-app
const { updateElectronApp, UpdateSourceType } = require("update-electron-app");

// Sistema de logging inteligente
let logger;
if (app.isPackaged) {
    // En producción: usar electron-log
    logger = require("electron-log");
} else {
    // En desarrollo: usar console
    logger = {
        info: console.log,
        warn: console.warn,
        error: console.error,
        log: console.log,
    };
}

// IMPORTANTE: Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    logger.warn("⚠️ Otra instancia ya está corriendo. Cerrando...");
    app.quit();
    process.exit(0);
} else {
    // Si alguien trata de ejecutar una segunda instancia, enfoca la primera
    app.on("second-instance", (event, commandLine, workingDirectory) => {
        logger.info("🔄 Intento de segunda instancia detectado");
        // Aquí podrías mostrar una notificación si quisieras
    });
}

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
let serverInstance = null;
let updateStatus = {
    lastCheck: null,
    updateAvailable: false,
    currentVersion: app.getVersion(),
    error: null,
};

// Configurar auto-actualización
function setupAutoUpdater() {
    console.log("🔄 Configurando auto-actualización...");

    if (!app.isPackaged) {
        console.log(
            "⚠️ Auto-actualización solo funciona en builds empaquetados"
        );
        console.log("💡 Para probar: npm run make → ejecutar el .exe generado");
        return;
    }

    try {
        // Configuración simple sin logger personalizado
        updateElectronApp({
            updateInterval: "2 hours",
            notifyUser: true,
            updateSource: {
                type: UpdateSourceType.ElectronPublicUpdateService,
                repo: "labelgrupnetworks/02384_SGA_Electron",
            },
        });

        updateStatus.lastCheck = new Date();
        console.log("✅ Auto-actualización configurada correctamente");
    } catch (error) {
        console.error("❌ Error configurando auto-actualización:", error);
        updateStatus.error = error.message;
    }
}

function showUpdateError() {
    dialog.showMessageBox({
        type: "warning",
        title: "⚠️ Error de verificación",
        message:
            "No se pudo verificar si hay actualizaciones disponibles.\n\nVerifica tu conexión a internet e inténtalo más tarde.",
        buttons: ["OK"],
    });
}

// Mostrar información del estado del actualizador
function showUpdateStatus() {
    const statusMessage = `
Estado del Actualizador:
• Versión actual: ${updateStatus.currentVersion}
• Última verificación: ${
        updateStatus.lastCheck
            ? updateStatus.lastCheck.toLocaleString()
            : "Nunca"
    }
• Actualización disponible: ${updateStatus.updateAvailable ? "Sí" : "No"}
• Intervalo: Cada 2 horas
• Estado: ${updateStatus.error ? "Error" : "Funcionando"}
${updateStatus.error ? `• Error: ${updateStatus.error}` : ""}
    `;

    dialog.showMessageBox({
        type: "info",
        title: "Estado del Actualizador",
        message: statusMessage,
        buttons: ["OK"],
    });
}

// Manejadores IPC simplificados
ipcMain.handle("get-version", () => {
    return app.getVersion();
});

ipcMain.handle("get-updater-status", () => {
    return updateStatus;
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
            //e.preventDefault();
            if (splashWindow) {
                splashWindow.hide();
            }
        }
    });
}

function setupAutoLaunch() {
    app.setLoginItemSettings({
        openAtLogin: true,
        path: app.getPath("exe"),
    });
}

let configStore = null;

function getConfigStore() {
    if (!configStore) {
        configStore = createStore(app.getPath("userData"), logger);
    }
    return configStore;
}

// The single place the rest of main.js asks "what is our address".
function localIp() {
    return resolveLocalIp({
        interfaces: os.networkInterfaces(),
        store: getConfigStore(),
    });
}

// Human-readable state for the tray label. Spanish, like the rest of the UI.
function describeLocalIp() {
    const current = localIp();

    switch (current.status) {
        case "configured":
        case "single":
            return `${current.ip} (${current.interface})`;
        case "stale":
            return `sin configurar (${current.savedInterface} ya no existe)`;
        case "no_network":
            return "sin red";
        default:
            return "sin configurar";
    }
}

function setupServer() {
    // Middleware para parsear JSON - DEBE ir ANTES de las rutas
    expressApp.use(express.json());

    // Middleware de logging para todas las peticiones
    expressApp.use((req, res, next) => {
        logger.info(`${req.method} ${req.url} - Body:`, req.body);
        next();
    });

    registerIpRoute(expressApp, { resolve: localIp, logger });

    registerLegacyRoutes(expressApp, logger);
    registerScaleRoutes(expressApp, logger, { version: app.getVersion() });

    io.on("connection", (socket) => {
        logger.info("Cliente conectado");
        const current = localIp();
        socket.emit("ip-address", { ip: current.ip, status: current.status });

        socket.on("get-ip", () => {
            const current = localIp();
            socket.emit("ip-address", { ip: current.ip, status: current.status });
        });

        socket.on("disconnect", () => {
            logger.info("Cliente desconectado");
        });
    });

    // Manejo de errores del servidor
    server.on("error", (error) => {
        if (error.code === "EADDRINUSE") {
            logger.warn(
                `⚠️ Puerto ${PORT} en uso. Intentando puerto alternativo...`
            );
            // Intentar con puerto alternativo
            const alternativePort = PORT + Math.floor(Math.random() * 100);
            server.listen(alternativePort, () => {
                logger.info(
                    `✅ Servidor corriendo en puerto alternativo: ${alternativePort}`
                );
            });
        } else {
            logger.error("❌ Error del servidor:", error);
        }
    });

    server.listen(PORT, () => {
        logger.info(`✅ Servidor corriendo en http://localhost:${PORT}`);
        serverInstance = server;
    });
}

function hideSplashWindow() {
    if (splashWindow) {
        setTimeout(() => {
            splashWindow.close();
            splashWindow = null;
        }, 3000);
    }
}

function createTray() {
    const iconPath = path.join(__dirname, "icon.png");
    tray = new Tray(iconPath);

    const buildContextMenu = () => {
        return Menu.buildFromTemplate([
            {
                label: `IP actual: ${describeLocalIp()}`,
                enabled: false,
            },
            {
                label: `Versión: ${app.getVersion()}`,
                enabled: false,
            },
            {
                label: `Última verificación: ${
                    updateStatus.lastCheck
                        ? updateStatus.lastCheck.toLocaleTimeString()
                        : "Nunca"
                }`,
                enabled: false,
            },
            {
                type: "separator",
            },
            {
                label: "📊 Estado del actualizador",
                click: () => {
                    showUpdateStatus();
                },
            },
            {
                label: "🛠️ Abrir DevTools",
                click: () => {
                    // Crear ventana temporal para ver logs
                    const debugWindow = new BrowserWindow({
                        width: 800,
                        height: 600,
                        webPreferences: {
                            nodeIntegration: true,
                            contextIsolation: false,
                        },
                    });
                    debugWindow.loadURL(
                        "data:text/html,<h1>Logs en la consola</h1><p>Abre DevTools para ver los logs (F12)</p>"
                    );
                    debugWindow.webContents.openDevTools();
                },
            },
            {
                type: "separator",
            },
            {
                label: "Salir",
                click: () => {
                    app.quitting = true;
                    app.quit();
                },
            },
        ]);
    };

    tray.setToolTip("IP Server - VerentiaIP");
    tray.setContextMenu(buildContextMenu());

    // Actualizar el menú cada 30 segundos para refrescar la IP y estado
    setInterval(() => {
        tray.setContextMenu(buildContextMenu());
    }, 30000);
}

app.whenReady().then(() => {
    logger.info(`🚀 Iniciando VerentiaIP v${app.getVersion()}`);
    logger.info(`📦 Aplicación empaquetada: ${app.isPackaged ? "Sí" : "No"}`);

    // Primero crea la ventana de splash
    createSplashWindow();

    // Luego inicia el resto de la aplicación
    createTray();
    setupServer();
    setupAutoLaunch();

    // Configurar el auto-actualizador (forzar también en desarrollo para testing)
    setupAutoUpdater();

    hideSplashWindow();
});

app.on("window-all-closed", (e) => {
    e.preventDefault();
});

// Manejo de eventos de actualización
app.on("before-quit", () => {
    logger.info("🔄 Cerrando aplicación...");

    // Cerrar servidor limpiamente
    if (serverInstance) {
        logger.info("🔄 Cerrando servidor...");
        serverInstance.close(() => {
            logger.info("✅ Servidor cerrado correctamente");
        });
    }
});

// Manejo automático de eventos Squirrel (instalación/actualización Windows)
if (require("electron-squirrel-startup")) {
    app.quit();
}
