# Elección y persistencia de la interfaz de red en VerentiaIP

Fecha: 2026-08-06
Repositorios afectados: `02384_SGA_Electron` (VerentiaIP) y `verentia` (SGA). **El 409 hay que interpretarlo en el backoffice**; ver "Efecto en el SGA".

## Problema

`GET /ip` es cómo el SGA identifica el puesto de trabajo: `WorkStation::where('ip_address', $ip)`. Si
devuelve la IP equivocada, no hay puesto, no hay báscula, y el flujo de trasvase cae a captura manual.

`getIPAddress()` en `main.js` recorre todas las interfaces y **sobreescribe** el resultado en cada IPv4
no interna:

```js
Object.keys(interfaces).forEach((interfaceName) => {
    interfaces[interfaceName].forEach((iface) => {
        if (iface.family === "IPv4" && !iface.internal) {
            ipAddress = iface.address;
        }
    });
});
```

No elige: gana la última que itera. Reproducido en la máquina de desarrollo:

| Interfaz | IPv4 | interna |
|---|---|---|
| `lo` | 127.0.0.1 | sí |
| `enp0s31f6` | 192.168.0.47 | no |
| `wlp0s20f3` | 192.168.0.225 | no |
| `lerd0` | **192.0.2.1** | no |

`getIPAddress()` devuelve `192.0.2.1`, la interfaz dummy del entorno de desarrollo lerd, cuando la IP
real del equipo es `192.168.0.47`.

El problema tiene dos capas. La primera es que `192.0.2.0/24` es el rango de documentación de la
RFC 5737 y nunca puede ser la IP de un puesto. La segunda es que, incluso descartándolo, quedan **dos**
direcciones legítimas de la LAN —cable y wifi— y "la IP del equipo" no tiene respuesta única. VerentiaIP
no puede saber cuál es la buena; quien lo sabe es el operario que instaló el puesto.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Cuándo pregunta | Se descartan rangos imposibles; si queda una, se usa sin preguntar; si quedan dos o más, pregunta |
| Qué devuelve `/ip` sin elección | 409 con las candidatas y el motivo |
| Qué se persiste | La **interfaz**, y su IP se resuelve en cada consulta |
| Dónde se cambia después | Entrada nueva en el menú del tray |

## Descubrimiento de candidatas

`listCandidateInterfaces(interfaces)` devuelve `[{name, address}]` a partir de un mapa como el de
`os.networkInterfaces()`. Recibe las interfaces por parámetro en vez de leerlas dentro, para poder
probarla con interfaces falsas sin depender de la red de la máquina.

Descarta:

- Las internas (`iface.internal`), que es el loopback.
- Todo lo que no sea `IPv4`.
- `169.254.0.0/16` — link-local: significa que el DHCP falló, no es una IP de puesto.
- `192.0.2.0/24` — rango de documentación de la RFC 5737. De aquí sale el `lerd0` del entorno de
  desarrollo. Ningún puesto real usa este rango.
- `172.17.0.0/12` — puentes de contenedores (Docker y similares).

No se descartan `10.0.0.0/8`, `172.16.0.0/12` fuera del tramo de contenedores ni `192.168.0.0/16`: son
rangos privados legítimos y hay instalaciones en todos ellos.

**El filtro reduce las preguntas, no las sustituye.** Es una lista de exclusiones y por tanto
incompleta por naturaleza: una VPN o un adaptador virtual nuevo aparecerían como candidatos. Eso es
aceptable porque el resultado es una pregunta más, no una IP equivocada.

## Persistencia

Un JSON en `app.getPath('userData')`, con una sola clave:

```json
{ "interface": "enp0s31f6" }
```

Se guarda **la interfaz, no la IP**. Si el DHCP renueva y el equipo pasa de `.47` a `.48`, todo sigue
funcionando sin tocar nada, porque la IP se resuelve en cada consulta. La elección del operario
significa realmente "usa el cable", que es lo que quiere decir.

`main.js` no persiste nada hoy, así que esto va en un módulo propio, `src/config/store.js`, con
`read()` y `write(config)`. Un fichero ausente o corrupto se trata como "sin configurar" y se registra
en el log: es preferible volver a preguntar que arrancar con una configuración a medias.

## Resolución

`resolveLocalIp()` es el único punto que decide, y devuelve un objeto en vez de una cadena, porque
"no lo sé" es una respuesta legítima que hay que poder expresar:

