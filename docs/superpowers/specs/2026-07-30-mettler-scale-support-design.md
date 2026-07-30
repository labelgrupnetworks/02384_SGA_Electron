# Soporte de básculas Mettler Toledo junto a Bizerba

Fecha: 2026-07-30
Repositorios afectados: `02384_SGA_Electron` (VerentiaIP) y `verentia` (SGA)

## Problema

VerentiaIP expone dos endpoints que son puentes TCP sin conocimiento de protocolo:
`POST /scale-command` (texto, añade CRLF, traduce `<ETX>`) y `POST /scale-hex` (bytes
exactos). Todo el conocimiento del protocolo vive en el SGA: `ScaleController::SCALE_COMMANDS`
guarda las tramas Bizerba en hexadecimal y las empuja hasta el navegador, que las envía él
mismo por `fetch`.

Hay que poder pesar con una Mettler Toledo ICS4xx (protocolo MT-SICS) sin perder Bizerba, y
aprovechar que la Mettler sabe mostrar texto y pitar además de pesar.

### Estado de partida verificado

VerentiaIP (`main.js`):

- Los dos endpoints son el mismo bloque TCP duplicado: uno con `string`, otro con `Buffer`.
- Ambos cierran el socket con `setTimeout(() => client.end(), 100)` al recibir la primera
  ráfaga de datos. Con MT-SICS eso trunca las respuestas multilínea (`I0`, `MER`) e impide
  encadenar comandos en una misma conexión.
- Cada comando abre y cierra su propia conexión.

SGA (`app/Modules/SGA/`):

- `ScaleController::SCALE_COMMANDS['bizerba_hex']` tiene seis operaciones: `info`
  (`I?GV05|LX02`), `tare` (`I!GX05`), `delete_tare` (`I!GX06`), `change_to_1` / `change_to_2`
  (`I!LV01|GW01|N|LX02`) y `get_weights` (`I?LV01|RX02|STA7|GD01;GD02;GD07|LX02`).
- `SCALE_COMMANDS['mettler_toledo']` **no es MT-SICS**: contiene `'info' => 'I'`,
  `'change_to_1' => 'SCALE,1'`, `'get_weights' => 'SCALE,2'`. Una ICS4xx no entiende nada de
  eso. Es un placeholder que no funcionaría.
- `SCALE_MAPPINGS['mettler_toledo']` (`['S' => 'net', 'T' => 'tare', 'G' => 'gross']`) también
  es un placeholder: MT-SICS no devuelve neto, tara y bruto en una sola trama.
- `SCALE_COMMANDS['bizerba']` (variante no-hex) no la usa nadie.
- Los seis métodos del controlador van cableados a `bizerba_hex`, con un
  `// TODO: Assuming we're working with Bizerba scales` en `getWeights()`.
- La tabla `scales` no tiene columna de marca. `Scale::SCALE_MODEL_OPTIONS` ya declara
  `bizerba` y `mettler_toledo`, pero no está en `$fillable` ni en la migración.
- `InboundDeliveryLineController::validateScaleSetup()` devuelve al navegador el mapa
  `bizerba_hex` completo más `SCALE_MAPPINGS['bizerba']` en `window.scaleConfig`.
- El parseo de `unit;exponent;value` está duplicado: en PHP (`ScaleWeightParser`) y otra vez
  en JS (`utils.blade.php`, función `getScaleWeights`).

Banco de pruebas: hay una Mettler ICS425-BW en `192.168.0.86:4305` (alcance 3,0045 kg,
s/n C614409345), verificada con `I2` e `I4`. El puerto 10051 de esa IP está cerrado: **no hay
Bizerba física disponible para pruebas.**

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Alcance | Se modifican los dos repositorios |
| Estado en VerentiaIP | Ninguno. La marca viaja como parámetro en cada petición |
| Autodetección de marca | No se implementa. `brand` es obligatorio |
| Compatibilidad | `/scale-command` y `/scale-hex` intactos, mismo contrato y mismas respuestas |
| Pesada guiada | Operaciones atómicas **y** una compuesta |
| Extensibilidad | Registro de drivers, para que añadir marca/modelo no toque endpoints |
| Paridad Bizerba | Las cinco operaciones existentes; lo que la Bizerba no sabe responde 501 |

## Arquitectura: VerentiaIP

```
main.js                        arranque, tray, updater, servidor (sin lógica de báscula)
src/server/legacy-routes.js    /scale-command y /scale-hex, movidos sin un solo cambio
src/server/scale-routes.js     rutas /scale/* y GET /health
src/scales/transport.js        TcpLink
src/scales/registry.js         brand → driver, catálogo de capacidades
src/scales/units.js            normalización a gramos
src/scales/drivers/mettler-sics.js
src/scales/drivers/bizerba-bcp.js
```

