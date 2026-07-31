# Soporte Mettler en VerentiaIP — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que VerentiaIP hable MT-SICS con básculas Mettler Toledo y BCP con Bizerba tras una API `/scale/*` normalizada, sin tocar el comportamiento de `/scale-command` ni `/scale-hex`.

**Architecture:** `main.js` deja de contener lógica de báscula. Un `TcpLink` con enmarcado por líneas y lectura hasta silencio sustituye al patrón `setTimeout(100)`. Un registro de drivers resuelve `(brand, model)` a un objeto con `capabilities`, `deviceDependent` y una función por operación; las rutas se montan a partir de ese registro, así que añadir una marca no toca los endpoints.

**Tech Stack:** Node 24.16, Electron 36, Express 4, `node:test` y `node:assert` (built-in, sin dependencias nuevas), `node:net`.

## Global Constraints

- **Cero dependencias nuevas.** Las pruebas usan `node:test`, `node:assert/strict` y `node:net`.
- **Node ≥ 24.16.0.** `fetch` global disponible en tests; no usar supertest ni node-fetch.
- **`/scale-command` y `/scale-hex` no cambian de comportamiento observable.** Mismo body aceptado, mismas claves de respuesta, mismos bugs (cierre a los 100 ms, `<STX>`/`<ETX>` re-escapados). Se mueven de fichero, nada más.
- **Encoding `latin1`** en todo el transporte. Nunca `utf8`: rompe bytes >127 de las tramas Bizerba.
- **Ids de driver:** exactamente `bizerba` y `mettler_toledo`. Son las claves que usa el SGA; no inventar `mettler_sics` ni variantes.
- **Los pesos salen siempre en gramos** en `data`, con `unit: 'g'`.
- **`raw` siempre presente** en las respuestas de éxito: es lo único que permite depurar una báscula que contesta algo inesperado.
- Ningún módulo bajo `src/scales/` puede requerir `electron`. Deben ser importables desde un test plano.
- Spec de referencia: `docs/superpowers/specs/2026-07-30-mettler-scale-support-design.md`.

---

### Task 1: Arnés de pruebas y báscula falsa

Sin esto no se puede verificar nada del resto. La báscula falsa es un servidor TCP controlable: los tests deciden qué contesta y en cuántos trozos, que es la única forma de probar el enmarcado.

**Files:**
- Create: `test/helpers/fake-scale.js`
- Create: `test/helpers/fake-scale.test.js`
- Modify: `package.json` (añadir script `test`)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `createRawScale(onData) → Promise<{port, received, close}>` — `onData(chunk: Buffer, socket)` se invoca en cada ráfaga. `received` es un array de `Buffer` con todo lo recibido.
  - `createLineScale(table, opts) → Promise<{port, received, close}>` — enmarca por `\r\n`, y por cada línea recibida busca `table[primerToken]`. El valor puede ser: `string` (una línea de respuesta), `string[]` (varias líneas), `null` (no contestar nada), o `function(line) → string|string[]|null`. `received` es un array de `string`. `opts.chunkSize` parte cada respuesta en trozos de N bytes con 10 ms entre ellos; `opts.delayMs` retrasa la respuesta.

- [ ] **Step 1: Escribir el test que falla**

```js
// test/helpers/fake-scale.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createRawScale, createLineScale } = require('./fake-scale');

function talk(port, payload, { waitMs = 200 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(port, '127.0.0.1');
        let received = Buffer.alloc(0);
        socket.on('connect', () => socket.write(payload, 'latin1'));
        socket.on('data', (d) => { received = Buffer.concat([received, d]); });
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); resolve(received.toString('latin1')); }, waitMs);
    });
}

test('createRawScale entrega los bytes exactos que recibe', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(chunk));
    try {
        const reply = await talk(scale.port, Buffer.from([0x30, 0x03, 0x41]));
        assert.equal(reply, '0\x03A');
        assert.equal(scale.received.length, 1);
        assert.deepEqual([...scale.received[0]], [0x30, 0x03, 0x41]);
    } finally {
        await scale.close();
    }
});

test('createLineScale responde segun el primer token de la linea', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg', I2: 'I2 A "ICS425-BW 3.0045 kg"' });
    try {
        assert.equal(await talk(scale.port, 'S\r\n'), 'S S 1.234 kg\r\n');
        assert.deepEqual(scale.received, ['S']);
    } finally {
        await scale.close();
    }
});

test('createLineScale devuelve varias lineas cuando el valor es un array', async () => {
    const scale = await createLineScale({ I0: ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A'] });
    try {
        assert.equal(await talk(scale.port, 'I0\r\n'), 'I0 B 1 "S"\r\nI0 B 2 "T"\r\nI0 A\r\n');
    } finally {
        await scale.close();
    }
});

test('createLineScale no contesta nada cuando el valor es null', async () => {
    const scale = await createLineScale({ SI: null });
    try {
        assert.equal(await talk(scale.port, 'SI\r\n', { waitMs: 120 }), '');
        assert.deepEqual(scale.received, ['SI']);
    } finally {
        await scale.close();
    }
});

test('chunkSize parte la respuesta sin cambiar el contenido', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' }, { chunkSize: 3 });
    try {
        assert.equal(await talk(scale.port, 'S\r\n', { waitMs: 400 }), 'S S 1.234 kg\r\n');
    } finally {
        await scale.close();
    }
});
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

Run: `node --test test/helpers/fake-scale.test.js`
Expected: FAIL — `Cannot find module './fake-scale'`

- [ ] **Step 3: Implementar la báscula falsa**

```js
// test/helpers/fake-scale.js
const net = require('node:net');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closer(server, sockets) {
    return () => new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
}

async function createRawScale(onData) {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => {
            received.push(Buffer.from(chunk));
            if (onData) onData(chunk, socket);
        });
    });
    const port = await listen(server);
    return { port, received, close: closer(server, sockets) };
}

function writeChunked(socket, text, chunkSize) {
    const payload = Buffer.from(text, 'latin1');
    if (!chunkSize) {
        socket.write(payload);
        return;
    }
    let offset = 0;
    const pump = () => {
        if (offset >= payload.length || socket.destroyed) return;
        socket.write(payload.subarray(offset, offset + chunkSize));
        offset += chunkSize;
        setTimeout(pump, 10);
    };
    pump();
}

async function createLineScale(table, { chunkSize = 0, delayMs = 0 } = {}) {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => {
            buffer += chunk.toString('latin1');
            let index;
            while ((index = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (!line) continue;
                received.push(line);
                const key = line.trim().split(/\s+/)[0];
                let reply = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 'ES';
                if (typeof reply === 'function') reply = reply(line);
                if (reply === null || reply === undefined) continue;
                const lines = Array.isArray(reply) ? reply : [reply];
                const text = lines.map((l) => `${l}\r\n`).join('');
                if (delayMs) setTimeout(() => writeChunked(socket, text, chunkSize), delayMs);
                else writeChunked(socket, text, chunkSize);
            }
        });
    });
    const port = await listen(server);
    return { port, received, close: closer(server, sockets) };
}

module.exports = { createRawScale, createLineScale };
```

Nota: una clave ausente en `table` contesta `ES`, que en MT-SICS es exactamente "no reconozco este comando". Así una báscula falsa sin `DS` se comporta como una real sin zumbador, sin configurar nada en el test.

- [ ] **Step 4: Añadir el script de test**

En `package.json`, dentro de `"scripts"`, añadir como primera entrada:

```json
    "test": "node --test test/",
```

- [ ] **Step 5: Ejecutar y verificar que pasa**

Run: `npm test`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json test/helpers/fake-scale.js test/helpers/fake-scale.test.js
git commit -m "test: add controllable fake TCP scale server

Lets tests drive framing, chunking and silence, which is what the
transport layer needs to be verified against. Unknown commands answer
ES so a fake device without a buzzer behaves like a real one."
```

---

### Task 2: Fijar el comportamiento actual de los endpoints legacy

Antes de mover una línea, se atornilla lo que hacen hoy. Estos tests son la red de seguridad de todo el refactor y deben seguir pasando sin modificarse hasta el final del plan.

**Files:**
- Create: `test/legacy-routes.test.js`

**Interfaces:**
- Consumes: `createRawScale` de Task 1.
- Produces: nada. Es una red de seguridad.

- [ ] **Step 1: Escribir los tests de regresión contra el `main.js` actual**

Los endpoints viven hoy dentro de `setupServer()` en `main.js`, que requiere `electron` y no es importable. Así que este test replica el arranque montando la app Express de la misma forma en que lo hará `registerLegacyRoutes` en Task 3, y verifica el contrato **observable**. Al terminar Task 3 el mismo fichero pasa a importar el módulo real, y eso es la prueba de que el movimiento no cambió nada.

```js
// test/legacy-routes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { createRawScale } = require('./helpers/fake-scale');
const { registerLegacyRoutes } = require('../src/server/legacy-routes');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

async function startApp() {
    const app = express();
    app.use(cors());
    app.use(express.json());
    registerLegacyRoutes(app, silentLogger);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((r) => server.close(() => r())) };
}

function post(base, path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('scale-command exige ip, port y command', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', { ip: '127.0.0.1' });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'Faltan parámetros requeridos: ip, port, command');
    } finally {
        await app.close();
    }
});

test('scale-command anade CRLF y traduce <ETX> a 0x03', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK\r\n'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: '0<ETX>254<ETX>001<ETX>I!GX06',
        });
        const sent = Buffer.concat(scale.received).toString('latin1');
        assert.equal(sent, '0\x03254\x03001\x03I!GX06\r\n');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-command no duplica el CRLF si ya venia', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK\r\n'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: 'S\r\n',
        });
        assert.equal(Buffer.concat(scale.received).toString('latin1'), 'S\r\n');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-command re-escapa STX y ETX en la respuesta y conserva la cruda', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('\x02I!LV01\x03\r\n', 'latin1'));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: 'S',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.response, '<STX>I!LV01<ETX>');
        assert.equal(body.raw_response, '\x02I!LV01\x03');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex envia los bytes exactos sin anadir terminador', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: scale.port, hex: '30 03 41',
        });
        assert.deepEqual([...Buffer.concat(scale.received)], [0x30, 0x03, 0x41]);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex acepta el hex sin espacios y devuelve hex y ascii', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(Buffer.from([0x41, 0x03])));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: scale.port, hex: '300341',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.response_hex, '41 03');
        assert.equal(body.response_ascii, 'A\x03');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex rechaza longitud impar', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: 1, hex: '303',
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'HEX con longitud impar');
    } finally {
        await app.close();
    }
});

test('un puerto cerrado da 500 y success false', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: 1, command: 'S',
        });
        assert.equal(res.status, 500);
        assert.equal((await res.json()).success, false);
    } finally {
        await app.close();
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/legacy-routes.test.js`
Expected: FAIL — `Cannot find module '../src/server/legacy-routes'`. Es el fallo correcto: el módulo es lo que crea Task 3.

- [ ] **Step 3: Commit del test solo**

Se commitea rojo a propósito: es la especificación ejecutable del movimiento que hace Task 3.

```bash
git add test/legacy-routes.test.js
git commit -m "test: pin observable contract of the legacy scale endpoints

Red on purpose: describes what /scale-command and /scale-hex must keep
doing byte for byte once they move out of main.js."
```

---

### Task 3: Extraer los endpoints legacy a su propio módulo

Movimiento puro. Copiar el cuerpo tal cual, con sus 100 ms y su duplicación, y envolverlo en una función. Cualquier tentación de mejorarlo aquí rompe la compatibilidad que es el objetivo.

**Files:**
- Create: `src/server/legacy-routes.js`
- Modify: `main.js:206-360` (quitar los dos bloques de endpoint y llamar al módulo)

**Interfaces:**
- Consumes: nada.
- Produces: `registerLegacyRoutes(expressApp, logger) → void`. Monta `POST /scale-command` y `POST /scale-hex`.

- [ ] **Step 1: Crear el módulo copiando los cuerpos actuales**

