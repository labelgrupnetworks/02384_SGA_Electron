# Elección de interfaz de red en VerentiaIP — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `GET /ip` devuelva la IP de la interfaz que el puesto tiene elegida, preguntando solo cuando la elección es genuinamente ambigua y recordándola después.

**Architecture:** Cuatro módulos con una responsabilidad cada uno y sin dependencia de Electron, para que sean testables: el filtrado de candidatas es una función pura, el almacén recibe su directorio inyectado, la resolución recibe ambos por parámetro, y la ruta se registra sobre una app Express desnuda igual que las de básculas. Solo el diálogo y el tray tocan Electron, y esos se verifican a mano.

**Tech Stack:** Node 24.16, Electron 36, Express 4, `node:test` y `node:assert/strict` (built-in), `node:os`, `node:fs`.

## Global Constraints

- **Repo:** `/home/manel/Documentos/02384_SGA_Electron`, rama `feature/mettler-scales`. No crear ramas, no hacer merge, no hacer push.
- **Cero dependencias nuevas.** Solo `node:test`, `node:assert/strict`, `node:os`, `node:fs`, `node:path` y el `express` ya instalado.
- **Código y comentarios SIEMPRE en inglés.** Los mensajes de cara al usuario (diálogo, tray) van en español, como el resto de la interfaz de la app.
- **Ningún módulo nuevo puede requerir `electron`.** `app.getPath('userData')` se inyecta desde `main.js`; los módulos reciben rutas y datos por parámetro. Es lo que permite probarlos con `node --test` sin Electron, que en esta máquina además está limitado.
- **`GET /ip` conserva `{ip}` en el caso con respuesta.** Sus dos consumidores actuales (el `getLocalIpFromElectron()` del SGA y `components/ip-detector.blade.php`) leen ese campo y no deben romperse.
- **No tocar `src/server/legacy-routes.js` ni `test/legacy-routes.test.js`**: superficie de compatibilidad congelada, verificada byte a byte.
- Tests: `npm test`. La suite está en **200 tests** al empezar; cualquier tarea debe dejarla verde.
- Spec: `docs/superpowers/specs/2026-08-06-local-ip-selection-design.md`.

## Estado de partida

`main.js` tiene `getIPAddress()` en la línea 179, que recorre todas las interfaces y sobreescribe el
resultado en cada IPv4 no interna, así que gana la última iterada. Sus cuatro puntos de uso:

- `expressApp.get("/ip", ...)` (línea ~204), que responde `{ip: getIPAddress()}`.
- `socket.emit("ip-address", {ip: getIPAddress()})` al conectar (línea ~213).
- El mismo `emit` dentro de `socket.on("get-ip", ...)` (línea ~216).
- La etiqueta `IP actual: ${getIPAddress()}` del menú del tray (línea ~264), que se reconstruye cada 30 s.

`main.js` no persiste nada hoy. Ya existen `src/server/scale-routes.js` y `src/scales/` como patrón de
módulos registrables y testables sin Electron.

En la máquina de desarrollo las interfaces son: `lo` 127.0.0.1 (interna), `enp0s31f6` 192.168.0.47,
`wlp0s20f3` 192.168.0.225 y `lerd0` 192.0.2.1. Hoy `getIPAddress()` devuelve la última, `192.0.2.1`.

---

### Task 1: Filtrado de interfaces candidatas

**Files:**
- Create: `src/network/interfaces.js`
- Create: `test/network/interfaces.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `listCandidateInterfaces(interfaces) → Array<{name: string, address: string}>`. Recibe un mapa con la forma de `os.networkInterfaces()` y devuelve las candidatas en el orden en que aparecen.

- [ ] **Step 1: Escribir el test que falla**

```js
// test/network/interfaces.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { listCandidateInterfaces } = require('../../src/network/interfaces');

function ipv4(address, internal = false) {
    return { address, family: 'IPv4', internal, netmask: '255.255.255.0' };
}

test('drops loopback and other internal addresses', () => {
    const result = listCandidateInterfaces({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [ipv4('192.168.0.47')],
    });

    assert.deepEqual(result, [{ name: 'eth0', address: '192.168.0.47' }]);
});

test('drops anything that is not IPv4', () => {
    const result = listCandidateInterfaces({
        eth0: [
            { address: 'fe80::1', family: 'IPv6', internal: false },
            ipv4('192.168.0.47'),
        ],
    });

    assert.deepEqual(result, [{ name: 'eth0', address: '192.168.0.47' }]);
});

test('drops link-local, which means DHCP failed', () => {
    const result = listCandidateInterfaces({ eth0: [ipv4('169.254.13.7')] });

    assert.deepEqual(result, []);
});

test('drops the RFC 5737 documentation range, where the lerd dummy lives', () => {
    const result = listCandidateInterfaces({ lerd0: [ipv4('192.0.2.1')] });

    assert.deepEqual(result, []);
});

test('drops container bridges in 172.17.0.0/12', () => {
    const result = listCandidateInterfaces({
        docker0: [ipv4('172.17.0.1')],
        br1: [ipv4('172.31.255.254')],
    });

    assert.deepEqual(result, []);
});

test('keeps legitimate private ranges', () => {
    const result = listCandidateInterfaces({
        a: [ipv4('10.1.2.3')],
        b: [ipv4('192.168.1.10')],
        c: [ipv4('172.16.0.5')],
    });

    assert.deepEqual(result, [
        { name: 'a', address: '10.1.2.3' },
        { name: 'b', address: '192.168.1.10' },
        { name: 'c', address: '172.16.0.5' },
    ]);
});

test('172.16.0.0/12 outside the container span is kept', () => {
    // 172.16.x is a legitimate private range; only 172.17-172.31 are excluded as
    // container bridges. This pins the boundary so the check cannot widen by accident.
    assert.deepEqual(
        listCandidateInterfaces({ eth0: [ipv4('172.16.99.1')] }),
        [{ name: 'eth0', address: '172.16.99.1' }],
    );
    assert.deepEqual(listCandidateInterfaces({ eth0: [ipv4('172.17.0.1')] }), []);
});

test('a public address is kept: it is unusual but not impossible', () => {
    assert.deepEqual(
        listCandidateInterfaces({ eth0: [ipv4('81.45.20.3')] }),
        [{ name: 'eth0', address: '81.45.20.3' }],
    );
});

test('an interface with several addresses yields one entry per address', () => {
    const result = listCandidateInterfaces({
        eth0: [ipv4('192.168.0.47'), ipv4('10.0.0.9')],
    });

    assert.deepEqual(result, [
        { name: 'eth0', address: '192.168.0.47' },
        { name: 'eth0', address: '10.0.0.9' },
    ]);
});