### TcpLink (`transport.js`)

Portado de la clase `SicsLink` de `/home/manel/scripts/mettler/mt.py`, que ya está probada
contra la ICS425:

- Lectura por líneas con el terminador que declare el driver.
- `read-until-quiet`: acumula hasta que pasan `quietMs` sin datos nuevos, con techo
  `totalMs`. Sustituye al `setTimeout(100)` y es lo que permite respuestas multilínea.
- Drenado del buffer antes de cada envío, para que la cola de un comando no se lea como
  respuesta del siguiente.
- Una conexión puede ejecutar varios comandos, que es lo que hace posible `guided-weigh`.
- `close()` idempotente, invocado siempre en `finally`.

### Contrato de driver

Es el punto de extensión. Añadir una marca o un modelo nuevo es un fichero más y una línea en
`registry.js`; ningún endpoint cambia.

Los ids de driver son **exactamente** las claves de `Scale::SCALE_MODEL_OPTIONS` del SGA
(`bizerba`, `mettler_toledo`). Que coincidan evita una capa de traducción entre los dos
repositorios, que es una fuente de errores gratuita. El protocolo concreto va en `label` y en
el nombre del fichero, no en el id.

```js
module.exports = {
  id: 'mettler_toledo',
  label: 'Mettler Toledo ICS4xx (MT-SICS)',
  defaultPort: 4305,
  framing: { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 },
  capabilities: ['weigh', 'tare', 'clearTare', 'zero', 'info', 'selectPlatform',
                 'display', 'displayClear', 'beep', 'guidedWeigh'],

  async weigh(link, opts) { /* → { net, tare, gross, stable } */ },
  async tare(link, opts) { /* → {} */ },
  // …una función por capacidad declarada
};
```

`registry.js` valida al arrancar que cada driver implementa exactamente las funciones que
declara en `capabilities`. Una capacidad declarada sin función, o una función sin declarar, es
un error de arranque y no un 500 en producción.

### Endpoints nuevos

Todos POST con `{ ip, port, brand }`. `brand` es obligatorio; si falta o es desconocida,
400 con `error.code = "unknown_brand"` y la lista de marcas válidas.

| Endpoint | Bizerba | Mettler MT-SICS |
|---|---|---|
| `/scale/weigh` | `I?LV01\|RX02\|STA7\|GD01;GD02;GD07\|LX02` | `S` + `TA`; bruto = neto + tara |
| `/scale/tare` | `I!GX05` | `T` |
| `/scale/clear-tare` | `I!GX06` | `TAC` |
| `/scale/select-platform` `{platform: 1\|2}` | `I!LV01\|GW01\|N\|LX02` | `SNS N` |
| `/scale/info` | `I?GV05\|LX02` | `I2` + `I4` |
| `/scale/zero` | 501 | `Z` |
| `/scale/display` `{text}` | 501 | `D "texto"` |
| `/scale/display-clear` | 501 | `DW` |
| `/scale/beep` | 501 | `DS` |
| `/scale/guided-weigh` | 501 | `D` → `DS` → `S` → `DW` |
| `GET /scale/brands` | — | catálogo con capacidades |
| `GET /health` | — | versión y APIs disponibles |

Los nombres de capacidad van en camelCase (`clearTare`, `selectPlatform`, `guidedWeigh`) y los
de ruta en kebab-case (`/scale/clear-tare`). La correspondencia es mecánica y la resuelve
`scale-routes.js` al montar las rutas a partir del registro, de modo que no hay una segunda
lista de endpoints que mantener sincronizada.

Los dos endpoints `GET` no se solapan: `/health` es el sondeo barato de compatibilidad y
devuelve `{ version, apis, brands: ["bizerba", "mettler_toledo"] }`, solo los ids;
`/scale/brands` devuelve el catálogo completo con `label`, `defaultPort` y `capabilities` de
cada driver, que es lo que el SGA necesita para pintar formularios y deshabilitar botones.

### Formato de respuesta

Éxito:

```json
{
  "success": true,
  "brand": "mettler_toledo",
  "op": "weigh",
  "data": {
    "net":   { "value": 1234, "unit": "g" },
    "tare":  { "value": 50,   "unit": "g" },
    "gross": { "value": 1284, "unit": "g" },
    "stable": true
  },
  "raw": ["S S 1.234 kg", "TA A 0.050 kg"]
}
```

Los pesos van siempre normalizados a gramos, igual que hace hoy `ScaleWeightParser`, para que
el SGA no tenga que saber si la báscula reportó kg con exponente o gramos directos. `raw` se
conserva siempre: es lo único que permite depurar una báscula que responde algo inesperado.