```js
// src/server/legacy-routes.js
const net = require('node:net');

/**
 * Endpoints heredados, conservados para instalaciones que todavia no han
 * actualizado. Copia literal de lo que habia en main.js: cierran el socket 100 ms
 * despues de la primera rafaga y abren una conexion por comando. Es un contrato,
 * no un diseno: no mejorar nada aqui.
 */
function registerLegacyRoutes(expressApp, logger) {
    expressApp.post('/scale-command', async (req, res) => {
        logger.info('🔄 Petición POST recibida en /scale-command');
        logger.info('📋 Body recibido:', req.body);
        const { ip, port, command } = req.body;

        if (!ip || !port || !command) {
            return res.status(400).json({
                success: false,
                error: 'Faltan parámetros requeridos: ip, port, command',
            });
        }

        logger.info(`⚖️ [POST] Enviando comando a ${ip}:${port} → ${command}`);

        try {
            const client = new net.Socket();
            let response = '';

            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000);

                client.connect(port, ip, () => {
                    logger.info(`✅ [POST] Conectado a ${ip}:${port}`);
                    let fullCommand = command.endsWith('\r\n') ? command : command + '\r\n';
                    fullCommand = fullCommand.replace(/<ETX>/g, '\x03');
                    logger.info(`➡️ [POST] Enviando: ${JSON.stringify(fullCommand)}`);
                    client.write(fullCommand, 'ascii');
                });

                client.on('data', (data) => {
                    response += data.toString('ascii');
                    logger.info(`📥 [POST] Datos recibidos: ${JSON.stringify(response)}`);
                    setTimeout(() => {
                        client.end();
                    }, 100);
                });

                client.on('end', () => {
                    logger.info(`✅ [POST] Conexión terminada. Respuesta final: ${response}`);
                    const cleanResponse = response
                        .replace(/\x02/g, '<STX>')
                        .replace(/\x03/g, '<ETX>')
                        .trim();
                    logger.info(`🧹 [POST] Respuesta limpia: ${cleanResponse}`);
                    resolve({
                        success: true,
                        response: cleanResponse,
                        raw_response: response.trim(),
                    });
                });

                client.on('error', (err) => {
                    logger.error(`❌ [POST] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on('timeout', () => {
                    logger.warn('⏰ [POST] Timeout al comunicar');
                    client.destroy();
                    reject({ success: false, error: 'Timeout de conexión' });
                });
            });

            res.json(result);
        } catch (err) {
            logger.error(`❌ [POST] Excepción: ${err.message}`);
            res.status(500).json({
                success: false,
                error: err.error || err.message,
            });
        }
    });

    expressApp.post('/scale-hex', async (req, res) => {
        logger.info('🔄 Petición POST recibida en /scale-hex');
        const { ip, port, hex } = req.body;

        if (!ip || !port || !hex) {
            return res.status(400).json({
                success: false,
                error: 'Faltan parámetros requeridos: ip, port, hex',
            });
        }

        const clean = hex.replace(/[^0-9a-fA-F]/g, '');
        if (clean.length % 2 !== 0) {
            return res.status(400).json({ success: false, error: 'HEX con longitud impar' });
        }
        const payload = Buffer.from(clean, 'hex');

        logger.info(`⚖️ [HEX] Enviando a ${ip}:${port} → ${payload.toString('hex').match(/../g).join(' ')}`);

        try {
            const client = new net.Socket();
            let response = Buffer.alloc(0);

            const result = await new Promise((resolve, reject) => {
                client.setTimeout(10000);

                client.connect(port, ip, () => {
                    logger.info(`✅ [HEX] Conectado a ${ip}:${port}`);
                    client.write(payload);
                });

                client.on('data', (data) => {
                    response = Buffer.concat([response, data]);
                    setTimeout(() => client.end(), 100);
                });

                client.on('end', () => {
                    const hexIn = response.toString('hex').match(/../g)?.join(' ') || '';
                    logger.info(`✅ [HEX] Respuesta (${response.length} bytes): ${hexIn}`);
                    resolve({
                        success: true,
                        response_hex: hexIn,
                        response_ascii: response.toString('latin1'),
                    });
                });

                client.on('error', (err) => {
                    logger.error(`❌ [HEX] Error TCP: ${err.message}`);
                    reject({ success: false, error: err.message });
                });

                client.on('timeout', () => {
                    logger.warn('⏰ [HEX] Timeout al comunicar');
                    client.destroy();
                    reject({ success: false, error: 'Timeout de conexión' });
                });
            });

            res.json(result);
        } catch (err) {
            logger.error(`❌ [HEX] Excepción: ${err.message}`);
            res.status(500).json({ success: false, error: err.error || err.message });
        }
    });
}

module.exports = { registerLegacyRoutes };
```

- [ ] **Step 2: Ejecutar los tests de regresión y verificar que pasan**

Run: `node --test test/legacy-routes.test.js`
Expected: PASS, 8 tests. Si alguno falla, el cuerpo copiado se desvía del original y hay que compararlo con `git show HEAD:main.js`.

- [ ] **Step 3: Borrar los dos bloques de `main.js` y llamar al módulo**

En `main.js`, borrar desde el comentario `// Nuevo endpoint POST para enviar comandos a la báscula` hasta el cierre del bloque `/scale-hex`, justo antes de `io.on("connection", ...)`. En su lugar dejar:

```js
    registerLegacyRoutes(expressApp, logger);
```

Y añadir el require arriba, junto a los demás:

```js
const { registerLegacyRoutes } = require("./src/server/legacy-routes");
```

- [ ] **Step 4: Verificar que la app sigue arrancando**

Run: `npm start`
Expected: arranca, el tray aparece y el log dice `✅ Servidor corriendo en http://localhost:3000`. Cerrar desde el tray.

Comprobación adicional con la app levantada:

```bash
curl -s -X POST http://localhost:3000/scale-hex \
  -H 'Content-Type: application/json' \
  -d '{"ip":"127.0.0.1","port":1,"hex":"3003"}'
```
Expected: `{"success":false,"error":"connect ECONNREFUSED 127.0.0.1:1"}` con HTTP 500. Demuestra que la ruta sigue montada.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add main.js src/server/legacy-routes.js
git commit -m "refactor: move legacy scale endpoints out of main.js

Pure move, bugs included: the 100ms close and the per-command connection
stay exactly as they were. The regression tests from the previous commit
now pass against the extracted module."
```

---

### Task 4: Errores tipados y conversión de unidades

Dos módulos pequeños que todo lo demás usa. Van juntos porque ninguno tiene sentido sin el otro y son 40 líneas entre los dos.

**Files:**
- Create: `src/scales/errors.js`
- Create: `src/scales/units.js`
- Create: `test/scales/units.test.js`
- Create: `test/scales/errors.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `ScaleError` — clase con `code` y `detail`. Códigos válidos en `ERROR_CODES`: `connect`, `timeout`, `protocol`, `not_supported`, `overload`, `unknown_brand`, `missing_params`.
  - `httpStatusFor(code) → number` — 400 `unknown_brand` y `missing_params`, 501 `not_supported`, 502 `connect`, 504 `timeout`, 500 el resto.
  - `toGrams(rawValue, unit, exponent = 0) → {value: number, unit: 'g'}` — lanza `ScaleError` con code `protocol` si la unidad no se conoce.
  - `KNOWN_UNITS` — `Set` de unidades que MT-SICS puede devolver, para el filtro de "esto es un peso".

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/units.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { toGrams, KNOWN_UNITS } = require('../../src/scales/units');
const { ScaleError } = require('../../src/scales/errors');

test('kg se convierte a gramos', () => {
    assert.deepEqual(toGrams(1.234, 'kg'), { value: 1234, unit: 'g' });
});

test('gramos pasan tal cual', () => {
    assert.deepEqual(toGrams(500, 'g'), { value: 500, unit: 'g' });
});

test('aplica el exponente antes de la unidad, como en las tramas Bizerba', () => {
    // kg;-3;1234 => 1234 * 10^-3 kg = 1.234 kg = 1234 g
    assert.deepEqual(toGrams(1234, 'kg', -3), { value: 1234, unit: 'g' });
});

test('el cero se conserva sin signo negativo', () => {
    assert.deepEqual(toGrams(0, 'kg', -3), { value: 0, unit: 'g' });
});

test('redondea a 4 decimales para no arrastrar error de coma flotante', () => {
    // 0.1 * 1000 da 100.00000000000001 en IEEE754 si no se redondea
    assert.deepEqual(toGrams(0.1, 'kg'), { value: 100, unit: 'g' });
});

test('valores negativos se conservan', () => {
    assert.deepEqual(toGrams(-0.5, 'kg'), { value: -500, unit: 'g' });
});