| Situación | Devuelve |
|---|---|
| Interfaz guardada y con IP | `{ip, interface, status: 'configured'}` |
| Una sola candidata | `{ip, interface, status: 'single'}` |
| Dos o más y nada guardado | `{ip: null, candidates, status: 'not_configured'}` |
| Interfaz guardada que ya no existe o no tiene IP | `{ip: null, candidates, status: 'stale', savedInterface}` |
| Ninguna candidata | `{ip: null, candidates: [], status: 'no_network'}` |

El orden de comprobación importa: primero la interfaz guardada, luego el recuento de candidatas. Una
interfaz guardada y válida gana siempre, incluso si aparecen nuevas candidatas después — quien la eligió
ya decidió.

`no_network` es el equipo sin red, o con red pero sin ninguna dirección que supere el filtro. Se
distingue de `not_configured` porque **no hay nada que preguntar**: el diálogo no debe abrirse con una
lista vacía. Es un problema de red que se arregla enchufando un cable, no eligiendo.

El caso `single` **no guarda nada**: si mañana aparece una segunda interfaz, se preguntará, que es el
comportamiento correcto. Guardarla convertiría un acierto por defecto en una decisión que nadie tomó.

El caso `stale` es el que justifica guardar la interfaz en vez de la IP: si alguien quita el cable, el
sistema lo dice en vez de devolver una dirección que ya no existe en el equipo.

## `GET /ip`

Cuando hay respuesta, sigue devolviendo exactamente lo de hoy, para no romper a los consumidores
actuales:

```json
{ "ip": "192.168.0.47" }
```

Cuando no la hay, **HTTP 409** con el motivo y las candidatas:

```json
{
  "ip": null,
  "reason": "not_configured",
  "candidates": [
    { "name": "enp0s31f6", "address": "192.168.0.47" },
    { "name": "wlp0s20f3", "address": "192.168.0.225" }
  ]
}
```

`reason` es `not_configured`, `stale` o `no_network`; en este último caso `candidates` va vacío. Se elige
409 en vez de 200 con `ip: null` para que un cliente que solo mire el código de estado no confunda
"no configurado" con éxito.

## El diálogo

Al arrancar, si `resolveLocalIp()` devuelve `not_configured` o `stale`, se abre una ventana pequeña que
lista las candidatas con **interfaz e IP juntas** —`enp0s31f6 · 192.168.0.47`— porque la interfaz sola no
le dice nada a un operario y la IP sola no distingue cable de wifi. Un botón por candidata; al pulsar,
se guarda y la ventana se cierra.

En el caso `stale` el diálogo indica además qué interfaz estaba guardada y ya no está, para que quien lo
vea entienda que algo cambió en el equipo y no que nunca se configuró.

Si la ventana se cierra sin elegir, **no se guarda nada** y `/ip` sigue respondiendo 409. El diálogo
**no se reabre solo**: se vuelve a ofrecer desde el tray. Reabrirlo en bucle en una máquina de taller sin
nadie delante sería peor que el problema que resuelve.

## El tray

La etiqueta `IP actual:` ya existe y el menú se reconstruye cada 30 segundos. Pasa a mostrar la interfaz
junto a la IP, o el estado cuando no hay elección:

- `IP actual: 192.168.0.47 (enp0s31f6)`
- `IP actual: sin configurar`
- `IP actual: sin configurar (enp0s31f6 ya no existe)`
- `IP actual: sin red`

Debajo, una entrada nueva **"Cambiar interfaz de red"** que abre el mismo diálogo. Ahí vive la
configuración cambiable a posteriori, sin pantallas nuevas que mantener.

## Los otros consumidores

`getIPAddress()` tiene cuatro puntos de uso en `main.js`: `GET /ip`, dos emisiones de socket.io
(`ip-address`, al conectar y al recibir `get-ip`) y la etiqueta del tray. Todos pasan a usar
`resolveLocalIp()`.

Las dos emisiones de socket.io envían `{ip, status}`, con `ip: null` cuando no hay elección, para que un
cliente conectado pueda distinguir "no lo sé" de una IP real. Hoy emiten `{ip}` con una cadena siempre,
así que añadir `status` es compatible: quien solo lea `ip` sigue funcionando.

## Efecto en el SGA

**El 409 hay que interpretarlo, y no es opcional.** Sin interpretarlo, el backoffice le da al operario una
instrucción equivocada.