test('no interfaces at all yields an empty list', () => {
    assert.deepEqual(listCandidateInterfaces({}), []);
});

test('the real development machine yields exactly the two good interfaces', () => {
    // This is the regression for the bug: getIPAddress() used to return 192.0.2.1
    // from lerd0 because it kept the last non-internal address it iterated.
    const result = listCandidateInterfaces({
        lo: [ipv4('127.0.0.1', true)],
        enp0s31f6: [ipv4('192.168.0.47')],
        wlp0s20f3: [ipv4('192.168.0.225')],
        lerd0: [ipv4('192.0.2.1')],
    });

    assert.deepEqual(result, [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ]);
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/network/interfaces.test.js`
Expected: FAIL — `Cannot find module '../../src/network/interfaces'`

- [ ] **Step 3: Implementar el filtrado**

```js
// src/network/interfaces.js

/**
 * Ranges that can never be a workstation's address on the shop floor.
 *
 * This is a list of exclusions and therefore incomplete by nature: a VPN or a new
 * virtual adapter would still show up as a candidate. That is acceptable, because
 * the consequence is one more question rather than a wrong IP.
 */
function isExcluded(address) {
    // Link-local: DHCP failed, so this is not an address anybody assigned.
    if (address.startsWith('169.254.')) return true;

    // RFC 5737 documentation range. The lerd development environment puts its dummy
    // interface here, which is what made getIPAddress() return 192.0.2.1.
    if (address.startsWith('192.0.2.')) return true;

    // Container bridges, 172.17.0.0/12. Note 172.16.x is NOT excluded: it is a
    // legitimate private range and some installations use it.
    const octets = address.split('.');
    if (octets[0] === '172') {
        const second = Number(octets[1]);
        if (second >= 17 && second <= 31) return true;
    }

    return false;
}

/**
 * The interfaces that could plausibly be this workstation's address.
 *
 * Takes the interface map as an argument rather than calling os.networkInterfaces()
 * itself, so it can be tested against fabricated interfaces without depending on
 * the machine's actual network.
 */
function listCandidateInterfaces(interfaces) {
    const candidates = [];

    for (const [name, addresses] of Object.entries(interfaces || {})) {
        for (const iface of addresses || []) {
            if (iface.family !== 'IPv4') continue;
            if (iface.internal) continue;
            if (isExcluded(iface.address)) continue;
            candidates.push({ name, address: iface.address });
        }
    }

    return candidates;
}

module.exports = { listCandidateInterfaces };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/network/interfaces.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Suite completa**

Run: `npm test`
Expected: 211 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/network/interfaces.js test/network/interfaces.test.js
git commit -m "feat: filter which network interfaces could be the workstation's

Excludes link-local, the RFC 5737 documentation range where lerd's dummy
interface lives, and container bridges in 172.17.0.0/12 — while keeping
172.16.x, which is a legitimate private range.

Takes the interface map as an argument instead of reading it, so the
regression case from the real machine (lo, enp0s31f6, wlp0s20f3, lerd0)
is pinned by a test rather than by whoever happens to run it."
```

---

### Task 2: Almacén de configuración

**Files:**
- Create: `src/config/store.js`
- Create: `test/config/store.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createStore(baseDir, logger = null) → {read(), write(config), path}`. El `logger` es opcional y solo se usa para avisar de un fichero ilegible o corrupto; sin él, el módulo sigue funcionando y callado, que es lo que permite probarlo sin depender de nada.
  - `read()` devuelve el objeto guardado, o `{}` si el fichero no existe, no se puede leer o no es JSON válido. **Nunca lanza.**
  - `write(config)` escribe el objeto como JSON, creando `baseDir` si hace falta.
  - `path` es la ruta completa del fichero, para poder mostrarla en un log.

**Por qué un factory con `baseDir` inyectado:** el directorio real es `app.getPath('userData')`, que solo existe dentro de Electron. Recibirlo por parámetro es lo que permite probar este módulo con un directorio temporal y mantener la regla de que nada bajo test requiere `electron`.

- [ ] **Step 1: Escribir el test que falla**

```js
// test/config/store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../src/config/store');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'verentia-store-'));
}

test('reading a store that was never written gives an empty object', () => {
    const store = createStore(path.join(tempDir(), 'does-not-exist-yet'));

    assert.deepEqual(store.read(), {});
});

test('what is written can be read back', () => {
    const store = createStore(tempDir());

    store.write({ interface: 'enp0s31f6' });

    assert.deepEqual(store.read(), { interface: 'enp0s31f6' });
});

test('writing twice keeps the last value', () => {
    const store = createStore(tempDir());

    store.write({ interface: 'eth0' });
    store.write({ interface: 'wlan0' });

    assert.equal(store.read().interface, 'wlan0');
});

test('it creates the directory when it does not exist', () => {
    const nested = path.join(tempDir(), 'deep', 'nested');
    const store = createStore(nested);

    store.write({ interface: 'eth0' });

    assert.equal(store.read().interface, 'eth0');
    assert.ok(fs.existsSync(nested));
});

test('corrupt JSON reads as unconfigured instead of throwing', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, '{ this is not json');

    // Preferring "unconfigured" over a crash means the app starts and asks again,
    // rather than refusing to boot over a damaged settings file.
    assert.deepEqual(store.read(), {});
});

test('valid JSON that is not an object reads as unconfigured', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, '"just a string"');

    assert.deepEqual(store.read(), {});
});

test('null reads as unconfigured', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, 'null');

    assert.deepEqual(store.read(), {});
});

test('path points inside the given directory', () => {
    const dir = tempDir();
    const store = createStore(dir);

    assert.equal(path.dirname(store.path), dir);
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/config/store.test.js`
Expected: FAIL — `Cannot find module '../../src/config/store'`

- [ ] **Step 3: Implementar el almacén**

```js
// src/config/store.js
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'settings.json';

/**
 * A tiny JSON settings file.
 *
 * The directory is injected rather than read from Electron's app.getPath, so this
 * module can be tested without Electron and main.js stays the only place that knows
 * where userData lives.
 */
function createStore(baseDir, logger = null) {
    const filePath = path.join(baseDir, FILE_NAME);

    // A corrupt settings file silently resetting the choice would leave an operator
    // watching the dialog reappear with no idea why, so it leaves a trace.
    const warn = (message) => {
        if (logger && typeof logger.warn === 'function') logger.warn(message);
    };

    return {
        path: filePath,

        /**
         * The stored settings, or {} when there are none to be had.
         *
         * A missing, unreadable, corrupt or non-object file all read as {}. Starting
         * up and asking again beats refusing to boot over a damaged settings file.
         */
        read() {
            let raw;
            try {
                raw = fs.readFileSync(filePath, 'utf8');
            } catch (error) {
                // A missing file is the normal first-run case and not worth a warning.
                if (error.code !== 'ENOENT') {
                    warn(`No se pudo leer ${filePath}: ${error.message}`);
                }
                return {};
            }

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                warn(`Configuracion corrupta en ${filePath}, se ignora: ${error.message}`);
                return {};
            }

            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                warn(`Configuracion inesperada en ${filePath}, se ignora`);
                return {};
            }

            return parsed;
        },

        write(config) {
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        },
    };
}