test('una unidad desconocida es error de protocolo', () => {
    assert.throws(() => toGrams(1, 'pcs'), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('KNOWN_UNITS incluye las unidades de peso y las no convertibles', () => {
    for (const unit of ['kg', 'g', 'mg', 't', 'lb', 'oz', 'pcs', '%']) {
        assert.ok(KNOWN_UNITS.has(unit), `falta ${unit}`);
    }
});
```

```js
// test/scales/errors.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ScaleError, httpStatusFor, ERROR_CODES } = require('../../src/scales/errors');

test('ScaleError guarda code y detail', () => {
    const err = new ScaleError('timeout', 'la bascula no contesto', { command: 'S' });
    assert.equal(err.code, 'timeout');
    assert.equal(err.message, 'la bascula no contesto');
    assert.deepEqual(err.detail, { command: 'S' });
    assert.ok(err instanceof Error);
});

test('ScaleError rechaza un code que no esta en la lista', () => {
    assert.throws(() => new ScaleError('inventado', 'x'), /code desconocido/);
});

test('cada code mapea a su estado HTTP', () => {
    assert.equal(httpStatusFor('unknown_brand'), 400);
    assert.equal(httpStatusFor('not_supported'), 501);
    assert.equal(httpStatusFor('connect'), 502);
    assert.equal(httpStatusFor('timeout'), 504);
    assert.equal(httpStatusFor('protocol'), 500);
    assert.equal(httpStatusFor('overload'), 500);
});

test('todos los codes declarados tienen estado', () => {
    for (const code of ERROR_CODES) {
        assert.equal(typeof httpStatusFor(code), 'number', `falta estado para ${code}`);
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que fallan**

Run: `node --test test/scales/`
Expected: FAIL — `Cannot find module '../../src/scales/units'`

- [ ] **Step 3: Implementar los dos módulos**

```js
// src/scales/errors.js
const ERROR_CODES = Object.freeze([
    'connect',        // no se pudo abrir el socket
    'timeout',        // se abrio pero no contesto a tiempo
    'protocol',       // contesto algo que no encaja con el protocolo
    'not_supported',  // la operacion no existe en esta bascula
    'overload',       // sobrecarga o bajo rango
    'unknown_brand',  // marca no registrada
    'missing_params', // faltan ip, port o brand en la peticion
]);

const HTTP_STATUS = Object.freeze({
    unknown_brand: 400,
    missing_params: 400,
    not_supported: 501,
    connect: 502,
    timeout: 504,
    protocol: 500,
    overload: 500,
});

class ScaleError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        if (!ERROR_CODES.includes(code)) {
            throw new Error(`code desconocido: ${code}`);
        }
        this.name = 'ScaleError';
        this.code = code;
        this.detail = detail;
    }
}

function httpStatusFor(code) {
    return HTTP_STATUS[code] ?? 500;
}

module.exports = { ScaleError, httpStatusFor, ERROR_CODES };
```

```js
// src/scales/units.js
const { ScaleError } = require('./errors');

// Factor a gramos. Las unidades que no son de masa se reconocen para poder
// descartarlas como peso, pero no tienen factor.
const TO_GRAMS = Object.freeze({
    kg: 1000,
    g: 1,
    mg: 0.001,
    t: 1000000,
    lb: 453.59237,
    oz: 28.349523125,
});

// Todo lo que un terminal MT-SICS puede poner como unidad. Se usa para decidir
// si una respuesta es un peso: sin este filtro `TIM A 14 09 50` se leeria como
// "14 unidades 09".
const KNOWN_UNITS = new Set([
    ...Object.keys(TO_GRAMS),
    'ozt', 'dwt', 'ct', 'gn', 'n', 'tlh', 'tls', 'tlt', 'pcs', '%',
]);

function toGrams(rawValue, unit, exponent = 0) {
    const factor = TO_GRAMS[String(unit).toLowerCase()];
    if (factor === undefined) {
        throw new ScaleError('protocol', `unidad no convertible a gramos: ${unit}`, { unit });
    }
    const grams = Number(rawValue) * 10 ** Number(exponent) * factor;
    // 0.1 kg da 100.00000000000001 sin redondear. 4 decimales es decima de mg.
    return { value: Number(grams.toFixed(4)), unit: 'g' };
}

module.exports = { toGrams, KNOWN_UNITS };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/`
Expected: PASS, 12 tests.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 25 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scales/errors.js src/scales/units.js test/scales/
git commit -m "feat: add typed scale errors and gram normalisation

Error codes map to HTTP status in one place, so not_supported reaching
the SGA as 501 is not something each route has to remember. toGrams
rounds to 4 decimals because 0.1kg otherwise yields 100.00000000000001."
```

---

### Task 5: TcpLink, el transporte con enmarcado por líneas

El corazón del cambio. Portado de la clase `SicsLink` de `/home/manel/scripts/mettler/mt.py`, que ya está probada contra la ICS425. Tres cosas que el código actual no hace: leer hasta que hay silencio en vez de cerrar a los 100 ms, drenar el buffer antes de cada envío, y permitir varios comandos sobre una conexión.

**Files:**
- Create: `src/scales/transport.js`
- Create: `test/scales/transport.test.js`

**Interfaces:**
- Consumes: `ScaleError` de Task 4.
- Produces: clase `TcpLink`.
  - `new TcpLink({host, port, framing})` donde `framing = {terminator, encoding, quietMs, totalMs}`.
  - `await link.connect()` — abre. Lanza `ScaleError('connect')`.
  - `await link.command(raw, {quietMs, totalMs} = {}) → string[]` — envía y devuelve las líneas. Array vacío si no contesta nada.
  - `await link.send(raw) → void` — envía sin esperar.
  - `link.close() → void` — idempotente.
  - `link.connected → boolean`

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/transport.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { TcpLink } = require('../../src/scales/transport');
const { ScaleError } = require('../../src/scales/errors');
const { createLineScale, createRawScale } = require('../helpers/fake-scale');

const FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 120, totalMs: 1500 };

function linkTo(port, framing = FRAMING) {
    return new TcpLink({ host: '127.0.0.1', port, framing });
}

test('command devuelve la linea de respuesta sin el terminador', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('anade el terminador al enviar', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.command('S');
        assert.deepEqual(scale.received, ['S']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('reune una respuesta que llega partida en varias rafagas', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' }, { chunkSize: 2 });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('devuelve varias lineas cuando la respuesta es multilinea', async () => {
    const scale = await createLineScale({ I0: ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A'] });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('I0'), ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('silencio total devuelve array vacio, no un error', async () => {
    const scale = await createLineScale({ SI: null });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('SI'), []);
    } finally {
        link.close();
        await scale.close();
    }
});

test('varios comandos sobre una sola conexion no se mezclan', async () => {
    const scale = await createLineScale({ S: 'S S 1.000 kg', TA: 'TA A 0.050 kg', DW: 'DW A' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
        assert.deepEqual(await link.command('TA'), ['TA A 0.050 kg']);
        assert.deepEqual(await link.command('DW'), ['DW A']);
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('drena la cola de un comando anterior antes de enviar el siguiente', async () => {
    // La bascula contesta a SIR dos veces: la segunda linea llega tarde y sin
    // drenado se leeria como respuesta de S.
    const scale = await createLineScale({
        SIR: ['S D 0.500 kg', 'S D 0.600 kg'],
        S: 'S S 1.234 kg',
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.send('SIR');
        await new Promise((r) => setTimeout(r, 150));
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('totalMs corta una bascula que no calla nunca', async () => {
    const scale = await createRawScale((chunk, socket) => {
        const pump = () => {
            if (socket.destroyed) return;
            socket.write('S D 0.100 kg\r\n');
            setTimeout(pump, 20);
        };
        pump();
    });
    const link = linkTo(scale.port, { ...FRAMING, quietMs: 50, totalMs: 300 });
    try {
        await link.connect();
        const started = Date.now();
        const lines = await link.command('SIR');
        const elapsed = Date.now() - started;
        assert.ok(lines.length > 1, 'deberia haber leido varias lineas');
        assert.ok(elapsed < 1000, `tardo ${elapsed}ms, deberia cortar cerca de 300`);
    } finally {
        link.close();
        await scale.close();
    }
});

test('connect contra un puerto cerrado lanza ScaleError connect', async () => {
    const link = linkTo(1);
    await assert.rejects(() => link.connect(), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'connect');
        return true;
    });
});

test('si la bascula cierra a media lectura es error de protocolo', async () => {
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.2');
        setTimeout(() => socket.destroy(), 30);
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await assert.rejects(() => link.command('S'), (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        });
    } finally {
        link.close();
        await scale.close();
    }
});

test('close es idempotente y deja connected en false', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    await link.connect();
    assert.equal(link.connected, true);
    link.close();
    link.close();
    assert.equal(link.connected, false);
    await scale.close();
});

test('command reconecta solo si no hay socket', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        assert.equal(link.connected, false);
        assert.deepEqual(await link.command('S'), ['S S 0.000 kg']);
        assert.equal(link.connected, true);
    } finally {
        link.close();
        await scale.close();
    }
});

test('acepta \\r como terminador para modelos que lo usan', async () => {
    const scale = await createRawScale((chunk, socket) => {
        if (chunk.toString('latin1') === 'S\r') socket.write('S S 1.000 kg\r');
    });
    const link = linkTo(scale.port, { ...FRAMING, terminator: '\r' });
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/transport.test.js`
Expected: FAIL — `Cannot find module '../../src/scales/transport'`

- [ ] **Step 3: Implementar TcpLink**

```js
// src/scales/transport.js
const net = require('node:net');
const { ScaleError } = require('./errors');

const DEFAULT_FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 };

/**
 * Conexion TCP a una bascula, con enmarcado de respuestas por lineas.
 *
 * Portado de la clase SicsLink de mt.py. Frente al patron que habia en main.js
 * (cerrar el socket 100 ms despues de la primera rafaga) aporta tres cosas:
 *
 *  - lee hasta que pasan `quietMs` sin datos nuevos, con techo `totalMs`, asi que
 *    una respuesta multilinea llega completa;
 *  - drena lo que quede pendiente antes de cada envio, asi que la cola de un
 *    comando no se lee como respuesta del siguiente;
 *  - admite varios comandos sobre la misma conexion, que es lo que hace posible
 *    la secuencia texto -> pitido -> pesada -> restaurar display.
 */
class TcpLink {
    constructor({ host, port, framing = {} }) {
        this.host = host;
        this.port = port;
        this.framing = { ...DEFAULT_FRAMING, ...framing };
        this.socket = null;
        this.buffer = '';
        this.pending = [];   // lineas completas ya recibidas y sin consumir
        this.fatal = null;   // ScaleError que mato la conexion
    }

    get connected() {
        return this.socket !== null;
    }

    connect() {
        this.close();
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const onError = (err) => {
                socket.destroy();
                reject(new ScaleError('connect', `no se puede conectar a ${this.host}:${this.port} (${err.message})`, { host: this.host, port: this.port }));
            };
            socket.once('error', onError);
            socket.connect(this.port, this.host, () => {
                socket.removeListener('error', onError);
                this.socket = socket;
                this.buffer = '';
                this.pending = [];
                this.fatal = null;
                socket.on('data', (chunk) => this._absorb(chunk));
                socket.on('error', (err) => {
                    this.fatal = new ScaleError('protocol', `error de lectura (${err.message})`);
                });
                socket.on('close', () => {
                    if (this.socket === socket) {
                        this.fatal = this.fatal || new ScaleError('protocol', 'la bascula cerro la conexion');
                        this.socket = null;
                    }
                });
                resolve();
            });
        });
    }

    close() {
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            socket.removeAllListeners();
            socket.destroy();
        }
        this.buffer = '';
        this.pending = [];
        this.fatal = null;
    }

    _absorb(chunk) {
        this.buffer += chunk.toString(this.framing.encoding);
        const term = this.framing.terminator;
        let index;
        while ((index = this.buffer.indexOf(term)) !== -1) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + term.length);
            if (line) this.pending.push(line);
        }
    }

    /** Descarta lo que quede del comando anterior. */
    _drain() {
        this.pending = [];
        this.buffer = '';
    }

    async send(raw) {
        if (!this.socket) await this.connect();
        this._drain();
        const payload = raw + this.framing.terminator;
        try {
            this.socket.write(Buffer.from(payload, this.framing.encoding));
        } catch (err) {
            this.close();
            throw new ScaleError('protocol', `error de escritura (${err.message})`);
        }
    }

    async command(raw, { quietMs, totalMs } = {}) {
        await this.send(raw);
        return this._readLines(
            quietMs ?? this.framing.quietMs,
            totalMs ?? this.framing.totalMs,
        );
    }

    /**
     * Espera hasta `quiet` ms de silencio tras la primera linea, o hasta que
     * venza `total`. Devuelve las lineas acumuladas; array vacio si no llego nada.
     */
    _readLines(quiet, total) {
        const deadline = Date.now() + total;
        return new Promise((resolve, reject) => {
            const tick = () => {
                if (this.fatal && this.pending.length === 0) {
                    const err = this.fatal;
                    this.close();
                    reject(err);
                    return;
                }
                const now = Date.now();
                if (this.pending.length > 0) {
                    // Ya hay algo: se espera un hueco de silencio por si viene mas.
                    const count = this.pending.length;
                    setTimeout(() => {
                        if (this.pending.length === count || Date.now() >= deadline) {
                            const lines = this.pending;
                            this.pending = [];
                            resolve(lines);
                        } else {
                            tick();
                        }
                    }, quiet);
                    return;
                }
                if (now >= deadline) {
                    resolve([]);
                    return;
                }
                setTimeout(tick, 10);
            };
            tick();
        });
    }
}

module.exports = { TcpLink, DEFAULT_FRAMING };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/transport.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 38 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scales/transport.js test/scales/transport.test.js
git commit -m "feat: add line-framed TCP transport for scales

Ported from mt.py's SicsLink, already proven against the ICS425. Reads
until the line goes quiet instead of closing 100ms after the first burst,
drains stale data before each send, and keeps one connection open across
several commands, which is what guided weighing needs."
```

---

### Task 6: Registro de drivers y resolución de modelo

Mecanismo puro, sin ningún driver todavía. Se prueba con drivers de juguete definidos en el propio test, que es lo que permite verificar la validación de coherencia sin depender de MT-SICS.

**Files:**
- Create: `src/scales/registry.js`
- Create: `test/scales/registry.test.js`

**Interfaces:**
- Consumes: `ScaleError` de Task 4.
- Produces:
  - `createRegistry(drivers) → {resolveDriver, allOperations, listBrands}` — valida cada driver al construir; lanza `Error` si alguno es incoherente.
  - `registry.resolveDriver(brand, model) → driver` — la base fusionada con el override del modelo. Lanza `ScaleError('unknown_brand')` si la marca no está.
  - `registry.allOperations(driver) → string[]` — unión de `capabilities` y `deviceDependent`.
  - `registry.listBrands() → array` — catálogo para `GET /scale/brands`: `[{id, label, defaultPort, capabilities, deviceDependent, models}]`.
  - `OPERATIONS` — lista canónica de nombres de operación en camelCase.
  - `routePathFor(operation) → string` — camelCase a kebab-case (`clearTare` → `clear-tare`).

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/registry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createRegistry, OPERATIONS, routePathFor,
} = require('../../src/scales/registry');
const { ScaleError } = require('../../src/scales/errors');

function toyDriver(overrides = {}) {
    return {
        id: 'toy',
        label: 'Juguete',
        defaultPort: 1234,
        framing: { terminator: '\r\n', encoding: 'latin1' },
        capabilities: ['weigh'],
        deviceDependent: [],
        models: {},
        async weigh() { return { net: { value: 0, unit: 'g' } }; },
        ...overrides,
    };
}

test('resolveDriver devuelve la base cuando no se pasa modelo', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', null);
    assert.equal(driver.id, 'toy');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('un modelo con override cambia solo lo declarado y hereda el resto', () => {
    const registry = createRegistry([toyDriver({
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    const driver = registry.resolveDriver('toy', 'rare');
    assert.equal(driver.framing.terminator, '\r');
    assert.equal(driver.framing.encoding, 'latin1', 'encoding deberia heredarse');
    assert.equal(driver.defaultPort, 1234);
    assert.equal(typeof driver.weigh, 'function');
});

test('un modelo sin override cae a la base sin fallar', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', 'ics425');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('una marca desconocida lanza ScaleError unknown_brand con la lista valida', () => {
    const registry = createRegistry([toyDriver()]);
    assert.throws(() => registry.resolveDriver('acme', null), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'unknown_brand');
        assert.deepEqual(err.detail.validBrands, ['toy']);
        return true;
    });
});

test('rechaza un driver que declara una capacidad sin implementarla', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'tare'] })]),
        /declara 'tare' pero no la implementa/,
    );
});