`components/ip-detector.blade.php` bloquea la pantalla con "Detectando IP" y, en su `.catch`, hace tres
cosas: muestra "no detectada", **vuelve a mostrar el overlay a pantalla completa** y despliega un área de
error **con un enlace de descarga**. Ese camino asume una sola causa: que VerentiaIP no está instalado.

Un 409 no es `response.ok`, así que cae por ahí y el operario ve "descarga VerentiaIP" cuando la app
**está instalada y corriendo** — solo le falta elegir la interfaz. Descargaría, reinstalaría, y seguiría
igual. El problema no es que falte una explicación, es que se da una instrucción que no arregla nada.

Cambios requeridos en el SGA:

- **`ip-detector.blade.php`** distingue un 409 de un fallo de conexión. Ante un 409 muestra un mensaje
  propio —que la app funciona pero no tiene interfaz elegida, y que se abre desde la bandeja del sistema
  para elegirla— y **no ofrece la descarga**. El overlay sigue bloqueando, porque sin IP el puesto no
  puede trabajar, pero dice qué hacer de verdad. Si el 409 trae `candidates`, listarlas ayuda a que quien
  esté delante reconozca su equipo.
- **`getLocalIpFromElectron()`** hoy hace `$response->successful() ? $response->json('ip') : null`. Un 409
  ya degrada a `null` y `findScale()` lo trata como "sin puesto", así que **no se rompe nada**. Pasa a
  distinguir el 409 para que `validateScaleSetup()` pueda devolver `scale_error: 'ip_not_configured'` en
  vez de caer a captura manual sin motivo, igual que ya hace con `desktop_outdated`.

### Orden de despliegue

Los dos repositorios deben desplegarse juntos, o **el SGA primero**. Si VerentiaIP sale antes con el 409 y
el SGA todavía no lo interpreta, cada puesto sin interfaz elegida le dirá al operario que reinstale la
aplicación. El SGA con la interpretación puesta funciona igual contra un VerentiaIP antiguo, porque un
VerentiaIP antiguo nunca devuelve 409.

## Pruebas

- `listCandidateInterfaces()` con interfaces inyectadas: descarta loopback, IPv6, `169.254.x`,
  `192.0.2.x` y `172.17.x`; conserva `10.x`, `192.168.x` y un `172.16.x` fuera del tramo de
  contenedores; y con el mapa real del problema (`lo`, `enp0s31f6`, `wlp0s20f3`, `lerd0`) devuelve
  exactamente las dos interfaces buenas. Este último caso es la regresión del bug.
- `resolveLocalIp()` en los cinco estados, incluidas la interfaz guardada que ha desaparecido y la
  ausencia total de candidatas.
- Una interfaz guardada y válida gana aunque haya nuevas candidatas: el orden de comprobación es el
  correcto.
- Con `no_network` el diálogo NO se abre.
- El caso `single` no escribe el fichero de configuración.
- `store.read()` con fichero ausente y con JSON corrupto devuelve "sin configurar" sin lanzar.
- `GET /ip` devuelve 200 con `{ip}` cuando hay elección, y 409 con `reason` y `candidates` cuando no.
- Que el 409 no rompe al SGA: un `Http::get` sobre él no es `successful()`, así que
  `getLocalIpFromElectron()` da `null`.
- En el SGA: un 409 produce `scale_error: 'ip_not_configured'` y no `desktop_outdated`; y un fallo de
  conexión sigue produciendo lo que producía. Son diagnósticos distintos y no deben confundirse.
- En el navegador: ante un 409, `ip-detector` **no** muestra el enlace de descarga, y ante un fallo de
  conexión **sí**. Este es el test que impide volver a darle al operario la instrucción equivocada.

## Fuera de alcance

- Elegir la interfaz **desde el SGA**. La elección es local del puesto; llevarla al SGA obligaría a un
  CRUD nuevo y a que el SGA supiera de interfaces de red, que no es asunto suyo.
- Detectar automáticamente por ruta por defecto. Adivinaría, y la decisión explícita fue preguntar.
- IPv6. Ningún puesto lo usa y `work_stations.ip_address` guarda IPv4.

## Riesgo principal

Si el operario elige la interfaz equivocada —la wifi cuando el SGA tiene registrado el cable— el
síntoma es idéntico al bug actual: el puesto no encuentra su báscula. La diferencia es que ahora hay
dónde mirar y dónde corregirlo, en el tray, sin tocar código ni reinstalar. Mostrar interfaz e IP juntas
en el diálogo es lo que reduce esa probabilidad, y por eso no se muestra solo la IP.