module.exports = { createStore };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/config/store.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Suite completa**

Run: `npm test`
Expected: 219 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/config/store.js test/config/store.test.js
git commit -m "feat: add a tiny JSON settings store

The directory is injected instead of read from Electron's app.getPath, so
this is testable without Electron and main.js remains the only place that
knows where userData lives.

A missing, unreadable, corrupt or non-object file all read as empty: the
app should start and ask again rather than refuse to boot over a damaged
settings file."
```

---

### Task 3: Resolución con los cinco estados

**Files:**
- Create: `src/network/resolve.js`
- Create: `test/network/resolve.test.js`

**Interfaces:**
- Consumes: `listCandidateInterfaces` de Task 1; la forma `{read()}` del almacén de Task 2.
- Produces: `resolveLocalIp({interfaces, store}) → {ip, interface?, candidates?, status, savedInterface?}` con `status` en `configured | single | not_configured | stale | no_network`.

**El orden de comprobación es parte del contrato:** primero la interfaz guardada, luego el recuento de candidatas. Una interfaz guardada y válida gana siempre, incluso si aparecen nuevas candidatas después — quien la eligió ya decidió.

- [ ] **Step 1: Escribir el test que falla**

```js
// test/network/resolve.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocalIp } = require('../../src/network/resolve');

function ipv4(address, internal = false) {
    return { address, family: 'IPv4', internal, netmask: '255.255.255.0' };
}

function storeWith(config) {
    return { read: () => config };
}

const TWO = {
    lo: [ipv4('127.0.0.1', true)],
    enp0s31f6: [ipv4('192.168.0.47')],
    wlp0s20f3: [ipv4('192.168.0.225')],
    lerd0: [ipv4('192.0.2.1')],
};

test('a saved interface that still has an address is used', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'enp0s31f6' }),
    });

    assert.equal(result.status, 'configured');
    assert.equal(result.ip, '192.168.0.47');
    assert.equal(result.interface, 'enp0s31f6');
});

test('a single candidate is used without asking and without saving', () => {
    const writes = [];
    const store = { read: () => ({}), write: (c) => writes.push(c) };

    const result = resolveLocalIp({
        interfaces: { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('10.0.0.9')] },
        store,
    });

    assert.equal(result.status, 'single');
    assert.equal(result.ip, '10.0.0.9');
    assert.equal(result.interface, 'eth0');
    // Saving it would turn a default into a decision nobody made: if a second
    // interface appears tomorrow, the operator should be asked.
    assert.deepEqual(writes, []);
});

test('two or more candidates with nothing saved is not configured', () => {
    const result = resolveLocalIp({ interfaces: TWO, store: storeWith({}) });

    assert.equal(result.status, 'not_configured');
    assert.equal(result.ip, null);
    assert.deepEqual(result.candidates, [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ]);
});

test('a saved interface that no longer exists is stale, and says which', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'usb0' }),
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.ip, null);
    assert.equal(result.savedInterface, 'usb0');
    assert.equal(result.candidates.length, 2);
});

test('a saved interface that exists but was filtered out is also stale', () => {
    // lerd0 is present on the machine but excluded as a candidate, so a settings
    // file naming it must not resolve to 192.0.2.1.
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'lerd0' }),
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.ip, null);
    assert.equal(result.savedInterface, 'lerd0');
});

test('no candidates at all is no_network, with an empty list', () => {
    const result = resolveLocalIp({
        interfaces: { lo: [ipv4('127.0.0.1', true)], lerd0: [ipv4('192.0.2.1')] },
        store: storeWith({}),
    });

    assert.equal(result.status, 'no_network');
    assert.equal(result.ip, null);
    assert.deepEqual(result.candidates, []);
});

test('no interfaces whatsoever is no_network', () => {
    const result = resolveLocalIp({ interfaces: {}, store: storeWith({}) });

    assert.equal(result.status, 'no_network');
    assert.deepEqual(result.candidates, []);
});

test('a saved interface wins even when new candidates appear', () => {
    const withThree = { ...TWO, usb0: [ipv4('10.5.5.5')] };

    const result = resolveLocalIp({
        interfaces: withThree,
        store: storeWith({ interface: 'wlp0s20f3' }),
    });

    assert.equal(result.status, 'configured');
    assert.equal(result.ip, '192.168.0.225');
});

test('a saved interface wins even when it is the only candidate', () => {
    const result = resolveLocalIp({
        interfaces: { eth0: [ipv4('10.0.0.9')] },
        store: storeWith({ interface: 'eth0' }),
    });

    assert.equal(result.status, 'configured');
});

test('a store that returns a non-string interface is treated as unsaved', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 42 }),
    });

    assert.equal(result.status, 'not_configured');
});

