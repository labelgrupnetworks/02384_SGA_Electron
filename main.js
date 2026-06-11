const { app, Tray, Menu, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

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
    // Middleware para parsear JSON - DEBE ir ANTES de las rutas
    expressApp.use(express.json());

    // Middleware de logging para todas las peticiones
    expressApp.use((req, res, next) => {
        logger.info(`${req.method} ${req.url} - Body:`, req.body);
        next();
    });

    expressApp.get("/ip", (req, res) => {
        res.json({ ip: getIPAddress() });
    });

    // Nuevo endpoint POST para enviar comandos a la báscula
    expressApp.post("/scale-command", async (req, res) => {
        logger.info(`🔄 Petición POST recibida en /scale-command`);
        logger.info(`📋 Body recibido:`, req.body);
        const { ip, port, command } = req.body;
        
        // Validar parámetros
        if (!ip || !port || !command) {
            return res.status(400).json({
                success: false,
                error: "Faltan parámetros requeridos: ip, port, command"
            });
        }

        logger.info(`⚖️ [POST] Enviando comando a ${ip}:${port} → ${command}`);

        try {
            const net = require("net");
            const client = new net.Socket();
            let response = "";

            // Crear una promesa para manejar la respuesta
            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000); // Timeout aumentado a 10 segundos

                client.connect(port, ip, () => {
                    logger.info(`✅ [POST] Conectado a ${ip}:${port}`);
                    
                    // Las IS30 suelen usar terminación \r o \r\n
                    let fullCommand = command.endsWith("\r\n")
                        ? command
                        : command + "\r\n";
                    
                    // Convertir | a ETX (carácter ASCII 3) si está presente
                    fullCommand = fullCommand.replace(/<ETX>/g, '\x03');
                    
                    logger.info(`➡️ [POST] Enviando: ${JSON.stringify(fullCommand)}`);
                    client.write(fullCommand, "ascii");
                });

                client.on("data", (data) => {
                    response += data.toString("ascii");
                    logger.info(`📥 [POST] Datos recibidos: ${JSON.stringify(response)}`);
                    
                    // Dar un pequeño delay antes de cerrar para asegurar que no hay más datos
                    setTimeout(() => {
                        client.end();
                    }, 100);
                });

                client.on("end", () => {
                    logger.info(`✅ [POST] Conexión terminada. Respuesta final: ${response}`);
                    
                    // Limpiar caracteres de control de la respuesta
                    const cleanResponse = response
                        .replace(/\x02/g, '<STX>') // Remover STX (Start of Text)
                        .replace(/\x03/g, '<ETX>') // Remover ETX (End of Text)
                        .trim();
                    
                    logger.info(`🧹 [POST] Respuesta limpia: ${cleanResponse}`);
                    
                    resolve({ 
                        success: true, 
                        response: cleanResponse,
                        raw_response: response.trim() // Mantener la respuesta original para debugging
                    });
                });

                client.on("error", (err) => {
                    logger.error(`❌ [POST] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on("timeout", () => {
                    logger.warn("⏰ [POST] Timeout al comunicar");
                    client.destroy();
                    reject({ success: false, error: "Timeout de conexión" });
                });
            });

            // Enviar respuesta exitosa
            res.json(result);

        } catch (err) {
            logger.error(`❌ [POST] Excepción: ${err.message}`);
            res.status(500).json({
                success: false,
                error: err.error || err.message
            });
        }
    });

    // Endpoint POST para enviar una trama HEX cruda por TCP (bytes exactos)
    expressApp.post("/scale-hex", async (req, res) => {
        logger.info(`🔄 Petición POST recibida en /scale-hex`);
        const { ip, port, hex } = req.body;

        if (!ip || !port || !hex) {
            return res.status(400).json({
                success: false,
                error: "Faltan parámetros requeridos: ip, port, hex"
            });
        }

        // "30 03 32..." o "300332..." -> Buffer de bytes exactos
        const clean = hex.replace(/[^0-9a-fA-F]/g, "");
        if (clean.length % 2 !== 0) {
            return res.status(400).json({ success: false, error: "HEX con longitud impar" });
        }
        const payload = Buffer.from(clean, "hex");

        logger.info(`⚖️ [HEX] Enviando a ${ip}:${port} → ${payload.toString("hex").match(/../g).join(" ")}`);

        try {
            const net = require("net");
            const client = new net.Socket();
            let response = Buffer.alloc(0);

            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000);

                client.connect(port, ip, () => {
                    logger.info(`✅ [HEX] Conectado a ${ip}:${port}`);
                    client.write(payload); // bytes crudos, SIN encoding ni transformaciones
                });

                client.on("data", (data) => {
                    response = Buffer.concat([response, data]);
                    // Pequeño delay por si llegan más datos antes de cerrar
                    setTimeout(() => client.end(), 100);
                });

                client.on("end", () => {
                    const hexIn = response.toString("hex").match(/../g)?.join(" ") || "";
                    logger.info(`✅ [HEX] Respuesta (${response.length} bytes): ${hexIn}`);
                    resolve({
                        success: true,
                        response_hex: hexIn,
                        response_ascii: response.toString("latin1")
                    });
                });

                client.on("error", (err) => {
                    logger.error(`❌ [HEX] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on("timeout", () => {
                    logger.warn("⏰ [HEX] Timeout al comunicar");
                    client.destroy();
                    reject({ success: false, error: "Timeout de conexión" });
                });
            });

            res.json(result);
        } catch (err) {
            logger.error(`❌ [HEX] Excepción: ${err.message}`);
            res.status(500).json({ success: false, error: err.error || err.message });
        }
    });

    io.on("connection", (socket) => {
        logger.info("Cliente conectado");
        socket.emit("ip-address", { ip: getIPAddress() });

        socket.on("get-ip", () => {
            socket.emit("ip-address", { ip: getIPAddress() });
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
                label: `IP actual: ${getIPAddress()}`,
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
