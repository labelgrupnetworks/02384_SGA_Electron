const { app, Tray, Menu, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { registerLegacyRoutes } = require("./src/server/legacy-routes");
const { registerScaleRoutes } = require("./src/server/scale-routes");
const { registerCmcRoutes } = require("./src/server/cmc-routes");
const { createManifestCache } = require("./src/cmc/manifest-cache");
const { createMachineClient } = require("./src/cmc/machine-client");
const { createReportQueue } = require("./src/cmc/report-queue");
const { createStore } = require("./src/config/store");
const { resolveLocalIp } = require("./src/network/resolve");
const { listCandidateInterfaces } = require("./src/network/interfaces");
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
// CMC driver state. Declared here (module scope), not inside setupServer,
// because the before-quit handler below also needs to reach cmcMachine and
// cmcReportQueue to stop them at shutdown.
let cmcCache = null;
let cmcMachine = null;
let cmcReportQueue = null;
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

let interfaceWindow = null;

ipcMain.handle("get-interface-choice", () => {
    const current = localIp();

    // "What is our address" (localIp/resolveLocalIp) and "what could we choose from"
    // are different questions. resolveLocalIp only carries a `candidates` list when it
    // could not decide (not_configured/stale) — on a machine that is already configured
    // or has a single candidate, that field is absent. The dialog needs the full list
    // every time it is opened, including from the tray on an already-configured
    // machine, so it asks the second question directly instead of widening the first.
    return {
        candidates: listCandidateInterfaces(os.networkInterfaces()),
        reason: current.status,
        savedInterface: current.savedInterface || null,
        currentInterface: current.interface || null,
    };
});

ipcMain.handle("choose-interface", (event, name) => {
    // Validated against the full candidate list, not localIp()'s `candidates` —
    // resolveLocalIp only populates that field when it could not decide
    // (not_configured/stale). On an already-configured machine it is undefined,
    // which would make this guard reject every name as "not offered", even a
    // real one, the moment the dialog (fixed to use the same full list) lets an
    // operator choose a different interface than the one already saved.
    const candidates = listCandidateInterfaces(os.networkInterfaces());

    // Only ever store a name the machine actually offers. A renderer sending
    // anything else would otherwise write a settings file that resolves to stale.
    //
    // The reason matters to the renderer: this candidate list can be stale by the
    // time the click lands (the dialog rendered it earlier, the operator could have
    // walked away), and no amount of retrying the same click will make an interface
    // that no longer exists become offered again. That is a different situation from
    // a write failure below, where the candidate itself is still perfectly valid.
    if (!candidates.some((c) => c.name === name)) {
        logger.warn(`⚠️ Interfaz no ofrecida, se ignora: ${name}`);
        return { saved: false, reason: "not_offered" };
    }

    // write() can throw (EACCES, ENOSPC, EROFS, ...) unlike read(), which never does.
    // Electron turns a throwing handle callback into a rejected invoke on the
    // renderer side, so the main process is safe either way, but the dialog's click
    // handler needs a definite { saved: false } to tell the operator nothing was
    // stored, rather than an unhandled rejection that leaves the window looking stuck.
    try {
        // set() merges into the existing settings file rather than overwriting
        // it outright, so a sibling `cmc` config block already on disk survives
        // this write instead of being silently wiped out.
        getConfigStore().set('interface', name);
    } catch (error) {
        logger.error(`❌ No se pudo guardar la interfaz elegida (${name}): ${error.message}`);
        return { saved: false, reason: "write_failed" };
    }

    logger.info(`✅ Interfaz de red elegida: ${name}`);

    // A second, near-simultaneous invoke (an impatient double-click before the
    // first one resolves) can reach here after the window is already mid-destruction
    // from the first call's close(). Closing an already-destroyed BrowserWindow throws.
    if (interfaceWindow && !interfaceWindow.isDestroyed()) {
        interfaceWindow.close();
    }
    if (tray) {
        tray.setContextMenu(buildTrayMenu());
    }

    return { saved: true };
});

function openInterfaceWindow() {
    if (interfaceWindow) {
        interfaceWindow.focus();
        return;
    }

    interfaceWindow = new BrowserWindow({
        width: 460,
        height: 380,
        resizable: false,
        center: true,
        title: "Interfaz de red",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    interfaceWindow.loadFile("select-interface.html");
    interfaceWindow.on("closed", () => {
        interfaceWindow = null;
    });
}

function setupServer() {
    // CMC routes MUST be registered before the global express.json() below.
    // /cmc/preload mounts its own express.json({ limit: '50mb' }) so a whole
    // base64 ZPL manifest is not rejected by express's 100 KB default. The
    // preload handler ends the response itself (res.json(...)), so if this
    // registration happened after the global parser, that global parser
    // would run first, reject the payload at 100 KB, and this route would
    // never even be reached. There is a second reason this order matters:
    // the request logger registered further below logs req.body for every
    // request, and only avoids writing tens of megabytes of base64 ZPL into
    // electron-log on every preload because this route already ended the
    // response before that logger's middleware runs. Verified empirically:
    // registered first, a 1.2 MB payload is accepted; registered after the
    // global parser, the same payload is rejected with 413.
    const cmcConfig = getConfigStore().read().cmc ?? {};

    cmcCache = createManifestCache();
    cmcReportQueue = createReportQueue({
        baseDir: app.getPath("userData"),
        endpoint: cmcConfig.verentia?.endpoint ?? "",
        stationToken: cmcConfig.verentia?.station_token ?? "",
        logger,
    });

    if (cmcConfig.enabled) {
        cmcMachine = createMachineClient({
            host: cmcConfig.machine?.host,
            port: cmcConfig.machine?.port,
            cache: cmcCache,
            labelers: cmcConfig.labelers ?? [],
            logger,
            onResult: (result) => cmcReportQueue.push(result),
        });

        cmcReportQueue.start();
        // A machine that is not answering yet must not stop the app from booting:
        // the client reconnects on its own and the operator sees it in /cmc/status.
        cmcMachine.start().catch((error) => {
            logger.warn(`⚠️ [cmc] startup without machine: ${error.message}`);
        });
    }

    registerCmcRoutes(expressApp, logger, {
        cache: cmcCache,
        machineState: () => (cmcMachine ? cmcMachine.state() : { connected: false, last_error: "cmc disabled" }),
    });

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

        const emitCmcStatus = () => {
            socket.emit("cmc-status", {
                manifest: cmcCache.state(),
                machine: cmcMachine ? cmcMachine.state() : { connected: false, last_error: "cmc disabled" },
                queued_reports: cmcReportQueue.size(),
            });
        };

        emitCmcStatus();
        socket.on("get-cmc-status", emitCmcStatus);

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

// Moved to module scope (was a closure inside createTray()) so that
// choose-interface can rebuild the menu after a successful save without
// having to duplicate the template here.
function buildTrayMenu() {
    return Menu.buildFromTemplate([
        {
            label: `IP actual: ${describeLocalIp()}`,
            enabled: false,
        },
        {
            label: "🌐 Cambiar interfaz de red",
            click: () => {
                openInterfaceWindow();
            },
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
}

function createTray() {
    const iconPath = path.join(__dirname, "icon.png");
    tray = new Tray(iconPath);

    tray.setToolTip("IP Server - VerentiaIP");
    tray.setContextMenu(buildTrayMenu());

    // Actualizar el menú cada 30 segundos para refrescar la IP y estado
    setInterval(() => {
        tray.setContextMenu(buildTrayMenu());
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

    // Only when there is genuinely something to choose. `single` needs no question,
    // and `no_network` has nothing to offer — that one is fixed with a cable, not a
    // dialog, so opening an empty window would only confuse.
    const startup = localIp();
    if (startup.status === "not_configured" || startup.status === "stale") {
        openInterfaceWindow();
    } else {
        logger.info(`🌐 IP local: ${describeLocalIp()}`);
    }

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

    // Stop the CMC driver: without this a live machine socket or the report
    // queue's flush timer keeps the process alive past quit.
    if (cmcMachine) cmcMachine.stop();
    if (cmcReportQueue) cmcReportQueue.stop();

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