Error:

```json
{ "success": false, "brand": "bizerba", "op": "zero",
  "error": { "code": "not_supported", "message": "…", "detail": null } }
```

`code` ∈ `connect | timeout | protocol | not_supported | overload | unknown_brand`.
Códigos HTTP: 400 `unknown_brand` y parámetros inválidos, 501 `not_supported`,
502 `connect`, 504 `timeout`, 500 el resto. `not_supported` tiene código propio para que el
SGA distinga "esta báscula no sabe hacer esto" de "ha fallado el intento".

### MT-SICS: interpretación de respuestas

Portada de `mt.py`. Una respuesta es `<comando> <estado> [datos]`:

- Estados: `A` ok, `S` estable, `D` dinámico, `I` ocupado, `L` parámetro no permitido,
  `+` sobrecarga, `-` bajo rango.
- Errores fatales: `ES` sintaxis, `ET` transmisión, `EL` lógico.
- `+` y `-` se traducen a `error.code = "overload"`.
- Un peso solo se acepta como tal si el último token es una unidad conocida
  (`kg g mg t lb oz …`) y el penúltimo un número. Sin ese filtro, `TIM A 14 09 50` se lee
  como «14 unidades 09»; es un fallo real que `mt.py` documenta y ya tiene resuelto.

### guided-weigh

La mejora que motiva el trabajo. Body: `{ ip, port, brand, text?, beep?, waitStable?, timeoutMs? }`.
Sobre **una sola conexión**:

1. `D "<text>"` si viene `text`.
2. `DS` si `beep` es cierto.
3. `S` (espera estabilidad) o `SI` (inmediato) según `waitStable`, con techo `timeoutMs`.
4. `DW` en el `finally`, **siempre**, incluso si la pesada falla o expira.

Ese `DW` en `finally` es el requisito importante: sin él, una báscula se queda con el texto
puesto y sin mostrar el peso cuando algo se corta a mitad, y el operario ve un display
congelado sin saber por qué.

`waitStable` por defecto `true`; `timeoutMs` por defecto 10000.

## Arquitectura: SGA

### Marca en base de datos

- Migración: `scales.brand` string, con `default('bizerba')` para que las filas existentes
  sigan funcionando sin intervención.
- `brand` a `$fillable` de `Scale`.
- Select en los formularios de alta y edición, alimentado de `Scale::SCALE_MODEL_OPTIONS`,
  que ya existe y hasta ahora no se usaba.
- Regla `in:` con las claves de `SCALE_MODEL_OPTIONS` en `StoreRequest` y `UpdateRequest`.
- `StoreUseCase` y `UpdateUseCase` reciben el parámetro nuevo.

### Detección de versión de VerentiaIP

VerentiaIP se auto-actualiza cada dos horas. Habrá por tanto una ventana en la que el SGA ya
sabe hablar `/scale/*` pero el escritorio de una máquina concreta todavía no. La señal es el
404: un VerentiaIP antiguo no tiene `/health`.

`validateScaleSetup()` sondea `GET /health` —ya alcanza el escritorio por HTTP, igual que
`getLocalIpFromElectron()`— y devuelve al navegador una de dos formas:

```json
{ "scale": { "ip": "…", "port": 4305, "brand": "mettler_toledo", "api": "scale-v1" } }
```

```json
{ "scale": { "ip": "…", "port": 10051, "brand": "bizerba", "api": "legacy",
             "commands": { … }, "mappings": { … } } }
```

Si `/health` responde pero la marca configurada no aparece en `brands`, se cae a `legacy`
cuando la marca es `bizerba`, y se devuelve error explícito cuando es `mettler_toledo`: una
Mettler no tiene camino legacy que funcione.

### ScaleGateway

Clase nueva que concentra la decisión. Los seis métodos del controlador (`info`, `tare`,
`deleteTare`, `changeToScale`, `getWeights`, `testConnection`) dejan de cablear `bizerba_hex`
y pasan por ella. Recibe el `Scale`, mira `brand` y el resultado de `/health`, y llama al
endpoint nuevo o al `/scale-hex` de siempre. El `// TODO: Assuming we're working with Bizerba
scales` desaparece porque deja de ser verdad.

### Navegador

`callElectron()` en `utils.blade.php` branchea **una sola vez** sobre `cfg.api`:

- `scale-v1`: `POST /scale/<op>` con `{ ip, port, brand }` y lee `data`, ya normalizado.
- `legacy`: exactamente lo que hace hoy, incluido el parseo JS de `unit;exponent;value`.

