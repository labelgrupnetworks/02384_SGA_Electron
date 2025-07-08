# 🖥️ VerentiaIP - Servidor de IP Local con Auto-actualización

**VerentiaIP** es una aplicación de escritorio construida con Electron que proporciona un servidor local para obtener la dirección IP de la máquina así como las funcionalidades de conectividad con balanzas. La aplicación incluye un sistema de tray, splash screen y auto-actualización automática desde GitHub Releases.

## 📋 Características Principales

- 🌐 **Servidor HTTP/WebSocket**: Expone la IP local en `http://localhost:3000`
- 🔄 **Auto-actualización**: Sistema automático de actualizaciones desde GitHub
- 🖥️ **Tray System**: Aplicación que vive en la bandeja del sistema
- 🚀 **Auto-inicio**: Se ejecuta automáticamente al iniciar Windows
- 📡 **API REST**: Endpoint `/ip` para obtener la IP programáticamente
- 🔒 **Single Instance**: Previene múltiples instancias ejecutándose

## 🏗️ Estructura del Proyecto

```
02384_SGA_Electron/
├── main.js              # Proceso principal de Electron
├── preload.js           # Script de preload para seguridad
├── index.html           # Interfaz principal (no se usa actualmente)
├── splash.html          # Pantalla de splash al iniciar
├── package.json         # Configuración del proyecto y dependencias
├── forge.config.js      # Configuración de Electron Forge
├── icon.ico/.png        # Iconos de la aplicación
├── logo-fedefarma.png   # Logo para splash screen
├── .env                 # Variables de entorno (crear manualmente)
└── README.md           # Documentación
```

## 🛠️ Tecnologías Utilizadas

### Dependencies de Producción
- **electron**: Framework principal para aplicaciones de escritorio
- **express**: Servidor HTTP
- **socket.io**: WebSockets para comunicación en tiempo real
- **cors**: Manejo de CORS para el servidor web
- **electron-log**: Sistema de logging para producción
- **update-electron-app**: Sistema de auto-actualización
- **electron-squirrel-startup**: Manejo de instalación en Windows

### Dependencies de Desarrollo
- **@electron-forge**: Suite completa para empaquetar y distribuir
- **@electron/fuses**: Configuraciones de seguridad
- **dotenv**: Manejo de variables de entorno

## ⚙️ Configuración Inicial

### 1. Clonar el Repositorio
```bash
git clone https://github.com/labelgrupnetworks/02384_SGA_Electron.git
cd 02384_SGA_Electron
```

### 2. Instalar Dependencias
```bash
npm install
```

### 3. Crear Archivo de Variables de Entorno

**⚠️ IMPORTANTE**: Debes crear un archivo `.env` en la raíz del proyecto:

```bash
# .env
GITHUB_TOKEN=tu_github_token_aqui
```

Para obtener el token de GitHub:
1. Ve a GitHub Settings → Developer settings → Personal access tokens
2. Genera un nuevo token con permisos de `repo`
3. Copia el token al archivo `.env`

### 4. Configurar Versiones

**📝 ANTES DE COMPILAR**: Siempre actualiza la versión en [`package.json`](package.json):

```json
{
  "version": "1.0.24"  // Incrementar antes de cada build
}
```

## 🚀 Comandos de Desarrollo

### Ejecutar en Modo Desarrollo
```bash
npm start
```

### Empaquetar la Aplicación
```bash
npm run package
```

### Compilar Instaladores
```bash
npm run make
```

### Publicar Release en GitHub
```bash
npm run publish
```

## 📦 Proceso de Compilación y Distribución

### 1. Preparación
- Actualizar versión en [`package.json`](package.json)
- Verificar que el archivo `.env` existe con `GITHUB_TOKEN`
- Hacer commit de todos los cambios

### 2. Compilación
```bash
npm run make
```

Esto genera:
- `out/VerentiaIP-win32-x64/` - Aplicación empaquetada
- `out/make/squirrel.windows/x64/VerentiaIP-Setup.exe` - Instalador
- `out/make/squirrel.windows/x64/RELEASES` - Archivo de releases
- `out/make/squirrel.windows/x64/*.nupkg` - Paquete de actualización

### 3. Publicación Automática
```bash
npm run publish
```

Esto:
- Crea un nuevo release en GitHub
- Sube automáticamente todos los archivos necesarios
- Configura el sistema de auto-actualización

## 🔄 Sistema de Auto-actualización

La aplicación utiliza `update-electron-app` con el servicio público de Electron:

```javascript
updateElectronApp({
    updateInterval: '2 hours',
    notifyUser: true,
    updateSource: {
        type: UpdateSourceType.ElectronPublicUpdateService,
        repo: 'labelgrupnetworks/02384_SGA_Electron'
    }
});
```

### Verificación Manual
- Click derecho en el tray → "📊 Estado del actualizador"
- Logs detallados en DevTools (disponible desde el tray)

## 🌐 API Endpoints

### REST API
```bash
GET http://localhost:3000/ip
```
Respuesta:
```json
{
  "ip": "192.168.1.100"
}
```

```bash
POST http://localhost:3000/scale-command
```

### WebSocket
```javascript
// Conectar al socket
const socket = io('http://localhost:3000');

// Obtener IP
socket.emit('get-ip');
socket.on('ip-address', (data) => {
    console.log('IP:', data.ip);
});
```

## 🔧 Configuración Avanzada

### Cambiar Puerto del Servidor
Edita [`main.js`](main.js):
```javascript
const PORT = 3001; // Cambiar de 3000 a otro puerto
```

### Modificar Intervalo de Actualización
```javascript
updateElectronApp({
    updateInterval: '4 hours', // Cambiar intervalo
    // ...
});
```

### Personalizar Auto-inicio
```javascript
app.setLoginItemSettings({
    openAtLogin: false, // Deshabilitar auto-inicio
    path: app.getPath("exe"),
});
```

## 🐛 Solución de Problemas

### Puerto en Uso
Si el puerto 3000 está ocupado, la aplicación intentará un puerto alternativo automáticamente.

### Problemas de Auto-actualización
1. Verificar que el repositorio sea público
2. Confirmar que el `GITHUB_TOKEN` tiene permisos correctos
3. Revisar logs en DevTools (Tray → "🛠️ Abrir DevTools")

### Single Instance Lock
Solo una instancia puede ejecutarse. Para debugging, termina el proceso desde el Task Manager.

## 📋 Checklist de Release

- [ ] Actualizar versión en `package.json`
- [ ] Verificar archivo `.env` con `GITHUB_TOKEN`
- [ ] Commit todos los cambios
- [ ] Ejecutar `npm run make`
- [ ] Probar el instalador generado
- [ ] Ejecutar `npm run publish`
- [ ] Verificar release en GitHub
- [ ] Probar auto-actualización desde versión anterior

## 🤝 Contribuir

1. Fork el proyecto
2. Crear feature branch (`git checkout -b feature/nueva-funcionalidad`)
3. Commit cambios (`git commit -am 'Agregar nueva funcionalidad'`)
4. Push al branch (`git push origin feature/nueva-funcionalidad`)
5. Crear Pull Request

## 📄 Licencia

Este proyecto es propiedad de **LabelGrup Networks**.

## 📞 Soporte

Para soporte técnico, contactar: **ehernandez@labelgrup.com**