test('when a saved interface has several addresses the first candidate wins', () => {
    const result = resolveLocalIp({
        interfaces: { eth0: [ipv4('192.168.0.47'), ipv4('10.0.0.9')] },
        store: storeWith({ interface: 'eth0' }),
    });

    assert.equal(result.ip, '192.168.0.47');
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/network/resolve.test.js`
Expected: FAIL — `Cannot find module '../../src/network/resolve'`

- [ ] **Step 3: Implementar la resolución**

```js
// src/network/resolve.js
const { listCandidateInterfaces } = require('./interfaces');

/**
 * Which address this workstation should report as its own.
 *
 * Returns an object rather than a string because "I do not know" is a legitimate
 * answer that has to be expressible: GET /ip is how the SGA identifies the
 * workstation, and a guess that happens to be wrong costs a scale that never
 * answers with no sign of why.
 *
 * The order of checks is part of the contract: the saved interface first, the
 * candidate count second. A saved, still-valid interface always wins, even once new
 * candidates appear — whoever chose it already decided.
 *
 * Statuses:
 *   configured      a saved interface that still has an address
 *   single          exactly one candidate; used without asking and without saving
 *   not_configured  two or more candidates and nothing saved
 *   stale           a saved interface that is gone, or no longer a candidate
 *   no_network      nothing that could be this workstation's address
 */
function resolveLocalIp({ interfaces, store }) {
    const candidates = listCandidateInterfaces(interfaces);
    const saved = store.read();
    const savedInterface = typeof saved.interface === 'string' ? saved.interface : null;

    if (savedInterface) {
        const match = candidates.find((c) => c.name === savedInterface);
        if (match) {
            return { ip: match.address, interface: match.name, status: 'configured' };
        }

        // Saved but gone, or still present and excluded by the filter — a settings
        // file naming lerd0 must not resolve to a documentation address.
        return { ip: null, candidates, status: 'stale', savedInterface };
    }

    if (candidates.length === 0) {
        return { ip: null, candidates, status: 'no_network' };
    }

    if (candidates.length === 1) {
        return { ip: candidates[0].address, interface: candidates[0].name, status: 'single' };
    }

    return { ip: null, candidates, status: 'not_configured' };
}

module.exports = { resolveLocalIp };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/network/resolve.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Comprobar que el bug real queda resuelto**

Con las interfaces de verdad de esta máquina, sin nada guardado, el estado debe ser
`not_configured` con dos candidatas — y sobre todo **no** `192.0.2.1`:

```bash
node -e "
const os = require('node:os');
const { resolveLocalIp } = require('./src/network/resolve');
const r = resolveLocalIp({ interfaces: os.networkInterfaces(), store: { read: () => ({}) } });
console.log(JSON.stringify(r, null, 2));
"
```

Expected: `status: 'not_configured'`, `ip: null`, y `candidates` con `enp0s31f6` y `wlp0s20f3`.
Pega la salida en el informe.

- [ ] **Step 6: Suite completa**

Run: `npm test`
Expected: 230 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
git add src/network/resolve.js test/network/resolve.test.js
git commit -m "feat: resolve the workstation's address with an explicit status

Returns an object rather than a string because 'I do not know' has to be
expressible: /ip is how the SGA identifies the workstation, and a guess
that happens to be wrong costs a scale that never answers with no sign of
why.

A saved interface wins over the candidate count, and a settings file
naming an interface that is gone — or one the filter excludes, such as
lerd0 — resolves to stale rather than to a documentation address."
```

---

### Task 4: `GET /ip` con 409, extraída a su módulo

Hoy la ruta está inline en `main.js` y por tanto no es testable. Se extrae siguiendo el patrón que ya usan `legacy-routes.js` y `scale-routes.js`: una función que registra sobre una app Express, sin tocar Electron.

**Files:**
- Create: `src/server/ip-route.js`
- Create: `test/ip-route.test.js`
- Modify: `main.js` (quitar la ruta inline y llamar al módulo)

**Interfaces:**
- Consumes: `resolveLocalIp` de Task 3.
- Produces: `registerIpRoute(expressApp, { resolve }) → void`, donde `resolve` es una función sin argumentos que devuelve lo mismo que `resolveLocalIp`. Se inyecta para poder probar los cinco estados sin manipular la red de la máquina.

- [ ] **Step 1: Escribir el test que falla**

```js
// test/ip-route.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerIpRoute } = require('../src/server/ip-route');

async function startApp(resolve) {
    const app = express();
    app.use(express.json());
    registerIpRoute(app, { resolve });
    const server = await new Promise((resolve2) => {
        const s = app.listen(0, '127.0.0.1', () => resolve2(s));
    });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}

test('a configured workstation answers 200 with just the ip, as before', async () => {
    const app = await startApp(() => ({
        ip: '192.168.0.47', interface: 'enp0s31f6', status: 'configured',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 200);
        // The SGA's getLocalIpFromElectron() and the browser's ip-detector both read
        // this exact field, so the successful shape must not change.
        assert.deepEqual(await res.json(), { ip: '192.168.0.47' });
    } finally {
        await app.close();
    }
});

test('a single candidate also answers 200', async () => {
    const app = await startApp(() => ({
        ip: '10.0.0.9', interface: 'eth0', status: 'single',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ip: '10.0.0.9' });
    } finally {
        await app.close();
    }
});

test('not configured answers 409 with the reason and the candidates', async () => {
    const candidates = [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ];
    const app = await startApp(() => ({ ip: null, candidates, status: 'not_configured' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.ip, null);
        assert.equal(body.reason, 'not_configured');
        assert.deepEqual(body.candidates, candidates);
    } finally {
        await app.close();
    }
});

test('stale answers 409 and names the interface that vanished', async () => {
    const app = await startApp(() => ({
        ip: null, candidates: [], status: 'stale', savedInterface: 'usb0',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.reason, 'stale');
        assert.equal(body.savedInterface, 'usb0');
    } finally {
        await app.close();
    }
});

test('no_network answers 409 with an empty candidate list', async () => {
    const app = await startApp(() => ({ ip: null, candidates: [], status: 'no_network' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.reason, 'no_network');
        assert.deepEqual(body.candidates, []);
    } finally {
        await app.close();
    }
});

test('a 409 is not a successful response, which is what keeps the SGA safe', async () => {
    // The SGA does `$response->successful() ? $response->json('ip') : null`, so any
    // 4xx already degrades to null and findScale() treats that as "no workstation".
    // This asserts the property that makes the SGA need no changes.
    const app = await startApp(() => ({ ip: null, candidates: [], status: 'not_configured' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
        assert.equal(res.ok, false);
    } finally {
        await app.close();
    }
});

test('an unexpected status does not answer 200 with a null ip', async () => {
    // Defensive: if resolveLocalIp ever grows a status this route does not know,
    // answering 200 with ip: null would look like success to every caller.
    const app = await startApp(() => ({ ip: null, status: 'something_new' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.notEqual(res.status, 200);
    } finally {
        await app.close();
    }
});
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run: `node --test test/ip-route.test.js`
Expected: FAIL — `Cannot find module '../src/server/ip-route'`

- [ ] **Step 3: Implementar la ruta**

```js
// src/server/ip-route.js

/**
 * GET /ip — which address this workstation reports as its own.
 *
 * The SGA identifies the workstation by this value, so a wrong answer costs a scale
 * that never answers. When there is no answer to give, this returns 409 rather than
 * 200 with ip: null, so a caller that only checks the status code cannot mistake
 * "not configured" for success. The SGA's getLocalIpFromElectron() already degrades
 * a non-successful response to null, so that path needs no changes.
 *
 * `resolve` is injected so the five states can be tested without touching the
 * machine's network.
 */
function registerIpRoute(expressApp, { resolve }) {
    expressApp.get('/ip', (req, res) => {
        const result = resolve();

        if (result.ip && (result.status === 'configured' || result.status === 'single')) {
            // Exactly the shape this endpoint has always returned.
            return res.json({ ip: result.ip });
        }

        return res.status(409).json({
            ip: null,
            reason: result.status,
            candidates: result.candidates || [],
            ...(result.savedInterface ? { savedInterface: result.savedInterface } : {}),
        });
    });
}

module.exports = { registerIpRoute };
```

- [ ] **Step 4: Ejecutar y verificar que pasan**

Run: `node --test test/ip-route.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Cablear en main.js**

Añadir los `require` junto a los que ya hay arriba:

```js
const { createStore } = require("./src/config/store");
const { resolveLocalIp } = require("./src/network/resolve");
const { registerIpRoute } = require("./src/server/ip-route");
```

Añadir, después de la definición de `logger` y antes de `setupServer()`, el almacén y el resolvedor de la app. `app.getPath("userData")` solo es válido cuando Electron está listo, así que el almacén se crea de forma diferida:

```js
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
```

Sustituir la ruta inline por la llamada al módulo. Donde hoy está:

```js
    expressApp.get("/ip", (req, res) => {
        res.json({ ip: getIPAddress() });
    });
```

dejar:

```js
    registerIpRoute(expressApp, { resolve: localIp });
```

- [ ] **Step 6: Pasar los otros tres consumidores a `localIp()`**

Las dos emisiones de socket.io pasan a enviar también el estado, para que un cliente conectado pueda
distinguir "no lo sé" de una IP real. Sustituir ambas ocurrencias de
`socket.emit("ip-address", { ip: getIPAddress() });` por:

```js
        const current = localIp();
        socket.emit("ip-address", { ip: current.ip, status: current.status });
```

En la etiqueta del tray, sustituir `label: \`IP actual: ${getIPAddress()}\`,` por:

```js
                label: `IP actual: ${describeLocalIp()}`,
```

y añadir junto a `localIp()` la función que produce ese texto:

```js
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
```

- [ ] **Step 7: Borrar `getIPAddress()`**

Ya no la usa nadie. Bórrala entera de `main.js` y confirma con:

```bash
grep -n "getIPAddress" main.js || echo "sin referencias"
```

- [ ] **Step 8: Verificar que la app arranca y responde**

`npm start` y, con la app levantada, en otra terminal:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/ip
curl -s http://localhost:3000/ip
```

Expected: en esta máquina hay dos candidatas y nada guardado, así que **409** con
`reason: "not_configured"` y las dos interfaces. Ese 409 es el comportamiento correcto: la Task 5 añade
el diálogo que lo resuelve. Pega la salida en el informe.

Comprueba además que la etiqueta del tray dice `IP actual: sin configurar`.

- [ ] **Step 9: Suite completa y commit**

```bash
npm test
node --check main.js
git add src/server/ip-route.js test/ip-route.test.js main.js
git commit -m "feat: GET /ip answers 409 when the interface is not chosen

The route moves out of main.js into a registrable module, matching the
pattern of the legacy and scale routes, so its five states can be tested
without Electron.

The successful shape is unchanged — the SGA and the browser's ip-detector
both read {ip} — and an unknown status deliberately does not answer 200
with a null ip, which would look like success to every caller.

getIPAddress() is gone: the tray, both socket.io emissions and the route
now go through one resolver, so they cannot disagree about which address
this workstation has."
```

Expected: 237 passing, 0 failing.

---

### Task 5: El diálogo de elección y la entrada del tray

Esta es la única tarea que toca Electron y por tanto **no es testable con `node --test`**. Su verificación es manual y está en el Step 6. No inventes tests que no puedan ejecutarse.

**Files:**
- Create: `select-interface.html`
- Modify: `preload.js`
- Modify: `main.js`

**Interfaces:**
- Consumes: `localIp()` y `getConfigStore()` de Task 4.
- Produces: nada que consuma otra tarea. Es el final del plan.

- [ ] **Step 1: Crear la ventana de elección**

`select-interface.html`, en la raíz del proyecto junto a `splash.html`, del que puedes copiar el estilo
para que las dos ventanas se parezcan. Requisitos de contenido:

- Un título: `Elige la interfaz de red de este puesto`.
- Una explicación de una frase: que el SGA identifica el puesto por su IP y que hay que decirle cuál usar.
- Un botón por candidata, mostrando **interfaz e IP juntas**: `enp0s31f6 · 192.168.0.47`. La interfaz sola
  no le dice nada a un operario y la IP sola no distingue cable de wifi.
- Cuando el motivo sea `stale`, una línea extra diciendo qué interfaz estaba guardada y ya no está, para
  que se entienda que algo cambió en el equipo y no que nunca se configuró.

Recibe los datos por `window.electronAPI.getInterfaceChoice()` y envía la elección con
`window.electronAPI.chooseInterface(name)`.

- [ ] **Step 2: Exponer las dos funciones en el preload**

`preload.js` ya usa `contextBridge` con `contextIsolation: true`. Añadir al objeto `electronAPI`:

```js
  getInterfaceChoice: () => ipcRenderer.invoke('get-interface-choice'),
  chooseInterface: (name) => ipcRenderer.invoke('choose-interface', name),
```

- [ ] **Step 3: Manejar el IPC y abrir la ventana en main.js**

```js
let interfaceWindow = null;

ipcMain.handle("get-interface-choice", () => {
    const current = localIp();
    return {
        candidates: current.candidates || [],
        reason: current.status,
        savedInterface: current.savedInterface || null,
    };
});

ipcMain.handle("choose-interface", (event, name) => {
    const current = localIp();
    const candidates = current.candidates || [];

    // Only ever store a name the machine actually offers. A renderer sending
    // anything else would otherwise write a settings file that resolves to stale.
    if (!candidates.some((c) => c.name === name)) {
        logger.warn(`⚠️ Interfaz no ofrecida, se ignora: ${name}`);
        return { saved: false };
    }

    getConfigStore().write({ interface: name });
    logger.info(`✅ Interfaz de red elegida: ${name}`);

    if (interfaceWindow) {
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
```

`buildContextMenu` está hoy definida dentro de `createTray()`, así que `choose-interface` no puede
llamarla. Súbela al ámbito del módulo con el nombre `buildTrayMenu()` y haz que `createTray()` y el
`setInterval` de 30 s la usen. Es un movimiento, no un cambio de contenido, más la entrada nueva del
siguiente paso.

- [ ] **Step 4: Añadir la entrada al menú del tray**

En `buildTrayMenu()`, justo después de la etiqueta `IP actual:`, añadir:

```js
            {
                label: "🌐 Cambiar interfaz de red",
                click: () => {
                    openInterfaceWindow();
                },
            },
```

Siempre habilitada: es la vía para corregir una elección equivocada, y también para elegir por primera
vez si alguien cerró el diálogo sin responder.

- [ ] **Step 5: Abrir el diálogo al arrancar cuando haga falta**

En `app.whenReady().then(...)`, después de `createTray()` y `setupServer()`, añadir:

```js
    // Only when there is genuinely something to choose. `single` needs no question,
    // and `no_network` has nothing to offer — that one is fixed with a cable, not a
    // dialog, so opening an empty window would only confuse.
    const startup = localIp();
    if (startup.status === "not_configured" || startup.status === "stale") {
        openInterfaceWindow();
    } else {
        logger.info(`🌐 IP local: ${describeLocalIp()}`);
    }
```

**No** reabrir el diálogo si se cierra sin elegir: en una máquina de taller sin nadie delante, un bucle
de ventanas es peor que el problema que resuelve. Se vuelve a ofrecer desde el tray.

- [ ] **Step 6: Verificación manual — esta tarea se valida aquí**

Con `npm start`, en esta máquina hay dos candidatas y nada guardado, así que el diálogo debe abrirse
solo. Comprueba y anota cada punto en el informe:

1. El diálogo lista **dos** botones, `enp0s31f6 · 192.168.0.47` y `wlp0s20f3 · 192.168.0.225`, y **no**
   aparece `lerd0` ni `192.0.2.1`.
2. Antes de elegir, `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/ip` da **409**.
3. Al pulsar `enp0s31f6`, la ventana se cierra y `curl -s http://localhost:3000/ip` devuelve
   `{"ip":"192.168.0.47"}` con **200**.
4. El tray dice `IP actual: 192.168.0.47 (enp0s31f6)`.
5. Existe un fichero `settings.json` con `{"interface": "enp0s31f6"}`. Su ruta se obtiene con
   `node -e "console.log(require('electron').app.getPath('userData'))"` o del log; en Linux suele ser
   `~/.config/VerentiaIP/`.
6. Cierra la app y vuelve a arrancar: el diálogo **no** debe aparecer, y `/ip` responde 200 directamente.
7. Desde el tray, "Cambiar interfaz de red" abre el diálogo otra vez. Elige la wifi y comprueba que `/ip`
   pasa a `192.168.0.225`. **Vuelve a dejarlo en `enp0s31f6`** al terminar.
8. Cierra el diálogo con la X sin elegir, partiendo de un `settings.json` borrado: `/ip` debe seguir en
   409 y el diálogo **no** debe reabrirse solo.

Si algo de esto no se cumple, dilo en el informe en vez de darlo por bueno.

- [ ] **Step 7: Suite completa y commit**

```bash
npm test
node --check main.js
git add select-interface.html preload.js main.js
git commit -m "feat: ask which network interface this workstation uses

Opens on startup only when there is genuinely something to choose: a
single candidate needs no question, and no_network has nothing to offer —
that one is fixed with a cable, not a dialog.

The dialog shows interface and address together, because the interface
alone means nothing to an operator and the address alone does not
distinguish cable from wifi. Closing it without choosing saves nothing and
does not reopen: on an unattended shop-floor machine a loop of windows
would be worse than the problem. The tray entry is how it is offered
again, and how a wrong choice gets corrected without touching code.

choose-interface only stores a name the machine actually offers, so a
renderer cannot write a settings file that resolves to stale."
```

Expected: 237 passing, 0 failing — esta tarea no añade tests automáticos, y eso es correcto: lo que
añade es interfaz de Electron, que se verifica en el Step 6.

---

### Task 6: Interpretar el 409 en el backoffice

**Esta tarea es en el OTRO repositorio: `/home/manel/Documentos/verentia`** (Laravel 12, rama `feature/mettler-scales`). Las cuatro anteriores son en VerentiaIP.

Sin ella, el 409 le dice al operario que reinstale una aplicación que ya está funcionando.

**Files (todas en `/home/manel/Documentos/verentia`):**
- Modify: `app/Modules/SGA/Http/Controllers/Admin/ScaleController.php` (`getLocalIpFromElectron()`)
- Modify: `app/Modules/SGA/Http/Controllers/Admin/InboundDeliveryLineController.php` (`validateScaleSetup()`)
- Modify: `resources/views/riho/components/ip-detector.blade.php`
- Modify: `app/Modules/SGA/lang/es/messages.php`, `app/Modules/SGA/lang/en/messages.php`
- Modify: `lang/es/ip-detector.php`, `lang/en/ip-detector.php` (comprueba las rutas reales: las claves se usan como `__('ip-detector.error_getting')`)
- Create: `tests/Feature/Modules/SGA/IpNotConfiguredTest.php`

**Interfaces:**
- Consumes: el 409 de Task 4, con `{ip: null, reason, candidates, savedInterface?}`.
- Produces: `scale_error: 'ip_not_configured'` en el payload de `validateScaleSetup()`.

**Reglas de entorno de ESE repo, que vienen de incidentes reales:**
- **PROHIBIDO** `php artisan migrate`, `migrate:fresh`, `db:seed` ni nada que escriba en la BD de desarrollo. `RefreshDatabase` se apaña.
- **Nunca commitear `.env.testing` ni `composer.lock`.** Indexar por ruta explícita, jamás `git add -A`. Revisar el índice antes de indexar.
- **`pint` por FICHERO, nunca por directorio** (un directorio arrastró 111 migraciones ajenas una vez).
- Tests con el MCP de lerd (`exec` → `artisan`, `path: /home/manel/Documentos/verentia`): el host no resuelve el hostname del contenedor de base de datos.
- El tema activo es `riho`.

- [ ] **Step 1: Escribir el test que falla**

```php
<?php
// tests/Feature/Modules/SGA/IpNotConfiguredTest.php

declare(strict_types=1);

namespace Tests\Feature\Modules\SGA;

use App\Models\Role;
use App\Models\User;
use App\Modules\SGA\Models\Scale;
use App\Modules\SGA\Models\WorkStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class IpNotConfiguredTest extends TestCase
{
    use RefreshDatabase;

    private const DESKTOP = 'http://localhost:3000';
    private const STATION_IP = '10.0.0.42';

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed();
        config()->set('sga.desktop_app_service', self::DESKTOP);

        $user = User::factory()->create();
        $role = Role::where('title', 'Admin')->first();
        if ($role) {
            $user->roles()->sync([$role->id]);
        }
        $this->actingAs($user);
    }

    private function station(): WorkStation
    {
        $workstation = WorkStation::factory()->create(['ip_address' => self::STATION_IP]);
        Scale::factory()->create([
            'workstation_id' => $workstation->id,
            'brand' => 'mettler_toledo',
            'is_active' => true,
        ]);

        return $workstation;
    }

    private function fakeNotConfigured(): void
    {
        Http::fake([
            self::DESKTOP . '/ip' => Http::response([
                'ip' => null,
                'reason' => 'not_configured',
                'candidates' => [
                    ['name' => 'enp0s31f6', 'address' => '10.0.0.42'],
                    ['name' => 'wlp0s20f3', 'address' => '10.0.0.99'],
                ],
            ], 409),
        ]);
    }

    public function test_a_409_reports_ip_not_configured_and_not_a_generic_failure(): void
    {
        $this->station();
        $this->fakeNotConfigured();

        $this->postJson(route('admin.inbound_delivery_lines.validate_scale_setup'), [
            'ipAddress' => self::STATION_IP,
        ])
            ->assertOk()
            ->assertJsonPath('calculate_units_manually', true)
            ->assertJsonPath('scale_error', 'ip_not_configured');
    }

    public function test_a_409_is_not_reported_as_desktop_outdated(): void
    {
        // Two different problems with two different fixes: an outdated desktop app
        // needs updating, an unconfigured one needs an interface chosen from the tray.
        $this->station();
        $this->fakeNotConfigured();

        $response = $this->postJson(route('admin.inbound_delivery_lines.validate_scale_setup'), [
            'ipAddress' => self::STATION_IP,
        ]);

        $this->assertNotSame('desktop_outdated', $response->json('scale_error'));
    }

    public function test_a_connection_failure_still_behaves_as_before(): void
    {
        $this->station();
        Http::fake(fn () => throw new \Illuminate\Http\Client\ConnectionException('sin ruta'));

        $this->postJson(route('admin.inbound_delivery_lines.validate_scale_setup'), [
            'ipAddress' => self::STATION_IP,
        ])
            ->assertOk()
            ->assertJsonPath('calculate_units_manually', true);
    }

    public function test_a_stale_reason_is_also_reported_as_ip_not_configured(): void
    {
        $this->station();
        Http::fake([
            self::DESKTOP . '/ip' => Http::response([
                'ip' => null,
                'reason' => 'stale',
                'savedInterface' => 'usb0',
                'candidates' => [['name' => 'enp0s31f6', 'address' => '10.0.0.42']],
            ], 409),
        ]);

        $this->postJson(route('admin.inbound_delivery_lines.validate_scale_setup'), [
            'ipAddress' => self::STATION_IP,
        ])
            ->assertOk()
            ->assertJsonPath('scale_error', 'ip_not_configured');
    }

    public function test_a_working_desktop_app_is_unaffected(): void
    {
        $this->station();
        Http::fake([
            self::DESKTOP . '/ip' => Http::response(['ip' => self::STATION_IP]),
            self::DESKTOP . '/health' => Http::response([
                'version' => '1.3.0',
                'apis' => ['legacy', 'scale-v1'],
                'brands' => ['mettler_toledo', 'bizerba'],
            ]),
        ]);

        $this->postJson(route('admin.inbound_delivery_lines.validate_scale_setup'), [
            'ipAddress' => self::STATION_IP,
        ])
            ->assertOk()
            ->assertJsonPath('message', 'success');
    }
}
```

- [ ] **Step 2: Ejecutar para verificar que falla**

Run (MCP de lerd): `artisan test --filter=IpNotConfiguredTest`
Expected: FAIL — `scale_error` no es `ip_not_configured` todavía.

- [ ] **Step 3: Distinguir el 409 en `getLocalIpFromElectron()`**

`ScaleController::getLocalIpFromElectron()` es privado y devuelve `?string`. Se conserva tal cual —lo usa
`findScale()` y su degradado a `null` es correcto— y se añade al lado un método que informa del motivo,
para no cambiar la firma de algo que ya funciona:

```php
    /**
     * The desktop app's view of this workstation's address, with the reason when
     * there is none.
     *
     * A 409 means the app is running but nobody has chosen which network interface
     * this workstation uses. That is a different problem from the app being
     * unreachable, and it has a different fix, so the two must not collapse into one
     * error: telling an operator to reinstall an application that is already running
     * sends them to reinstall it for nothing.
     *
     * @return array{ip: ?string, reason: ?string, candidates: array<int, array{name: string, address: string}>}
     */
    private function describeLocalIp(): array
    {
        try {
            $response = Http::timeout(3)->get(config('sga.desktop_app_service') . '/ip');
        } catch (\Illuminate\Http\Client\ConnectionException $exception) {
            return ['ip' => null, 'reason' => 'unreachable', 'candidates' => []];
        }

        if ($response->successful()) {
            return ['ip' => $response->json('ip'), 'reason' => null, 'candidates' => []];
        }

        if ($response->status() === Response::HTTP_CONFLICT) {
            return [
                'ip' => null,
                'reason' => $response->json('reason') ?? 'not_configured',
                'candidates' => $response->json('candidates') ?? [],
            ];
        }

        return ['ip' => null, 'reason' => 'unreachable', 'candidates' => []];
    }
```

Hazlo `public` si `InboundDeliveryLineController` no puede alcanzarlo de otro modo, y dilo en el informe.
Si ya existe un servicio compartido más apropiado donde ponerlo, úsalo y explica por qué.

- [ ] **Step 4: Devolver `ip_not_configured` desde `validateScaleSetup()`**

En `InboundDeliveryLineController::validateScaleSetup()`, antes de resolver el puesto por IP, comprobar el
estado del escritorio. Un `reason` de `not_configured` o `stale` sale así:

```php
        // The desktop app is running but has no network interface chosen, so it
        // cannot say which workstation this is. Distinct from unreachable: the fix is
        // choosing the interface from the tray, not reinstalling anything.
        if (in_array($desktop['reason'] ?? null, ['not_configured', 'stale'], true)) {
            return response()->json([
                'calculate_units_manually' => true,
                'scale_error' => 'ip_not_configured',
                'message' => __('SGA::messages.scale.ip_not_configured'),
            ], Response::HTTP_OK);
        }
```

Un `reason` de `unreachable` conserva **exactamente** el comportamiento de hoy: no lo cambies, o romperás
el caso de que la app no esté instalada.

- [ ] **Step 5: Añadir los mensajes**

En `app/Modules/SGA/lang/es/messages.php`, dentro del array `'scale'`:

```php
        'ip_not_configured' => 'La aplicación de escritorio de este puesto está funcionando pero no tiene elegida su interfaz de red. Ábrela desde la bandeja del sistema y elige la interfaz.',
```

En `app/Modules/SGA/lang/en/messages.php`:

```php
        'ip_not_configured' => 'The desktop app on this workstation is running but has no network interface chosen. Open it from the system tray and pick the interface.',
```

- [ ] **Step 6: Que `ip-detector` no ofrezca la descarga ante un 409**

Hoy el `.then` hace `if (!response.ok) throw new Error(...)`, y el `.catch` muestra el overlay **con el
enlace de descarga**. Hay que separar los dos casos antes de lanzar.

Sustituir el primer `.then` para que un 409 no vaya al `catch` genérico:

```js
            .then(async response => {
                if (response.status === 409) {
                    // The app is running; it just has no interface chosen. Offering the
                    // download here would send the operator to reinstall software that
                    // is already working.
                    const body = await response.json().catch(() => ({}));
                    const notConfigured = new Error('ip_not_configured');
                    notConfigured.ipNotConfigured = true;
                    notConfigured.candidates = body.candidates || [];
                    throw notConfigured;
                }
                if (!response.ok) {
                    throw new Error('{{ __('ip-detector.error_getting') }}');
                }
                return response.json();
            })
```

Y en el `.catch`, antes de mostrar el área de error, ramificar:

```js
                if (error.ipNotConfigured) {
                    if (statusElement) {
                        statusElement.textContent = '{{ __('ip-detector.not_configured') }}';
                        statusElement.style.color = '#FF4A60';
                    }
                    if (displayElement) {
                        displayElement.textContent = '{{ __('ip-detector.not_configured_short') }}';
                        displayElement.style.color = '#FF4A60';
                    }
                    // Deliberately does NOT show errorElement: that block carries the
                    // download link, which is the wrong instruction here.
                    if (overlayElement) {
                        overlayElement.style.display = 'flex';
                        overlayElement.style.opacity = '1';
                        const heading = overlayElement.querySelector('div > div:nth-of-type(2)');
                        if (heading) {
                            heading.textContent = '{{ __('ip-detector.not_configured') }}';
                        }
                    }
                    const notConfiguredEvent = new CustomEvent('{{ $eventName }}Error', {
                        detail: { error: error, ipNotConfigured: true, candidates: error.candidates },
                    });
                    document.dispatchEvent(notConfiguredEvent);
                    return;
                }
```

El overlay **sigue bloqueando**, porque sin IP el puesto no puede trabajar. Lo que cambia es el texto y
que no aparece la descarga. Comprueba el selector del `heading` contra el HTML real antes de darlo por
bueno; si no encaja, añade un `id` al elemento del título en vez de adivinar un selector frágil, y dilo en
el informe.

- [ ] **Step 7: Añadir las claves del detector**

Localiza los ficheros de `ip-detector` con `grep -rl "error_getting" lang/ app/*/lang/` y añade en el
castellano:

```php
    'not_configured' => 'Este puesto no tiene elegida su interfaz de red',
    'not_configured_short' => 'Sin configurar',
```

Y en el inglés:

```php
    'not_configured' => 'This workstation has no network interface chosen',
    'not_configured_short' => 'Not configured',
```

- [ ] **Step 8: Ejecutar y verificar que pasan**

Run: `artisan test --filter=IpNotConfiguredTest`
Expected: PASS, 5 tests.

Run: `artisan test --filter="Scale|ValidateScaleSetup"`
Expected: todo verde, sin regresión. Anota los números reales.

- [ ] **Step 9: Verificación manual con las dos apps**

Con VerentiaIP corriendo y **sin** interfaz elegida (borra su `settings.json`), abre en el navegador una
pantalla que use el componente. Comprueba y anota:

1. Sale el overlay bloqueando, con el texto de interfaz no elegida.
2. **No** aparece el enlace de descarga.
3. Al elegir la interfaz desde la bandeja y recargar, la pantalla pasa a funcionar.
4. Parando VerentiaIP del todo, vuelve a salir el mensaje antiguo **con** la descarga.

El punto 4 es el que confirma que no se ha roto el caso original.

- [ ] **Step 10: Estilo y commit**

```bash
./vendor/bin/pint app/Modules/SGA/Http/Controllers/Admin/ScaleController.php app/Modules/SGA/Http/Controllers/Admin/InboundDeliveryLineController.php
git status --short
git add <las rutas exactas que hayas tocado, una por una>
git commit -m "feat(sga): tell the operator to choose an interface, not to reinstall

VerentiaIP now answers 409 on /ip when no network interface has been
chosen. The ip-detector component's error path assumed a single cause —
the app not being installed — so it blocked the screen and offered a
download. That is the wrong instruction: the app is running, and
reinstalling it changes nothing.

A 409 now produces its own message and deliberately does not show the
download block, while a connection failure keeps the old behaviour
untouched. validateScaleSetup reports ip_not_configured rather than
collapsing it into a generic failure, since the two have different fixes."
git show --stat --format="" HEAD
```

---

## Verificación final del plan

- [ ] `npm test` pasa entero. Anota el total real.
- [ ] `grep -n "getIPAddress" main.js` no devuelve nada.
- [ ] `grep -rn "electron" src/network/ src/config/ src/server/ip-route.js` no devuelve nada: los módulos
  nuevos siguen siendo testables sin Electron.
- [ ] `src/server/legacy-routes.js` y `test/legacy-routes.test.js` sin cambios:
  `git diff --stat <base>..HEAD -- src/server/legacy-routes.js test/legacy-routes.test.js` vacío.
- [ ] Con `settings.json` presente y válido, `/ip` responde 200 con la IP de esa interfaz.
- [ ] Con `settings.json` borrado y dos candidatas, `/ip` responde 409 y el diálogo se abre al arrancar.

- [ ] En el SGA: `artisan test --filter="Scale|ValidateScaleSetup"` verde, y un 409 produce
  `ip_not_configured` y no `desktop_outdated`.

**ORDEN DE DESPLIEGUE, y esto importa:** los dos repositorios se despliegan juntos, o **el SGA primero**.
Si VerentiaIP sale antes con el 409 y el SGA todavía no lo interpreta, cada puesto sin interfaz elegida le
dirá al operario que reinstale una aplicación que ya está funcionando. El SGA con la interpretación puesta
funciona igual contra un VerentiaIP antiguo, porque un VerentiaIP antiguo nunca devuelve 409.

**Y un cambio operativo que hay que anunciar:** hasta que alguien elija la interfaz en cada puesto con más
de una candidata, ese puesto no encontrará su báscula. Elegir la interfaz pasa a ser un paso de
instalación. En puestos con una sola tarjeta de red no cambia nada: no se pregunta y sigue funcionando.