El objetivo de la forma del branch es que el camino viejo quede aislado y borrable en un solo
commit el día que ya no quede nadie sin actualizar, en vez de enredado con el nuevo.

### Limpieza

Se borra:

- `SCALE_COMMANDS['mettler_toledo']` y `SCALE_MAPPINGS['mettler_toledo']`. No son MT-SICS y no
  funcionarían. Dejarlas es peor que no tenerlas: el siguiente que las lea las creerá buenas.
- `SCALE_COMMANDS['bizerba']`, la variante no-hex, que no la usa nadie.

Se conserva:

- `SCALE_COMMANDS['bizerba_hex']` y `SCALE_MAPPINGS['bizerba']`, que son el camino de
  compatibilidad.
- `ScaleWeightParser` con sus tests, sin cambios. Pasa a servir solo al camino legacy; en
  `scale-v1` la normalización la hace el driver. Es la misma conversión en dos sitios durante
  la transición: es el precio de la compatibilidad, y desaparece con el branch.

## Pruebas

VerentiaIP, con `node:test` (viene en Node, sin dependencias nuevas). Servidor TCP falso que
responde tramas grabadas:

- Framing y `read-until-quiet`: respuesta en una ráfaga, partida en varias, multilínea, y
  silencio total (timeout).
- Parseo MT-SICS: `S S 1.234 kg` estable, `S D …` dinámico, `S +` sobrecarga, `ES` sintaxis, y
  el caso `TIM A 14 09 50`, que no debe interpretarse como peso.
- Parseo Bizerba con la trama real capturada:
  `I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02`
  (de `tests/Unit/Modules/SGA/Services/ScaleWeightParserTest.php`).
- `guided-weigh` envía `DW` también cuando la pesada falla o expira.
- Las capacidades declaradas por cada driver corresponden con sus funciones.
- Regresión de los endpoints legacy: `/scale-command` y `/scale-hex` producen byte a byte lo
  mismo que antes del refactor.

SGA, con PHPUnit y `Http::fake()`:

- `ScaleGateway` toma la rama correcta según `brand` y según que `/health` responda o dé 404.
- `validateScaleSetup()` devuelve `api: "scale-v1"` o `api: "legacy"` con su payload.
- Una Mettler con VerentiaIP antiguo produce error explícito, no un intento silencioso por el
  camino legacy.

Verificación manual contra la ICS425-BW de `192.168.0.86:4305`: `/scale/info`, `/scale/weigh`,
`/scale/tare`, `/scale/zero`, `/scale/display`, `/scale/beep` y `/scale/guided-weigh`.

**Limitación conocida:** no hay Bizerba en el banco de pruebas. El driver Bizerba queda
cubierto solo por tramas grabadas, y necesita una validación contra hierro real antes de darlo
por bueno en producción. Queda dicho explícitamente porque es el riesgo principal de esta
entrega.

## Fuera de alcance

- Auto-updater, tray, splash, `GET /ip` y socket.io: no se tocan.
- Unificar `/scale-command` con `/scale-hex` aunque sean el mismo bloque duplicado. Son la
  superficie de compatibilidad, y refactorizarlos es justo el riesgo que se quiere evitar.
- Autodetección de marca.
- Registro de básculas ni UI de configuración en VerentiaIP: la configuración vive en el SGA,
  que ya tiene su CRUD.
- Modo `SIR` (peso continuo en streaming). La API es petición-respuesta; el streaming
  necesitaría socket.io y no hay caso de uso que lo pida.

## Orden de entrega

Cada paso es utilizable por sí solo.

1. **VerentiaIP, andamiaje.** Extraer `transport.js` y `registry.js`; mover los endpoints
   legacy a `legacy-routes.js` sin cambios; `GET /health`. Verificación: los tests de
   regresión legacy pasan.
2. **VerentiaIP, driver Mettler.** Driver completo, `/scale/*`, `guided-weigh`,
   `GET /scale/brands`. Verificación: pesar con la ICS425 por `curl`.
3. **VerentiaIP, driver Bizerba.** Cinco operaciones reales, cuatro en 501. Verificación:
   tramas grabadas.
4. **SGA, migración.** Columna `brand`, formularios, validación, casos de uso.
5. **SGA, `ScaleGateway`.** Las dos ramas, los seis métodos del controlador, y la limpieza de
   los placeholders `mettler_toledo`.
6. **SGA, navegador.** `validateScaleSetup()` con `api`, y el branch en `callElectron()`.

## Preguntas abiertas

- Si la Bizerba BCP tiene equivalentes de puesta a cero, texto en display o señal acústica, se
  añaden al driver en cuanto haya documentación. Hasta entonces responden 501; no se inventan
  tramas.
