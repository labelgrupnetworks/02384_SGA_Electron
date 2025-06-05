const { app, Tray, Menu, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

// Migración a update-electron-app
const { updateElectronApp, UpdateSourceType } = require('update-electron-app');

// Sistema de logging inteligente
let logger;
if (app.isPackaged) {
    // En producción: usar electron-log
    logger = require('electron-log');
} else {
    // En desarrollo: usar console
    logger = {
        info: console.log,
        warn: console.warn,
        error: console.error,
        log: console.log
    };
}

// IMPORTANTE: Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    logger.warn('⚠️ Otra instancia ya está corriendo. Cerrando...');
    app.quit();
    process.exit(0);
} else {
    // Si alguien trata de ejecutar una segunda instancia, enfoca la primera
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        logger.info('🔄 Intento de segunda instancia detectado');
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
    error: null
};

// Configurar auto-actualización
function setupAutoUpdater() {
    console.log('🔄 Configurando auto-actualización...');
    
    if (!app.isPackaged) {
        console.log('⚠️ Auto-actualización solo funciona en builds empaquetados');
        console.log('💡 Para probar: npm run make → ejecutar el .exe generado');
        return;
    }
    
    try {
        // Configuración simple sin logger personalizado
        updateElectronApp({
            updateInterval: '2 hours',
            notifyUser: true,
            updateSource: {
                type: UpdateSourceType.ElectronPublicUpdateService,
                repo: 'labelgrupnetworks/02384_SGA_Electron'
            }
        });
        
        updateStatus.lastCheck = new Date();
        console.log('✅ Auto-actualización configurada correctamente');
        
    } catch (error) {
        console.error('❌ Error configurando auto-actualización:', error);
        updateStatus.error = error.message;
    }
}

// Función para verificar actualizaciones manualmente
function checkForUpdatesManually() {
    logger.info('🔍 Verificando actualizaciones manualmente...');
    logger.info(`📍 Versión actual: ${app.getVersion()}`);
    logger.info(`📍 Repositorio: labelgrupnetworks/02384_SGA_Electron`);
    
    // Mostrar notificación al usuario
    dialog.showMessageBox({
        type: 'info',
        title: 'Verificando actualizaciones',
        message: 'Buscando actualizaciones disponibles...\nEsto puede tardar unos segundos.\n\nRevisa la consola para logs detallados.',
        buttons: ['OK']
    });
    
    updateStatus.lastCheck = new Date();
    
    // Forzar verificación inmediata
    try {
        const https = require('https');
        const currentVersion = app.getVersion();
        
        logger.info('🌐 Consultando GitHub API...');
        
        const options = {
            hostname: 'api.github.com',
            path: '/repos/labelgrupnetworks/02384_SGA_Electron/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'VerentiaIP-UpdateChecker'
            }
        };
        
        const req = https.request(options, (res) => {
            logger.info(`📡 Status Code: ${res.statusCode}`);
            logger.info(`📡 Headers:`, res.headers);
            
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    logger.info('📋 Respuesta de GitHub API:', data.substring(0, 200) + '...');
                    
                    const release = JSON.parse(data);
                    const latestVersion = release.tag_name.replace('v', '');
                    
                    logger.info(`📋 Versión actual: ${currentVersion}`);
                    logger.info(`📋 Versión disponible: ${latestVersion}`);
                    logger.info(`📋 Release URL: ${release.html_url}`);
                    logger.info(`📋 Assets disponibles:`, release.assets.map(a => a.name));
                    
                    if (latestVersion !== currentVersion) {
                        updateStatus.updateAvailable = true;
                        
                        logger.info('🎉 Nueva versión encontrada!');
                        logger.info('🔄 update-electron-app debería iniciar descarga automáticamente...');
                        
                        // Verificar si los archivos necesarios están en la release
                        const hasSquirrelFiles = release.assets.some(asset => 
                            asset.name.includes('.nupkg') || asset.name === 'RELEASES'
                        );
                        
                        logger.info(`📦 Archivos Squirrel disponibles: ${hasSquirrelFiles}`);
                        
                        dialog.showMessageBox({
                            type: 'info',
                            title: '🎉 Actualización disponible',
                            message: `Nueva versión disponible: v${latestVersion}\n\nLa actualización se descargará automáticamente en segundo plano.\n\nRevisa la consola para ver el progreso de descarga.`,
                            buttons: ['OK', 'Ver detalles'],
                            defaultId: 0
                        }).then((result) => {
                            if (result.response === 1) {
                                // Mostrar detalles técnicos
                                dialog.showMessageBox({
                                    type: 'info',
                                    title: 'Detalles técnicos',
                                    message: `Versión actual: ${currentVersion}\nVersión disponible: ${latestVersion}\nArchivos Squirrel: ${hasSquirrelFiles ? 'Sí' : 'No'}\n\nRevisa la consola de DevTools para logs completos.`,
                                    buttons: ['OK', 'Abrir DevTools']
                                }).then((detailResult) => {
                                    if (detailResult.response === 1) {
                                        // Abrir DevTools para ver logs
                                        const focusedWindow = BrowserWindow.getFocusedWindow();
                                        if (focusedWindow) {
                                            focusedWindow.webContents.openDevTools();
                                        }
                                    }
                                });
                            }
                        });
                    } else {
                        logger.info('✅ Ya tienes la versión más reciente');
                        dialog.showMessageBox({
                            type: 'info',
                            title: '✅ Aplicación actualizada',
                            message: `Ya tienes la versión más reciente (v${currentVersion})`,
                            buttons: ['OK']
                        });
                    }
                } catch (error) {
                    logger.error('❌ Error parsing release data:', error);
                    logger.error('📋 Raw data:', data);
                    showUpdateError();
                }
            });
        });
        
        req.on('error', (error) => {
            logger.error('❌ Error checking for updates:', error);
            showUpdateError();
        });
        
        req.setTimeout(10000, () => {
            logger.error('⏰ Timeout consultando GitHub API');
            req.destroy();
            showUpdateError();
        });
        
        req.end();
        
    } catch (error) {
        logger.error('❌ Error en verificación manual:', error);
        showUpdateError();
    }
}