test('rechaza un driver que implementa una operacion sin declararla', () => {
    assert.throws(
        () => createRegistry([toyDriver({ async tare() {} })]),
        /implementa 'tare' pero no la declara/,
    );
});

test('rechaza una capacidad que no esta en OPERATIONS', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'inventada'], async inventada() {} })]),
        /operacion desconocida: inventada/,
    );
});

test('rechaza una operacion declarada a la vez como garantizada y dependiente', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh'], deviceDependent: ['weigh'] })]),
        /declarada dos veces: weigh/,
    );
});

test('deviceDependent tambien exige implementacion', () => {
    const registry = createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
    })]);
    const driver = registry.resolveDriver('toy', null);
    assert.deepEqual(registry.allOperations(driver).sort(), ['beep', 'weigh']);
});

test('listBrands expone el catalogo para el SGA', () => {
    const registry = createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    assert.deepEqual(registry.listBrands(), [{
        id: 'toy',
        label: 'Juguete',
        defaultPort: 1234,
        capabilities: ['weigh'],
        deviceDependent: ['beep'],
        models: ['rare'],
    }]);
});

test('routePathFor convierte camelCase a kebab-case', () => {
    assert.equal(routePathFor('weigh'), 'weigh');
    assert.equal(routePathFor('clearTare'), 'clear-tare');
    assert.equal(routePathFor('displayClear'), 'display-clear');
    assert.equal(routePathFor('selectPlatform'), 'select-platform');
    assert.equal(routePathFor('guidedWeigh'), 'guided-weigh');
});

test('OPERATIONS contiene las diez operaciones del spec', () => {
    assert.deepEqual([...OPERATIONS].sort(), [
        'beep', 'clearTare', 'display', 'displayClear', 'guidedWeigh',
        'info', 'selectPlatform', 'tare', 'weigh', 'zero',
    ]);
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/registry.test.js`
Expected: FAIL — `Cannot find module '../../src/scales/registry'`

- [ ] **Step 3: Implementar el registro**

```js
// src/scales/registry.js
const { ScaleError } = require('./errors');

// Nombres canonicos de operacion. Las rutas se derivan de aqui, asi que anadir
// una operacion es anadirla a esta lista y a los drivers que la sepan hacer.
const OPERATIONS = Object.freeze([
    'weigh', 'tare', 'clearTare', 'zero', 'info',
    'selectPlatform', 'display', 'displayClear', 'beep', 'guidedWeigh',
]);

function routePathFor(operation) {
    return operation.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function validate(driver) {
    const declared = [...(driver.capabilities || []), ...(driver.deviceDependent || [])];

    const seen = new Set();
    for (const op of declared) {
        if (!OPERATIONS.includes(op)) {
            throw new Error(`driver '${driver.id}': operacion desconocida: ${op}`);
        }
        if (seen.has(op)) {
            throw new Error(`driver '${driver.id}': operacion declarada dos veces: ${op}`);
        }
        seen.add(op);
        if (typeof driver[op] !== 'function') {
            throw new Error(`driver '${driver.id}': declara '${op}' pero no la implementa`);
        }
    }

    for (const op of OPERATIONS) {
        if (typeof driver[op] === 'function' && !seen.has(op)) {
            throw new Error(`driver '${driver.id}': implementa '${op}' pero no la declara`);
        }
    }
}

/** Fusion superficial de un nivel, suficiente para {framing, defaultPort, telegrams}. */
function mergeOverride(base, override) {
    if (!override) return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = base[key];
        merged[key] = (value && typeof value === 'object' && !Array.isArray(value)
            && current && typeof current === 'object' && !Array.isArray(current))
            ? { ...current, ...value }
            : value;
    }
    return merged;
}

function createRegistry(drivers) {
    const byId = new Map();
    for (const driver of drivers) {
        validate(driver);
        byId.set(driver.id, driver);
    }

    function resolveDriver(brand, model = null) {
        const base = byId.get(brand);
        if (!base) {
            throw new ScaleError('unknown_brand', `marca no soportada: ${brand}`, {
                brand,
                validBrands: [...byId.keys()],
            });
        }
        if (!model) return base;
        const override = (base.models || {})[model];
        // Un modelo sin override es el caso normal: el catalogo del SGA es mas
        // amplio que esta tabla porque solo se da de alta lo que se desvia.
        return mergeOverride(base, override);
    }

    function allOperations(driver) {
        return [...(driver.capabilities || []), ...(driver.deviceDependent || [])];
    }

    function listBrands() {
        return [...byId.values()].map((driver) => ({
            id: driver.id,
            label: driver.label,
            defaultPort: driver.defaultPort,
            capabilities: [...(driver.capabilities || [])],
            deviceDependent: [...(driver.deviceDependent || [])],
            models: Object.keys(driver.models || {}),
        }));
    }

    return { resolveDriver, allOperations, listBrands };
}

module.exports = { createRegistry, OPERATIONS, routePathFor };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/registry.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 50 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scales/registry.js test/scales/registry.test.js
git commit -m "feat: add scale driver registry with model overrides

Validates at construction that declared capabilities and implemented
functions match, so a driver promising an operation it lacks fails at
startup rather than as a 500 in production. Model overrides merge over
the family baseline; a model with no override is the normal case."
```

---

### Task 7: Protocolo MT-SICS, funciones puras de interpretación

Aparte del driver a propósito: son funciones sin E/S, y es donde vive la lógica que más fácilmente se equivoca. Portadas de las funciones `split_tokens`, `parse_weight` e `interpret` de `mt.py`.

**Files:**
- Create: `src/scales/drivers/mt-sics-protocol.js`
- Create: `test/scales/mt-sics-protocol.test.js`

**Interfaces:**
- Consumes: `ScaleError` de Task 4, `KNOWN_UNITS` y `toGrams` de Task 4.
- Produces:
  - `splitTokens(line) → string[]` — trocea respetando comillas dobles, que es como MT-SICS devuelve textos con espacios.
  - `parseWeight(tokens) → {value: number, unit: string} | null` — `null` si la respuesta no es un peso.
  - `assertOk(lines) → string[]` — valida la primera línea y devuelve sus tokens. Lanza `ScaleError`: `ES` → `not_supported`, `ET`/`EL` → `protocol`, `+`/`-` → `overload`, `I`/`L` → `protocol`, sin líneas → `timeout`.
  - `isStable(tokens) → boolean` — cierto si el estado es `S`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/mt-sics-protocol.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitTokens, parseWeight, assertOk, isStable,
} = require('../../src/scales/drivers/mt-sics-protocol');
const { ScaleError } = require('../../src/scales/errors');

test('splitTokens trocea por espacios', () => {
    assert.deepEqual(splitTokens('S S 1.234 kg'), ['S', 'S', '1.234', 'kg']);
});

test('splitTokens respeta las comillas dobles como un solo token', () => {
    assert.deepEqual(
        splitTokens('I2 A "ICS425-BW 3.0045 kg"'),
        ['I2', 'A', 'ICS425-BW 3.0045 kg'],
    );
});

test('splitTokens tolera comillas vacias', () => {
    assert.deepEqual(splitTokens('I10 A ""'), ['I10', 'A', '']);
});

test('parseWeight lee valor y unidad de los dos ultimos tokens', () => {
    assert.deepEqual(parseWeight(['S', 'S', '1.234', 'kg']), { value: 1.234, unit: 'kg' });
});

test('parseWeight acepta pesos negativos', () => {
    assert.deepEqual(parseWeight(['S', 'S', '-0.500', 'kg']), { value: -0.5, unit: 'kg' });
});

test('parseWeight ignora una respuesta cuya ultima palabra no es unidad', () => {
    // Sin este filtro `TIM A 14 09 50` se leeria como "14 unidades 09".
    assert.equal(parseWeight(['TIM', 'A', '14', '09', '50']), null);
});

test('parseWeight ignora una respuesta demasiado corta', () => {
    assert.equal(parseWeight(['Z', 'A']), null);
});

test('parseWeight ignora un valor no numerico aunque la unidad sea buena', () => {
    assert.equal(parseWeight(['S', 'S', 'abc', 'kg']), null);
});

test('assertOk devuelve los tokens de una respuesta correcta', () => {
    assert.deepEqual(assertOk(['Z A']), ['Z', 'A']);
});

test('assertOk traduce ES a not_supported, porque el equipo no conoce el comando', () => {
    assert.throws(() => assertOk(['ES']), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'not_supported');
        return true;
    });
});

test('assertOk traduce ET y EL a protocol', () => {
    for (const code of ['ET', 'EL']) {
        assert.throws(() => assertOk([code]), (err) => {
            assert.equal(err.code, 'protocol', `${code} deberia ser protocol`);
            return true;
        });
    }
});

test('assertOk traduce + y - a overload', () => {
    assert.throws(() => assertOk(['S +']), (err) => {
        assert.equal(err.code, 'overload');
        assert.equal(err.detail.status, '+');
        return true;
    });
    assert.throws(() => assertOk(['S -']), (err) => {
        assert.equal(err.code, 'overload');
        return true;
    });
});

test('assertOk traduce I y L a protocol con el estado en detail', () => {
    assert.throws(() => assertOk(['T I']), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'I');
        return true;
    });
    assert.throws(() => assertOk(['SNS L']), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'L');
        return true;
    });
});

test('assertOk sin lineas es timeout', () => {
    assert.throws(() => assertOk([]), (err) => {
        assert.equal(err.code, 'timeout');
        return true;
    });
});

test('assertOk acepta el estado D de peso dinamico', () => {
    assert.deepEqual(assertOk(['S D 0.500 kg']), ['S', 'D', '0.500', 'kg']);
});

test('isStable distingue S de D', () => {
    assert.equal(isStable(['S', 'S', '1.234', 'kg']), true);
    assert.equal(isStable(['S', 'D', '1.234', 'kg']), false);
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/mt-sics-protocol.test.js`
Expected: FAIL — `Cannot find module '../../src/scales/drivers/mt-sics-protocol'`

- [ ] **Step 3: Implementar el protocolo**

```js
// src/scales/drivers/mt-sics-protocol.js
const { ScaleError } = require('../errors');
const { KNOWN_UNITS } = require('../units');

// Respuestas fatales de MT-SICS. ES significa literalmente "no reconozco este
// comando", asi que se traduce a not_supported y no a protocol: es lo que hace
// que una bascula sin zumbador responda 501 en /scale/beep sin configurar nada.
const FATAL = Object.freeze({
    ES: ['not_supported', 'el equipo no reconoce este comando'],
    ET: ['protocol', 'error de transmision'],
    EL: ['protocol', 'error logico'],
});

const STATUS_LABEL = Object.freeze({
    A: 'ok',
    B: 'listado',
    S: 'estable',
    D: 'dinamico',
    I: 'ocupado o no ejecutable ahora',
    L: 'parametro no permitido',
    '+': 'sobrecarga',
    '-': 'bajo rango',
});

/** Trocea una linea respetando las comillas dobles: `I2 A "ICS425 3 kg"`. */
function splitTokens(line) {
    const tokens = [];
    const re = /"([^"]*)"|(\S+)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
        tokens.push(match[1] !== undefined ? match[1] : match[2]);
    }
    return tokens;
}

/**
 * (valor, unidad) de una respuesta tipo `S S 0.000 kg`, o null.
 *
 * Exige que el ultimo token sea una unidad conocida y el anterior un numero.
 * Comandos como TIM, DAT o I51 devuelven varios numeros sueltos y no deben
 * confundirse con una pesada.
 */
function parseWeight(tokens) {
    if (tokens.length < 4) return null;
    const unit = tokens[tokens.length - 1];
    const raw = tokens[tokens.length - 2];
    if (!KNOWN_UNITS.has(String(unit).toLowerCase())) return null;
    if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return null;
    return { value: Number(raw), unit };
}

function assertOk(lines) {
    if (!lines || lines.length === 0) {
        throw new ScaleError('timeout', 'la bascula no contesto');
    }

    const tokens = splitTokens(lines[0]);

    const fatal = FATAL[tokens[0]];
    if (fatal) {
        throw new ScaleError(fatal[0], fatal[1], { response: lines[0] });
    }

    const status = tokens[1];
    if (status === '+' || status === '-') {
        throw new ScaleError('overload', STATUS_LABEL[status], { status, response: lines[0] });
    }
    if (status === 'I' || status === 'L') {
        throw new ScaleError('protocol', STATUS_LABEL[status], { status, response: lines[0] });
    }

    return tokens;
}

function isStable(tokens) {
    return tokens[1] === 'S';
}

module.exports = { splitTokens, parseWeight, assertOk, isStable, STATUS_LABEL };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/mt-sics-protocol.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scales/drivers/mt-sics-protocol.js test/scales/mt-sics-protocol.test.js
git commit -m "feat: add MT-SICS response interpretation

Pure functions, no I/O. ES maps to not_supported rather than protocol
because it literally means the device does not know the command. Weight
parsing requires a known unit in the last token, otherwise TIM A 14 09 50
reads as 14 units 09 — a real bug mt.py documents."
```

---

### Task 8: Driver Mettler Toledo, operaciones atómicas

**Files:**
- Create: `src/scales/drivers/mettler-toledo.js`
- Create: `test/scales/mettler-toledo.test.js`

**Interfaces:**
- Consumes: `mt-sics-protocol` de Task 7, `toGrams` de Task 4, `TcpLink` de Task 5.
- Produces: objeto driver con `id: 'mettler_toledo'`. Cada operación tiene la firma `async op(link, params) → {data, raw}`:
  - `weigh(link)` → `{data: {net, tare, gross, stable}, raw}` — `net`/`tare`/`gross` son `{value, unit:'g'}`.
  - `tare(link)` → `{data: {tare}, raw}`
  - `clearTare(link)` → `{data: {}, raw}`
  - `zero(link)` → `{data: {}, raw}`
  - `info(link)` → `{data: {model, capacity, serial}, raw}`
  - `selectPlatform(link, {platform})` → `{data: {platform}, raw}`
  - `display(link, {text})` → `{data: {}, raw}`
  - `displayClear(link)` → `{data: {}, raw}`
  - `beep(link)` → `{data: {}, raw}`

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/mettler-toledo.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/mettler-toledo');
const { TcpLink } = require('../../src/scales/transport');
const { createLineScale } = require('../helpers/fake-scale');

async function withScale(table, fn) {
    const scale = await createLineScale(table);
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        return await fn(link, scale);
    } finally {
        link.close();
        await scale.close();
    }
}

test('el driver se identifica con el id que usa el SGA', () => {
    assert.equal(driver.id, 'mettler_toledo');
    assert.equal(driver.defaultPort, 4305);
});

test('beep y selectPlatform son dependientes del equipo, no garantizadas', () => {
    assert.deepEqual(driver.deviceDependent.sort(), ['beep', 'selectPlatform']);
    assert.ok(!driver.capabilities.includes('beep'));
    assert.ok(!driver.capabilities.includes('selectPlatform'));
});

test('weigh pide S y TA, y calcula el bruto', async () => {
    const result = await withScale({
        S: 'S S 1.234 kg',
        TA: 'TA A 0.050 kg',
    }, async (link, scale) => {
        const res = await driver.weigh(link);
        assert.deepEqual(scale.received, ['S', 'TA']);
        return res;
    });

    assert.deepEqual(result.data.net, { value: 1234, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 50, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 1284, unit: 'g' });
    assert.equal(result.data.stable, true);
    assert.deepEqual(result.raw, ['S S 1.234 kg', 'TA A 0.050 kg']);
});

test('weigh marca stable false con estado D', async () => {
    const result = await withScale({
        S: 'S D 0.700 kg',
        TA: 'TA A 0.000 kg',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, false);
    assert.deepEqual(result.data.gross, { value: 700, unit: 'g' });
});

test('weigh propaga la sobrecarga', async () => {
    await assert.rejects(
        () => withScale({ S: 'S +' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'overload');
            return true;
        },
    );
});

test('weigh falla como protocol si S contesta algo que no es un peso', async () => {
    await assert.rejects(
        () => withScale({ S: 'S A' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('tare envia T y devuelve la tara resultante', async () => {
    const result = await withScale({ T: 'T S 0.230 kg' }, async (link, scale) => {
        const res = await driver.tare(link);
        assert.deepEqual(scale.received, ['T']);
        return res;
    });
    assert.deepEqual(result.data.tare, { value: 230, unit: 'g' });
});

test('clearTare envia TAC', async () => {
    await withScale({ TAC: 'TAC A' }, async (link, scale) => {
        const res = await driver.clearTare(link);
        assert.deepEqual(scale.received, ['TAC']);
        assert.deepEqual(res.data, {});
    });
});

test('zero envia Z', async () => {
    await withScale({ Z: 'Z A' }, async (link, scale) => {
        await driver.zero(link);
        assert.deepEqual(scale.received, ['Z']);
    });
});

test('info separa modelo y capacidad de I2, y lee el numero de serie de I4', async () => {
    const result = await withScale({
        I2: 'I2 A "ICS425-BW 3.0045 kg"',
        I4: 'I4 A "C614409345"',
    }, async (link, scale) => {
        const res = await driver.info(link);
        assert.deepEqual(scale.received, ['I2', 'I4']);
        return res;
    });
    assert.equal(result.data.model, 'ICS425-BW');
    assert.equal(result.data.capacity, '3.0045 kg');
    assert.equal(result.data.serial, 'C614409345');
});

test('display envia el texto entre comillas', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'PESAR BIDON 3' });
        assert.deepEqual(scale.received, ['D "PESAR BIDON 3"']);
    });
});

test('display quita las comillas dobles del texto para no romper la trama', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'DI "HOLA"' });
        assert.deepEqual(scale.received, ['D "DI HOLA"']);
    });
});

