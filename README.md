# 🖥️ VerentiaIP - Servidor de IP Local con Auto-actualización

**VerentiaIP** es una aplicación de escritorio construida con Electron que proporciona un servidor local para obtener la dirección IP de la máquina así como las funcionalidades de conectividad con balanzas. La aplicación incluye un sistema de tray, splash screen y auto-actualización automática desde GitHub Releases.

## 📋 Características Principales

- 🌐 **Servidor HTTP/WebSocket**: Expone la IP local en `http://localhost:3000`
- 🔄 **Auto-actualización**: Sistema automático de actualizaciones desde GitHub
- 🖥️ **Tray System**: Aplicación que vive en la bandeja del sistema
- 🚀 **Auto-inicio**: Se ejecuta automáticamente al iniciar Windows
- 📡 **API REST**: Endpoint `/ip` para obtener la IP programáticamente
- 🔒 **Single Instance**: Previene múltiples instancias ejecutándose
- ⚖️ **Básculas Mettler Toledo y Bizerba**: API normalizada `/scale/*` con pesada guiada

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
├── src/
│   ├── server/
│   │   ├── legacy-routes.js   # /scale-command y /scale-hex (compatibilidad)
│   │   └── scale-routes.js    # /scale/* y /health
│   └── scales/
│       ├── transport.js       # TcpLink: enmarcado por líneas, lectura hasta silencio
│       ├── registry.js        # marca+modelo → driver
│       ├── units.js           # normalización a gramos
│       ├── errors.js          # ScaleError y mapeo a HTTP
│       └── drivers/
│           ├── mettler-toledo.js
│           ├── mt-sics-protocol.js
│           └── bizerba.js
├── test/                # pruebas con node:test (excluidas del paquete)
└── README.md            # Documentación
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

#### Enviar comando a la balanza (texto)
```bash
POST http://localhost:3000/scale-command
Content-Type: application/json
```
Recibe un comando como **texto** y lo envía por TCP a la balanza. El servidor:
- Añade `\r\n` (CRLF) al final si no lo trae.
- Sustituye los literales `<ETX>` por el byte de control `0x03`.

Body:
```json
{
  "ip": "10.32.230.18",
  "port": 10051,
  "command": "0<ETX>254<ETX>001<ETX>I!GX06"
}
```
Respuesta:
```json
{
  "success": true,
  "response": "...",
  "raw_response": "..."
}
```

#### Enviar trama HEX cruda
```bash
POST http://localhost:3000/scale-hex
Content-Type: application/json
```
Envía los **bytes exactos** indicados en hexadecimal, sin transformaciones ni encoding intermedio (equivalente a enviar la trama por un socket TCP crudo). Útil cuando la trama incluye bytes de control (STX, ETX, CRLF) o bytes >127. Acepta el hex con o sin espacios.

Body:
```json
{
  "ip": "10.32.230.18",
  "port": 10051,
  "hex": "30 03 32 35 34 03 30 30 31 03 49 21 47 58 30 36 0D 0A"
}
```
Respuesta:
```json
{
  "success": true,
  "response_hex": "...",
  "response_ascii": "..."
}
```

> La trama de ejemplo termina en `0D 0A` (CRLF). Decodificada en ASCII es: `0<ETX>254<ETX>001<ETX>I!GX06<CRLF>`.

### API de básculas (scale-v1)

Los endpoints `/scale-command` y `/scale-hex` de arriba **siguen funcionando igual** y no van a cambiar: son la compatibilidad para instalaciones que no han actualizado. Lo nuevo vive bajo `/scale/*` y conoce el protocolo, así que quien llama no monta tramas.

#### Descubrir qué sabe hacer esta instalación

```bash
GET http://localhost:3000/health
```
```json
{ "version": "1.3.0", "apis": ["legacy", "scale-v1"], "brands": ["mettler_toledo", "bizerba"] }
```

Una versión anterior de VerentiaIP devuelve **404** aquí. Ese 404 es la señal de que solo soporta los endpoints heredados.

```bash
GET http://localhost:3000/scale/brands
```
Devuelve, por marca: `label`, `defaultPort`, `capabilities` (garantizadas), `deviceDependent` (existen en el protocolo pero según el equipo) y `models` con override conocido.

#### Operaciones

Todas son `POST` con `{ip, port, brand}` obligatorios y `model`, `options` opcionales.

| Ruta | Mettler Toledo | Bizerba |
|---|---|---|
| `/scale/weigh` | sí | sí |
| `/scale/tare` | sí | sí |
| `/scale/clear-tare` | sí | sí |
| `/scale/info` | sí | sí |
| `/scale/select-platform` | según equipo | sí |
| `/scale/zero` | sí | 501 |
| `/scale/display` | sí | 501 |
| `/scale/display-clear` | sí | 501 |
| `/scale/beep` | según equipo | 501 |
| `/scale/guided-weigh` | sí | 501 |

```bash
POST http://localhost:3000/scale/weigh
{ "ip": "192.168.0.86", "port": 4305, "brand": "mettler_toledo" }
```
```json
{
  "success": true, "brand": "mettler_toledo", "model": null, "op": "weigh",
  "data": {
    "net":   { "value": 1234, "unit": "g" },
    "tare":  { "value": 50,   "unit": "g" },
    "gross": { "value": 1284, "unit": "g" },
    "stable": true
  },
  "raw": ["S S 1.234 kg", "TA A 0.050 kg"]
}
```

Los pesos salen **siempre en gramos**. `raw` lleva las líneas tal como las devolvió el equipo, que es lo único que sirve para depurar una báscula que contesta algo inesperado.

#### Pesada guiada

Muestra un texto, pita y pesa en una sola llamada sobre una sola conexión. El display se restaura al modo peso al terminar, también si la pesada falla.

```bash
POST http://localhost:3000/scale/guided-weigh
{ "ip": "192.168.0.86", "port": 4305, "brand": "mettler_toledo",
  "text": "PESAR BIDON 3", "beep": true, "waitStable": true, "timeoutMs": 10000 }
```

Si el equipo no tiene zumbador el pitido se omite y la pesada sigue: el `ES` queda anotado en `raw`.

#### Errores

```json
{ "success": false, "brand": "bizerba", "model": null, "op": "zero",
  "error": { "code": "not_supported", "message": "…", "detail": null } }
```

| `code` | HTTP | Significado |
|---|---|---|
| `unknown_brand` | 400 | marca no registrada |
| `missing_params` | 400 | faltan `ip`, `port` o `brand` |
| `not_supported` | 501 | esa báscula no sabe hacer esa operación |
| `connect` | 502 | no se pudo abrir el socket |
| `timeout` | 504 | conectó pero no contestó |
| `protocol` | 500 | contestó algo que no encaja |
| `overload` | 500 | sobrecarga o bajo rango |

`not_supported` llega por dos vías indistinguibles a propósito: el driver no declara la operación, o el equipo contestó `ES` (en MT-SICS, "no reconozco este comando"). Una ICS sin zumbador da 501 en `/scale/beep` sin configurar nada.

#### Opciones por instalación

`options.addressPrefix` cambia el direccionamiento de las tramas Bizerba, que por defecto es `["0", "254", "001"]`. Los elementos **deben ser strings** (escribir `"001"` no `1`), porque un número pierde el cero de relleno y direccionaría el equipo equivocado.

```json
{ "ip": "10.32.230.18", "port": 10051, "brand": "bizerba",
  "options": { "addressPrefix": ["1", "200", "002"] } }
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