function showUpdateError() {
    dialog.showMessageBox({
        type: 'warning',
        title: '⚠️ Error de verificación',
        message: 'No se pudo verificar si hay actualizaciones disponibles.\n\nVerifica tu conexión a internet e inténtalo más tarde.',
        buttons: ['OK']
    });
}

// Mostrar información del estado del actualizador
function showUpdateStatus() {
    const statusMessage = `
Estado del Actualizador:
• Versión actual: ${updateStatus.currentVersion}
• Última verificación: ${updateStatus.lastCheck ? updateStatus.lastCheck.toLocaleString() : 'Nunca'}
• Actualización disponible: ${updateStatus.updateAvailable ? 'Sí' : 'No'}
• Intervalo: Cada 2 horas
• Estado: ${updateStatus.error ? 'Error' : 'Funcionando'}
${updateStatus.error ? `• Error: ${updateStatus.error}` : ''}
    `;
    
    dialog.showMessageBox({
        type: 'info',
        title: 'Estado del Actualizador',
        message: statusMessage,
        buttons: ['OK']
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
            if( splashWindow) {
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
    expressApp.get("/ip", (req, res) => {
        res.json({ ip: getIPAddress() });
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
    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            logger.warn(`⚠️ Puerto ${PORT} en uso. Intentando puerto alternativo...`);
            // Intentar con puerto alternativo
            const alternativePort = PORT + Math.floor(Math.random() * 100);
            server.listen(alternativePort, () => {
                logger.info(`✅ Servidor corriendo en puerto alternativo: ${alternativePort}`);
            });
        } else {
            logger.error('❌ Error del servidor:', error);
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
                label: `Última verificación: ${updateStatus.lastCheck ? 
                    updateStatus.lastCheck.toLocaleTimeString() : 'Nunca'}`,
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
                            contextIsolation: false
                        }
                    });
                    debugWindow.loadURL('data:text/html,<h1>Logs en la consola</h1><p>Abre DevTools para ver los logs (F12)</p>');
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
    logger.info(`📦 Aplicación empaquetada: ${app.isPackaged ? 'Sí' : 'No'}`);
    
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
app.on('before-quit', () => {
    logger.info('🔄 Cerrando aplicación...');
    
    // Cerrar servidor limpiamente
    if (serverInstance) {
        logger.info('🔄 Cerrando servidor...');
        serverInstance.close(() => {
            logger.info('✅ Servidor cerrado correctamente');
        });
    }
});

// Manejo automático de eventos Squirrel (instalación/actualización Windows)
if (require('electron-squirrel-startup')) {
    app.quit();
}