test('display rechaza un texto vacio antes de tocar la red', async () => {
    await assert.rejects(
        () => withScale({ D: 'D A' }, (link) => driver.display(link, { text: '' })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('displayClear envia DW', async () => {
    await withScale({ DW: 'DW A' }, async (link, scale) => {
        await driver.displayClear(link);
        assert.deepEqual(scale.received, ['DW']);
    });
});

test('beep envia DS', async () => {
    await withScale({ DS: 'DS A' }, async (link, scale) => {
        await driver.beep(link);
        assert.deepEqual(scale.received, ['DS']);
    });
});

test('beep en un equipo sin zumbador da not_supported', async () => {
    // La bascula falsa contesta ES a lo que no esta en la tabla, igual que una real.
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.beep(link)),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});

test('selectPlatform envia SNS con el numero', async () => {
    await withScale({ SNS: 'SNS A 2' }, async (link, scale) => {
        const res = await driver.selectPlatform(link, { platform: 2 });
        assert.deepEqual(scale.received, ['SNS 2']);
        assert.equal(res.data.platform, 2);
    });
});

test('selectPlatform rechaza un numero que no es 1 ni 2', async () => {
    await assert.rejects(
        () => withScale({ SNS: 'SNS A' }, (link) => driver.selectPlatform(link, { platform: 7 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('selectPlatform en un equipo de una sola plataforma da not_supported', async () => {
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.selectPlatform(link, { platform: 1 })),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/mettler-toledo.test.js`
Expected: FAIL — `Cannot find module '../../src/scales/drivers/mettler-toledo'`

- [ ] **Step 3: Implementar el driver**

```js
// src/scales/drivers/mettler-toledo.js
const { ScaleError } = require('../errors');
const { toGrams } = require('../units');
const { assertOk, parseWeight, isStable } = require('./mt-sics-protocol');

/** Ejecuta un comando y devuelve los tokens ya validados junto a las lineas crudas. */
async function ask(link, command) {
    const lines = await link.command(command);
    return { tokens: assertOk(lines), lines };
}

function weightOrFail(tokens, command) {
    const weight = parseWeight(tokens);
    if (!weight) {
        throw new ScaleError('protocol', `${command} no devolvio un peso`, { tokens });
    }
    return toGrams(weight.value, weight.unit);
}

const driver = {
    id: 'mettler_toledo',
    label: 'Mettler Toledo (MT-SICS)',
    defaultPort: 4305,
    framing: { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 },

    // Garantizadas por MT-SICS en cualquier equipo de la familia.
    capabilities: ['weigh', 'tare', 'clearTare', 'zero', 'info', 'display', 'displayClear'],

    // Existen en el protocolo pero dependen del equipo: DS necesita zumbador y
    // SNS mas de una plataforma. Si el equipo no las tiene contesta ES, que
    // mt-sics-protocol traduce a not_supported.
    deviceDependent: ['beep', 'selectPlatform'],

    models: {},

    async weigh(link) {
        // MT-SICS no da neto, tara y bruto en una trama: hacen falta dos comandos
        // y el bruto se calcula. Bizerba si lo da de golpe; /scale/weigh esconde
        // esa diferencia, que es el motivo de normalizar.
        // Validar el peso de S ANTES de pedir TA. Si se esperan las dos respuestas
        // y luego se validan, un S malformado seguido de un TA no soportado sale
        // como not_supported en vez de protocol: gana el error del segundo comando
        // y se oculta el defecto real, que estaba en el primero.
        const net = await ask(link, 'S');
        const netGrams = weightOrFail(net.tokens, 'S');

        const tare = await ask(link, 'TA');
        const tareGrams = weightOrFail(tare.tokens, 'TA');

        return {
            data: {
                net: netGrams,
                tare: tareGrams,
                gross: { value: Number((netGrams.value + tareGrams.value).toFixed(4)), unit: 'g' },
                stable: isStable(net.tokens),
            },
            raw: [...net.lines, ...tare.lines],
        };
    },

    async tare(link) {
        const { tokens, lines } = await ask(link, 'T');
        return { data: { tare: weightOrFail(tokens, 'T') }, raw: lines };
    },

    async clearTare(link) {
        const { lines } = await ask(link, 'TAC');
        return { data: {}, raw: lines };
    },

    async zero(link) {
        const { lines } = await ask(link, 'Z');
        return { data: {}, raw: lines };
    },

    async info(link) {
        const model = await ask(link, 'I2');
        const serial = await ask(link, 'I4');

        // I2 devuelve "MODELO capacidad unidad" en un solo campo entrecomillado.
        const raw = model.tokens[2] || '';
        const split = raw.split(/\s+/);
        return {
            data: {
                model: split[0] || null,
                capacity: split.slice(1).join(' ') || null,
                serial: serial.tokens[2] || null,
            },
            raw: [...model.lines, ...serial.lines],
        };
    },

    async selectPlatform(link, { platform } = {}) {
        const number = Number(platform);
        if (number !== 1 && number !== 2) {
            throw new ScaleError('protocol', 'platform debe ser 1 o 2', { platform });
        }
        const { lines } = await ask(link, `SNS ${number}`);
        return { data: { platform: number }, raw: lines };
    },

    async display(link, { text } = {}) {
        // Las comillas dobles delimitan el argumento y \r\n delimita la trama:
        // ninguno de los dos puede sobrevivir dentro del texto, o el argumento
        // se convierte en un vector para inyectar comandos MT-SICS adicionales
        // (incluidos destructivos como RST o C2). Se limpia antes de validar,
        // para que un texto que solo contenia esos caracteres cuente como vacio.
        // eslint-disable-next-line no-control-regex
        const clean = String(text ?? '').replace(/["\x00-\x1F\x7F]/g, '');
        if (!clean.trim()) {
            throw new ScaleError('protocol', 'text es obligatorio para display');
        }
        const { lines } = await ask(link, `D "${clean}"`);
        return { data: {}, raw: lines };
    },

    async displayClear(link) {
        const { lines } = await ask(link, 'DW');
        return { data: {}, raw: lines };
    },

    async beep(link) {
        const { lines } = await ask(link, 'DS');
        return { data: {}, raw: lines };
    },
};

module.exports = driver;
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/mettler-toledo.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Verificar contra la báscula real**

Hay una ICS425-BW en `192.168.0.86:4305`. Este script comprueba lo que ninguna báscula falsa puede decir: si ese equipo concreto tiene zumbador y si acepta `SNS`.

```bash
node -e '
const driver = require("./src/scales/drivers/mettler-toledo");
const { TcpLink } = require("./src/scales/transport");
(async () => {
  const link = new TcpLink({ host: "192.168.0.86", port: 4305, framing: driver.framing });
  await link.connect();
  for (const op of ["info", "weigh", "beep", "displayClear"]) {
    try {
      const r = await driver[op](link);
      console.log(op, "OK", JSON.stringify(r.data));
    } catch (e) {
      console.log(op, "->", e.code, e.message);
    }
  }
  try {
    await driver.selectPlatform(link, { platform: 1 });
    console.log("selectPlatform OK");
  } catch (e) { console.log("selectPlatform ->", e.code); }
  link.close();
})();'
```

Expected: `info` devuelve `ICS425-BW` / `3.0045 kg` / `C614409345`, y `weigh` un peso en gramos. `beep` y `selectPlatform` pueden dar `not_supported`: es información, no un fallo. **Anotar el resultado en el commit** — es el único sitio donde queda registrado qué sabe hacer ese equipo.

- [ ] **Step 6: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 85 tests.

- [ ] **Step 7: Commit**

```bash
git add src/scales/drivers/mettler-toledo.js test/scales/mettler-toledo.test.js
git commit -m "feat: add Mettler Toledo MT-SICS driver

Atomic operations only; guided weighing comes next. Weight needs two
commands (S and TA) with gross computed, unlike Bizerba which answers all
three in one telegram — normalising here is what hides that from the SGA.

Verified against the ICS425-BW at 192.168.0.86:4305."
```

---

### Task 9: guidedWeigh, la pesada guiada

La mejora que motiva el trabajo: texto en el display, pitido y pesada en una sola llamada y una sola conexión. El requisito que no se puede fallar es el `DW` en el `finally`: sin él una báscula se queda con el texto puesto cuando algo se corta a mitad, y el operario ve un display congelado sin saber por qué.

**Files:**
- Modify: `src/scales/drivers/mettler-toledo.js` (añadir `guidedWeigh` y declararla en `capabilities`)
- Modify: `test/scales/mettler-toledo.test.js` (añadir los tests al final)

**Interfaces:**
- Consumes: `weigh`, `display`, `displayClear`, `beep` del propio driver.
- Produces: `guidedWeigh(link, {text, beep, waitStable, timeoutMs}) → {data, raw}`. `data` es el de `weigh` más `displayRestored: boolean`. Por defecto `waitStable: true`, `timeoutMs: 10000`, `beep: false`.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir al final de `test/scales/mettler-toledo.test.js`:

```js
test('guidedWeigh declara la capacidad como garantizada', () => {
    assert.ok(driver.capabilities.includes('guidedWeigh'));
});

test('guidedWeigh hace la secuencia completa D, DS, S, TA, DW', async () => {
    const result = await withScale({
        D: 'D A', DS: 'DS A', S: 'S S 2.500 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'PESAR BIDON 3', beep: true });
        assert.deepEqual(scale.received, ['D "PESAR BIDON 3"', 'DS', 'S', 'TA', 'DW']);
        return res;
    });
    assert.deepEqual(result.data.net, { value: 2500, unit: 'g' });
    assert.equal(result.data.stable, true);
    assert.equal(result.data.displayRestored, true);
});

test('guidedWeigh sin texto no envia D', async () => {
    await withScale({
        S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, {});
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    });
});

test('guidedWeigh sin beep no envia DS', async () => {
    await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, { text: 'HOLA', beep: false });
        assert.deepEqual(scale.received, ['D "HOLA"', 'S', 'TA', 'DW']);
    });
});

test('guidedWeigh sigue adelante si el equipo no tiene zumbador', async () => {
    // DS no esta en la tabla, asi que la bascula falsa contesta ES.
    const result = await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'HOLA', beep: true });
        assert.deepEqual(scale.received, ['D "HOLA"', 'DS', 'S', 'TA', 'DW']);
        return res;
    });
    // Un pitido que no suena no es razon para no dar la pesada.
    assert.deepEqual(result.data.net, { value: 1000, unit: 'g' });
    assert.ok(result.raw.some((line) => line === 'ES'), 'el ES deberia quedar en raw');
});

test('guidedWeigh usa SI cuando waitStable es false', async () => {
    await withScale({
        SI: 'SI D 0.900 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { waitStable: false });
        assert.deepEqual(scale.received, ['SI', 'TA', 'DW']);
        assert.equal(res.data.stable, false);
    });
});

test('guidedWeigh restaura el display aunque la pesada falle', async () => {
    const scale = await createLineScale({ D: 'D A', S: 'S +', DW: 'DW A' });
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        await assert.rejects(
            () => driver.guidedWeigh(link, { text: 'PESAR' }),
            (err) => {
                assert.equal(err.code, 'overload');
                return true;
            },
        );
        // Esto es lo importante: el display no se queda con el texto puesto.
        assert.ok(scale.received.includes('DW'), 'deberia haber enviado DW pese al fallo');
    } finally {
        link.close();
        await scale.close();
    }
});

test('guidedWeigh no enmascara el error original si tambien falla el DW', async () => {
    const scale = await createLineScale({ D: 'D A', S: 'S +' });  // DW contesta ES
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        await assert.rejects(
            () => driver.guidedWeigh(link, { text: 'PESAR' }),
            (err) => {
                assert.equal(err.code, 'overload', 'debe ganar el error de la pesada');
                return true;
            },
        );
    } finally {
        link.close();
        await scale.close();
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/mettler-toledo.test.js`
Expected: FAIL — `driver.guidedWeigh is not a function`

- [ ] **Step 3: Añadir `guidedWeigh` al driver**

En `src/scales/drivers/mettler-toledo.js`, añadir `'guidedWeigh'` al final del array `capabilities`:

```js
    capabilities: ['weigh', 'tare', 'clearTare', 'zero', 'info', 'display', 'displayClear', 'guidedWeigh'],
```

Y añadir el método, después de `weigh`:

```js
    /**
     * Texto en el display, pitido y pesada sobre una sola conexion.
     *
     * El display se restaura SIEMPRE en el finally. Sin eso, una bascula se queda
     * con el texto puesto y sin mostrar el peso cuando algo se corta a mitad, y el
     * operario ve un display congelado sin saber por que.
     */
    async guidedWeigh(link, { text, beep = false, waitStable = true, timeoutMs = 10000 } = {}) {
        const raw = [];
        let weighed = null;
        let failure = null;

        try {
            if (text) {
                const shown = await this.display(link, { text });
                raw.push(...shown.raw);
            }

            if (beep) {
                try {
                    const beeped = await this.beep(link);
                    raw.push(...beeped.raw);
                } catch (err) {
                    // Un pitido que no suena no es razon para no dar la pesada.
                    if (err.code !== 'not_supported') throw err;
                    if (err.detail?.response) raw.push(err.detail.response);
                }
            }

            const command = waitStable ? 'S' : 'SI';
            const net = await ask(link, command, { totalMs: timeoutMs });
            const tare = await ask(link, 'TA');

            const netGrams = weightOrFail(net.tokens, command);
            const tareGrams = weightOrFail(tare.tokens, 'TA');
            raw.push(...net.lines, ...tare.lines);

            weighed = {
                net: netGrams,
                tare: tareGrams,
                gross: { value: Number((netGrams.value + tareGrams.value).toFixed(4)), unit: 'g' },
                stable: isStable(net.tokens),
            };
        } catch (err) {
            failure = err;
        }

        // Restaurar el display va aqui y no en un finally: finally corre DESPUES de
        // evaluar el return, asi que displayRestored saldria a true sin que el DW
        // hubiese ocurrido todavia. Este orden lo hace honesto.
        let displayRestored = false;
        try {
            const cleared = await this.displayClear(link);
            raw.push(...cleared.raw);
            displayRestored = true;
        } catch {
            // Se ignora a proposito: si el DW falla, el error que importa es el de
            // la pesada, y relanzar aqui lo enmascararia.
        }

        if (failure) throw failure;

        return { data: { ...weighed, displayRestored }, raw };
    },
```

`ask` necesita aceptar opciones de tiempo para que `timeoutMs` llegue al transporte. Cambiar su firma:

```js
async function ask(link, command, options = {}) {
    const lines = await link.command(command, options);
    return { tokens: assertOk(lines), lines };
}
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/mettler-toledo.test.js`
Expected: PASS, 27 tests.

- [ ] **Step 5: Verificar contra la báscula real**

```bash
node -e '
const driver = require("./src/scales/drivers/mettler-toledo");
const { TcpLink } = require("./src/scales/transport");
(async () => {
  const link = new TcpLink({ host: "192.168.0.86", port: 4305, framing: driver.framing });
  await link.connect();
  const r = await driver.guidedWeigh(link, { text: "PESAR BIDON 3", beep: true });
  console.log(JSON.stringify(r, null, 2));
  link.close();
})();'
```

Expected: el display de la báscula muestra `PESAR BIDON 3`, suena el pitido si el equipo tiene zumbador, devuelve la pesada, y **el display vuelve a mostrar el peso** al terminar. Esto último se comprueba mirando el equipo, no la salida.

- [ ] **Step 6: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 93 tests.

- [ ] **Step 7: Commit**

```bash
git add src/scales/drivers/mettler-toledo.js test/scales/mettler-toledo.test.js
git commit -m "feat: add guided weighing to the Mettler driver

Text, beep and weight over one connection. DW runs in a finally so the
display never stays stuck on the prompt when something breaks halfway,
and a failing DW does not mask the original error. A missing buzzer
degrades instead of aborting: the ES lands in raw and the weight is
still returned."
```

---

### Task 10: Driver Bizerba

Cinco operaciones reales con las tramas que ya funcionan en producción, cuatro sin implementar porque no hay documentación BCP y no se inventan tramas. El prefijo de direccionamiento deja de estar cableado.

**Files:**
- Create: `src/scales/drivers/bizerba.js`
- Create: `test/scales/bizerba.test.js`

**Interfaces:**
- Consumes: `ScaleError` y `toGrams` de Task 4.
- Produces: driver con `id: 'bizerba'`, `capabilities: ['weigh','tare','clearTare','info','selectPlatform']`, `deviceDependent: []`. Mismas firmas que el driver Mettler. Además `buildTelegram(body, options) → string`, exportada para poder probar el prefijo.

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scales/bizerba.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/bizerba');
const { buildTelegram } = require('../../src/scales/drivers/bizerba');
const { TcpLink } = require('../../src/scales/transport');
const { createLineScale } = require('../helpers/fake-scale');

const ETX = '\x03';

async function withScale(table, fn, options) {
    const scale = await createLineScale(table);
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        return await fn(link, scale);
    } finally {
        link.close();
        await scale.close();
    }
}

test('el driver se identifica con el id que usa el SGA', () => {
    assert.equal(driver.id, 'bizerba');
    assert.equal(driver.defaultPort, 10051);
});

test('no declara zero, display, beep ni guidedWeigh', () => {
    const all = [...driver.capabilities, ...driver.deviceDependent];
    for (const op of ['zero', 'display', 'displayClear', 'beep', 'guidedWeigh']) {
        assert.ok(!all.includes(op), `${op} no deberia estar declarada`);
    }
});

test('buildTelegram usa el prefijo de produccion por defecto', () => {
    assert.equal(buildTelegram('I!GX05'), `0${ETX}254${ETX}001${ETX}I!GX05`);
});

test('buildTelegram acepta un prefijo distinto sin tocar el cuerpo', () => {
    assert.equal(
        buildTelegram('I!GX05', { addressPrefix: ['1', '200', '002'] }),
        `1${ETX}200${ETX}002${ETX}I!GX05`,
    );
});

test('buildTelegram rechaza un prefijo que no tiene tres campos', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', '254'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('weigh envia la trama de pesos y devuelve neto, tara y bruto en gramos', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        // La bascula falsa indexa por el primer token, que aqui es la trama entera.
        [`0${ETX}254${ETX}001${ETX}${body}`]: `I!LV01|GD01|kg;-3;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02`,
    }, async (link, scale) => {
        const res = await driver.weigh(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}${body}`]);
        return res;
    });

    assert.deepEqual(result.data.net, { value: 1234, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 50, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 1284, unit: 'g' });
});

test('weigh de una bascula vacia da ceros, con la trama real capturada', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));

    assert.deepEqual(result.data.net, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 0, unit: 'g' });
});

test('weigh marca stable true: la trama de pesos solo llega con peso asentado', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, true);
});

test('weigh salta los tripletes mal formados y deja el campo a null', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3|GD02|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.net, null);
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.equal(result.data.gross, null);
});

test('weigh sin respuesta es timeout', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    await assert.rejects(
        () => withScale({ [`0${ETX}254${ETX}001${ETX}${body}`]: null }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'timeout');
            return true;
        },
    );
});

test('tare envia I!GX05', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX05`]: 'I!GX05 OK',
    }, async (link, scale) => {
        await driver.tare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX05`]);
    });
});

test('clearTare envia I!GX06', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX06`]: 'I!GX06 OK',
    }, async (link, scale) => {
        await driver.clearTare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX06`]);
    });
});

test('info envia I?GV05|LX02 y devuelve la respuesta cruda', async () => {
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}I?GV05|LX02`]: 'I!GV05|1.23|LX02',
    }, (link) => driver.info(link));
    assert.deepEqual(result.raw, ['I!GV05|1.23|LX02']);
    // Sin documentacion BCP no se descompone en modelo y serie: se entrega crudo.
    assert.equal(result.data.model, null);
    assert.equal(result.data.raw_info, 'I!GV05|1.23|LX02');
});

test('selectPlatform 1 y 2 envian sus tramas', async () => {
    for (const platform of [1, 2]) {
        const body = `I!LV01|GW01|${platform}|LX02`;
        await withScale({
            [`0${ETX}254${ETX}001${ETX}${body}`]: 'OK',
        }, async (link, scale) => {
            const res = await driver.selectPlatform(link, { platform });
            assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}${body}`]);
            assert.equal(res.data.platform, platform);
        });
    }
});

test('selectPlatform rechaza un numero que no es 1 ni 2', async () => {
    await assert.rejects(
        () => withScale({}, (link) => driver.selectPlatform(link, { platform: 3 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('un prefijo por options cambia las seis tramas', async () => {
    const body = 'I!GX05';
    await withScale({
        [`9${ETX}100${ETX}007${ETX}${body}`]: 'OK',
    }, async (link, scale) => {
        await driver.tare(link, { options: { addressPrefix: ['9', '100', '007'] } });
        assert.deepEqual(scale.received, [`9${ETX}100${ETX}007${ETX}${body}`]);
    });
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scales/bizerba.test.js`
Expected: FAIL — `Cannot find module '../../src/scales/drivers/bizerba'`

- [ ] **Step 3: Implementar el driver**

```js
// src/scales/drivers/bizerba.js
const { ScaleError } = require('../errors');
const { toGrams } = require('../units');

const ETX = '\x03';

// Direccionamiento del equipo. Estos son los valores que funcionan hoy en
// produccion. El significado exacto de los tres campos (emisor, receptor,
// subdireccion u otra combinacion) no esta confirmado porque no hay documentacion
// BCP a mano; se dejan como tres tokens y se les pondra nombre cuando la haya.
const DEFAULT_ADDRESS_PREFIX = ['0', '254', '001'];

// Cuerpos de las seis tramas, tal como estaban en ScaleController del SGA.
const TELEGRAMS = Object.freeze({
    info: 'I?GV05|LX02',
    tare: 'I!GX05',
    clearTare: 'I!GX06',
    weigh: 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02',
    platform: (n) => `I!LV01|GW01|${n}|LX02`,
});

// Campo de la respuesta -> clave de peso.
const FIELD_MAP = Object.freeze({ GD01: 'net', GD02: 'tare', GD07: 'gross' });

function buildTelegram(body, options = {}) {
    const prefix = options.addressPrefix || DEFAULT_ADDRESS_PREFIX;
    if (!Array.isArray(prefix) || prefix.length !== 3) {
        throw new ScaleError('protocol', 'addressPrefix debe tener exactamente tres campos', { addressPrefix: prefix });
    }
    return `${prefix.join(ETX)}${ETX}${body}`;
}

async function ask(link, body, options) {
    const lines = await link.command(buildTelegram(body, options));
    if (lines.length === 0) {
        throw new ScaleError('timeout', 'la bascula no contesto');
    }
    return lines;
}

/**
 * Extrae neto, tara y bruto de una respuesta tipo
 * `I!LV01|GD01|kg;-3;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02`.
 *
 * Cada campo se contesta con un triplete `unidad;exponente;valor`: la magnitud
 * real es valor * 10^exponente en la unidad indicada. Un campo ausente o con
 * triplete incompleto queda a null, no a cero: no es lo mismo "pesa cero" que
 * "no me lo ha dicho".
 */
function parseWeights(response) {
    const weights = { net: null, tare: null, gross: null };
    const parts = response.split('|');

    parts.forEach((part, index) => {
        const key = FIELD_MAP[part];
        if (!key || parts[index + 1] === undefined) return;
        const triplet = parts[index + 1].split(';');
        if (triplet.length < 3) return;
        const [unit, exponent, value] = triplet;
        if (!/^[+-]?\d+(\.\d+)?$/.test(value)) return;
        weights[key] = toGrams(Number(value), unit, Number(exponent));
    });

    return weights;
}

const driver = {
    id: 'bizerba',
    label: 'Bizerba (BCP)',
    defaultPort: 10051,
    framing: { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 },

    capabilities: ['weigh', 'tare', 'clearTare', 'info', 'selectPlatform'],

    // Puesta a cero, texto en display y pitido no estan aqui a proposito: no hay
    // documentacion BCP para esas operaciones y no se inventan tramas. El registro
    // hace que respondan 501 sin abrir socket.
    deviceDependent: [],

    // Sin overrides de modelo. El main.js original (037efa7:234) anotaba que las
    // IS30 "suelen usar terminacion \r o \r\n", pero es un comentario dubitativo y
    // \r\n es el valor que funciona hoy en produccion por la ruta heredada. Forzar
    // \r para is30 dejaria muda una bascula que funciona. Un modelo sin override usa
    // la linea base, que es justo lo correcto mientras no haya evidencia mejor.
    models: {},

    async weigh(link, { options } = {}) {
        const lines = await ask(link, TELEGRAMS.weigh, options);
        const weights = parseWeights(lines.join(''));
        return {
            data: {
                ...weights,
                // La trama de pesos solo se contesta con el peso ya asentado, asi
                // que no hay un equivalente al estado dinamico de MT-SICS.
                stable: true,
            },
            raw: lines,
        };
    },

    async tare(link, { options } = {}) {
        return { data: {}, raw: await ask(link, TELEGRAMS.tare, options) };
    },

    async clearTare(link, { options } = {}) {
        return { data: {}, raw: await ask(link, TELEGRAMS.clearTare, options) };
    },

    async info(link, { options } = {}) {
        const lines = await ask(link, TELEGRAMS.info, options);
        return {
            data: {
                model: null,
                capacity: null,
                serial: null,
                // Sin documentacion BCP no se descompone: se entrega crudo y que
                // decida quien sepa leerlo.
                raw_info: lines.join(''),
            },
            raw: lines,
        };
    },

    async selectPlatform(link, { platform, options } = {}) {
        const number = Number(platform);
        if (number !== 1 && number !== 2) {
            throw new ScaleError('protocol', 'platform debe ser 1 o 2', { platform });
        }
        const lines = await ask(link, TELEGRAMS.platform(number), options);
        return { data: { platform: number }, raw: lines };
    },
};

module.exports = driver;
module.exports.buildTelegram = buildTelegram;
module.exports.parseWeights = parseWeights;
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/scales/bizerba.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 109 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scales/drivers/bizerba.js test/scales/bizerba.test.js
git commit -m "feat: add Bizerba BCP driver

Five real operations with the telegrams already working in production.
Zero, display and beep are deliberately absent: there is no BCP
documentation for them and inventing telegrams would produce silent
failures. The address prefix is no longer hardcoded.

Covered by recorded frames only — there is no Bizerba on the test bench,
so this needs validation against real hardware before production."
```

---

### Task 11: Rutas `/scale/*`, `/health` y cableado en main.js

Las rutas se montan recorriendo `OPERATIONS`, no escribiéndolas a mano. Así añadir una operación es tocar la lista y los drivers, y no queda una segunda lista de endpoints que se desincronice.

**Files:**
- Create: `src/scales/index.js`
- Create: `src/server/scale-routes.js`
- Create: `test/scale-routes.test.js`
- Modify: `main.js` (require y llamada a `registerScaleRoutes`)

**Interfaces:**
- Consumes: `createRegistry`, `OPERATIONS`, `routePathFor` de Task 6; los dos drivers de Tasks 8-10; `TcpLink` de Task 5; `httpStatusFor` de Task 4.
- Produces:
  - `src/scales/index.js` → `{registry, OPERATIONS, routePathFor}` con los drivers reales ya registrados.
  - `registerScaleRoutes(expressApp, logger, {version}) → void`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
// test/scale-routes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerScaleRoutes } = require('../src/server/scale-routes');
const { createLineScale } = require('./helpers/fake-scale');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

async function startApp() {
    const app = express();
    app.use(express.json());
    registerScaleRoutes(app, silentLogger, { version: '1.3.0' });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}

function post(base, path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('GET /health anuncia version y APIs disponibles', async () => {
    const app = await startApp();
    try {
        const res = await fetch(`${app.base}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.version, '1.3.0');
        assert.deepEqual(body.apis, ['legacy', 'scale-v1']);
        assert.deepEqual(body.brands.sort(), ['bizerba', 'mettler_toledo']);
    } finally {
        await app.close();
    }
});

test('GET /scale/brands devuelve el catalogo con capacidades y modelos', async () => {
    const app = await startApp();
    try {
        const body = await (await fetch(`${app.base}/scale/brands`)).json();
        const mettler = body.brands.find((b) => b.id === 'mettler_toledo');
        assert.equal(mettler.defaultPort, 4305);
        assert.ok(mettler.capabilities.includes('guidedWeigh'));
        assert.deepEqual(mettler.deviceDependent.sort(), ['beep', 'selectPlatform']);

        const bizerba = body.brands.find((b) => b.id === 'bizerba');
        assert.equal(bizerba.defaultPort, 10051);
        assert.ok(!bizerba.capabilities.includes('zero'));
        // Ningun driver declara overrides de modelo hoy: el catalogo de modelos del
        // SGA es a proposito mas amplio que esta tabla, que solo lista lo que se
        // desvia del protocolo base.
        assert.deepEqual(bizerba.models, []);
    } finally {
        await app.close();
    }
});

test('faltar ip, port o brand es 400', async () => {
    const app = await startApp();
    try {
        for (const body of [
            { port: 4305, brand: 'mettler_toledo' },
            { ip: '127.0.0.1', brand: 'mettler_toledo' },
            { ip: '127.0.0.1', port: 4305 },
        ]) {
            const res = await post(app.base, '/scale/weigh', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.equal((await res.json()).success, false);
        }
    } finally {
        await app.close();
    }
});

test('una marca desconocida es 400 unknown_brand con la lista valida', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: 4305, brand: 'acme',
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.code, 'unknown_brand');
        assert.deepEqual(body.error.detail.validBrands.sort(), ['bizerba', 'mettler_toledo']);
    } finally {
        await app.close();
    }
});

test('una operacion que la marca no soporta es 501 sin abrir socket', async () => {
    const app = await startApp();
    try {
        // Puerto 1 esta cerrado: si respondiera 502 significaria que intento conectar.
        for (const op of ['zero', 'display', 'beep', 'guided-weigh']) {
            const res = await post(app.base, `/scale/${op}`, {
                ip: '127.0.0.1', port: 1, brand: 'bizerba', text: 'X',
            });
            assert.equal(res.status, 501, `${op} deberia ser 501`);
            const body = await res.json();
            assert.equal(body.error.code, 'not_supported');
            assert.equal(body.brand, 'bizerba');
        }
    } finally {
        await app.close();
    }
});

test('weigh devuelve el sobre normalizado con data y raw', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg', TA: 'TA A 0.050 kg' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.brand, 'mettler_toledo');
        assert.equal(body.op, 'weigh');
        assert.deepEqual(body.data.net, { value: 1234, unit: 'g' });
        assert.deepEqual(body.data.gross, { value: 1284, unit: 'g' });
        assert.equal(body.data.stable, true);
        assert.deepEqual(body.raw, ['S S 1.234 kg', 'TA A 0.050 kg']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('un puerto cerrado es 502 connect', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: 1, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 502);
        assert.equal((await res.json()).error.code, 'connect');
    } finally {
        await app.close();
    }
});

test('una bascula muda es 504 timeout', async () => {
    const scale = await createLineScale({ S: null });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 504);
        assert.equal((await res.json()).error.code, 'timeout');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('un ES del equipo llega como 501, no como 500', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });  // DS contesta ES
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/beep', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 501);
        assert.equal((await res.json()).error.code, 'not_supported');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('display pasa el texto al driver', async () => {
    const scale = await createLineScale({ D: 'D A' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/display', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', text: 'HOLA',
        });
        assert.equal(res.status, 200);
        assert.deepEqual(scale.received, ['D "HOLA"']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('select-platform pasa el numero al driver', async () => {
    const scale = await createLineScale({ SNS: 'SNS A 2' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/select-platform', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', platform: 2,
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).data.platform, 2);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('el model se propaga a la respuesta y no rompe la operacion', async () => {
    // Ningun driver declara overrides de modelo hoy (ver el comentario de models
    // en bizerba.js), asi que un model cualquiera debe caer a la linea base y
    // funcionar igual. Lo que se comprueba aqui es que el model viaja de vuelta,
    // que es lo que el SGA necesita para saber con que configuracion se hablo.
    const scale = await createLineScale({ [`0\x03254\x03001\x03I!GX05`]: 'OK' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/tare', {
            ip: '127.0.0.1', port: scale.port, brand: 'bizerba', model: 'is30',
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).model, 'is30');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('un model sin override funciona con la linea base', async () => {
    const scale = await createLineScale({ S: 'S S 1.000 kg', TA: 'TA A 0.000 kg' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', model: 'ics425',
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).model, 'ics425');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('guided-weigh funciona de punta a punta y restaura el display', async () => {
    const scale = await createLineScale({
        D: 'D A', DS: 'DS A', S: 'S S 2.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/guided-weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
            text: 'PESAR', beep: true,
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data.net, { value: 2000, unit: 'g' });
        assert.equal(body.data.displayRestored, true);
        assert.deepEqual(scale.received, ['D "PESAR"', 'DS', 'S', 'TA', 'DW']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('todas las operaciones del registro tienen ruta montada', async () => {
    const { OPERATIONS, routePathFor } = require('../src/scales');
    const app = await startApp();
    try {
        for (const op of OPERATIONS) {
            const res = await post(app.base, `/scale/${routePathFor(op)}`, {});
            assert.notEqual(res.status, 404, `${op} no tiene ruta`);
        }
    } finally {
        await app.close();
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/scale-routes.test.js`
Expected: FAIL — `Cannot find module '../src/server/scale-routes'`

- [ ] **Step 3: Crear el registro con los drivers reales**

```js
// src/scales/index.js
const { createRegistry, OPERATIONS, routePathFor } = require('./registry');
const mettlerToledo = require('./drivers/mettler-toledo');
const bizerba = require('./drivers/bizerba');

// Anadir una marca es anadir su driver a esta lista. Las rutas se montan
// recorriendo OPERATIONS, asi que no hay nada mas que tocar.
const registry = createRegistry([mettlerToledo, bizerba]);

module.exports = { registry, OPERATIONS, routePathFor };
```

- [ ] **Step 4: Implementar las rutas**

```js
// src/server/scale-routes.js
const { registry, OPERATIONS, routePathFor } = require('../scales');
const { TcpLink } = require('../scales/transport');
const { ScaleError, httpStatusFor } = require('../scales/errors');

function fail(res, { brand = null, model = null, op, error }) {
    const code = error instanceof ScaleError ? error.code : 'protocol';
    return res.status(httpStatusFor(code)).json({
        success: false,
        brand,
        model,
        op,
        error: {
            code,
            message: error.message,
            detail: error instanceof ScaleError ? error.detail : null,
        },
    });
}

async function runOperation(operation, req, res, logger) {
    const { ip, port, brand, model = null } = req.body || {};

    if (!ip || !port || !brand) {
        return res.status(400).json({
            success: false,
            brand: brand || null,
            model,
            op: operation,
            error: {
                // missing_params, no unknown_brand: "no me has mandado ip" no es
                // "esa marca no existe", y el SGA ramifica sobre este codigo.
                code: 'missing_params',
                message: 'Faltan parámetros requeridos: ip, port, brand',
                detail: null,
            },
        });
    }

    let driver;
    try {
        driver = registry.resolveDriver(brand, model);
    } catch (error) {
        return fail(res, { brand, model, op: operation, error });
    }

    // Se comprueba antes de tocar la red: una operacion que la marca no tiene no
    // merece ni abrir un socket.
    if (!registry.allOperations(driver).includes(operation)) {
        return fail(res, {
            brand, model, op: operation,
            error: new ScaleError(
                'not_supported',
                `${brand} no soporta la operación ${operation}`,
                { brand, model, operation, supported: registry.allOperations(driver) },
            ),
        });
    }

    const link = new TcpLink({ host: ip, port: Number(port), framing: driver.framing });
    try {
        await link.connect();
        logger.info(`⚖️ [${operation}] ${brand}${model ? `/${model}` : ''} en ${ip}:${port}`);
        const result = await driver[operation](link, req.body);
        return res.json({
            success: true,
            brand,
            model,
            op: operation,
            data: result.data,
            raw: result.raw,
        });
    } catch (error) {
        logger.warn(`⚠️ [${operation}] ${error.code || 'error'}: ${error.message}`);
        return fail(res, { brand, model, op: operation, error });
    } finally {
        link.close();
    }
}

function registerScaleRoutes(expressApp, logger, { version }) {
    expressApp.get('/health', (req, res) => {
        res.json({
            version,
            apis: ['legacy', 'scale-v1'],
            brands: registry.listBrands().map((b) => b.id),
        });
    });

    expressApp.get('/scale/brands', (req, res) => {
        res.json({ brands: registry.listBrands() });
    });

    // Una ruta por operacion, derivada del registro. No hay una segunda lista de
    // endpoints que pueda desincronizarse de OPERATIONS.
    for (const operation of OPERATIONS) {
        expressApp.post(`/scale/${routePathFor(operation)}`, (req, res) => {
            runOperation(operation, req, res, logger).catch((error) => {
                logger.error(`❌ [${operation}] excepción no controlada: ${error.message}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false, op: operation,
                        error: { code: 'protocol', message: error.message, detail: null },
                    });
                }
            });
        });
    }
}

module.exports = { registerScaleRoutes };
```

- [ ] **Step 5: Ejecutar y verificar que pasan**

Run: `node --test test/scale-routes.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 6: Cablear en main.js**

Añadir el require junto al de `legacy-routes`:

```js
const { registerScaleRoutes } = require("./src/server/scale-routes");
```

Y dentro de `setupServer()`, justo después de la llamada a `registerLegacyRoutes`:

```js
    registerScaleRoutes(expressApp, logger, { version: app.getVersion() });
```

- [ ] **Step 7: Verificar la app arrancada contra la báscula real**

Run: `npm start`, y con la app levantada:

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/scale/brands
curl -s -X POST http://localhost:3000/scale/weigh \
  -H 'Content-Type: application/json' \
  -d '{"ip":"192.168.0.86","port":4305,"brand":"mettler_toledo"}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/scale/zero \
  -H 'Content-Type: application/json' \
  -d '{"ip":"192.168.0.86","port":10051,"brand":"bizerba"}'
```

Expected: `/health` da la versión de `package.json`; `weigh` da un peso en gramos de la ICS425; el último `curl` da `501`.

- [ ] **Step 8: Ejecutar la suite completa**

Run: `npm test`
Expected: PASS, 124 tests.

- [ ] **Step 9: Commit**

```bash
git add main.js src/scales/index.js src/server/scale-routes.js test/scale-routes.test.js
git commit -m "feat: expose normalised /scale/* API and /health

Routes are mounted by walking OPERATIONS, so there is no second list of
endpoints to drift out of sync. Unsupported operations answer 501 without
opening a socket. /health is the cheap probe the SGA uses to tell whether
this desktop app understands the new API — an old build 404s, and that
404 is the signal."
```

---

### Task 12: Documentar la API en el README

El README es lo que lee quien integre desde el SGA. Ahora mismo documenta `/scale-command` y `/scale-hex` y no menciona nada de lo nuevo.

**Files:**
- Modify: `README.md` (sección `## 🌐 API Endpoints`)

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Añadir la sección de la API nueva**

En `README.md`, después del bloque de `/scale-hex` y antes de `### WebSocket`, insertar:

````markdown
### API de básculas (scale-v1)

Los endpoints `/scale-command` y `/scale-hex` de arriba **siguen funcionando igual** y no van a
cambiar: son la compatibilidad para instalaciones que no han actualizado. Lo nuevo vive bajo
`/scale/*` y conoce el protocolo, así que quien llama no monta tramas.

#### Descubrir qué sabe hacer esta instalación

```bash
GET http://localhost:3000/health
```
```json
{ "version": "1.3.0", "apis": ["legacy", "scale-v1"], "brands": ["mettler_toledo", "bizerba"] }
```

Una versión anterior de VerentiaIP devuelve **404** aquí. Ese 404 es la señal de que solo
soporta los endpoints heredados.

```bash
GET http://localhost:3000/scale/brands
```
Devuelve, por marca: `label`, `defaultPort`, `capabilities` (garantizadas), `deviceDependent`
(existen en el protocolo pero según el equipo) y `models` con override conocido.

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

Los pesos salen **siempre en gramos**. `raw` lleva las líneas tal como las devolvió el equipo,
que es lo único que sirve para depurar una báscula que contesta algo inesperado.

#### Pesada guiada

Muestra un texto, pita y pesa en una sola llamada sobre una sola conexión. El display se
restaura al modo peso al terminar, también si la pesada falla.

```bash
POST http://localhost:3000/scale/guided-weigh
{ "ip": "192.168.0.86", "port": 4305, "brand": "mettler_toledo",
  "text": "PESAR BIDON 3", "beep": true, "waitStable": true, "timeoutMs": 10000 }
```

Si el equipo no tiene zumbador el pitido se omite y la pesada sigue: el `ES` queda anotado en
`raw`.

#### Errores

```json
{ "success": false, "brand": "bizerba", "op": "zero",
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

`not_supported` llega por dos vías indistinguibles a propósito: el driver no declara la
operación, o el equipo contestó `ES` (en MT-SICS, "no reconozco este comando"). Una ICS sin
zumbador da 501 en `/scale/beep` sin configurar nada.

#### Opciones por instalación

`options.addressPrefix` cambia el direccionamiento de las tramas Bizerba, que por defecto es
`["0", "254", "001"]`.

```json
{ "ip": "10.32.230.18", "port": 10051, "brand": "bizerba",
  "options": { "addressPrefix": ["1", "200", "002"] } }
```
````

- [ ] **Step 2: Actualizar la lista de características**

En la lista `## 📋 Características Principales`, añadir tras la línea de la API REST:

```markdown
- ⚖️ **Básculas Mettler Toledo y Bizerba**: API normalizada `/scale/*` con pesada guiada
```

- [ ] **Step 3: Actualizar la estructura del proyecto**

En el bloque `## 🏗️ Estructura del Proyecto`, sustituir la línea de `main.js` por:

```
├── main.js              # Proceso principal de Electron
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
```

- [ ] **Step 4: Verificar que la suite sigue verde**

Run: `npm test`
Expected: PASS, 124 tests.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the scale-v1 API

Covers the /health probe an integrator needs to tell old builds from new,
the per-brand support matrix, the error code table, and why not_supported
arrives from two indistinguishable paths."
```

---

## Verificación final del plan

- [ ] `npm test` pasa entero (124 tests).
- [ ] `npm start` arranca sin errores y el tray aparece.
- [ ] Los 8 tests de `test/legacy-routes.test.js` **no se han modificado** desde Task 2.
  Comprobar: `git log --oneline -- test/legacy-routes.test.js` debe mostrar un solo commit.
- [ ] Contra la ICS425-BW real: `/scale/info`, `/scale/weigh`, `/scale/tare`, `/scale/zero`,
  `/scale/display`, `/scale/display-clear` y `/scale/guided-weigh` responden 200.
- [ ] Queda anotado en algún commit qué contestan `/scale/beep` y `/scale/select-platform` en
  ese equipo concreto.
- [ ] `grep -rn "electron" src/scales/` no devuelve nada: los drivers son importables sin Electron.
- [ ] Subir la versión en `package.json` a `1.3.0` antes de `npm run make`.

**Pendiente que no se puede cerrar aquí:** el driver Bizerba solo está cubierto por tramas
grabadas. El puerto 10051 del banco de pruebas está cerrado y no hay Bizerba física. Hace falta
validarlo contra hierro real antes de dar por bueno el paso a producción.
