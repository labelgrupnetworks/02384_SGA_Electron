# Dos básculas independientes como una báscula de dos plataformas

Fecha: 2026-08-05
Repositorio afectado: `verentia` (SGA). **VerentiaIP no necesita ningún cambio.**
Antecedente: `2026-07-30-mettler-scale-support-design.md`

## Problema

El flujo de trasvase a cubetas usa dos plataformas de pesada y elige entre ellas según lo
que va a pesar. Con Bizerba eso es una sola báscula con dos plataformas: se conmuta con un
telegrama al mismo terminal, y el equipo recuerda cuál está activa.

Con Mettler no existe ese montaje. El ICS425 tiene **un único canal de báscula**: no admite
una segunda plataforma. Las dos básculas del almacén son dos terminales independientes, cada
uno con su pantalla y su IP.

Hay que conseguir que el SGA trate los dos casos igual.

### Por qué el ICS425 no puede hacerlo, y por qué parecía que sí

La ficha de Mettler para el ICS425 declara **1 canal de báscula**. Aun así, el terminal
declara `SNS` (seleccionar báscula) y `STA` en su lista `I0` de 87 comandos, porque MT-SICS es
un juego de comandos común a toda la familia: declararlo no implica tener el hardware.

Comprobado contra el equipo real (`192.168.0.86:4305`, ICS425-BW):

- `SNS` devuelve `SNS 1`. Acepta `SNS 1` porque 1 es la única báscula que hay.
- `STA 1`, `STA 2` y `STA 3` devuelven `1.0000 kg`, `2.0000 kg` y `3.0000 kg`, mientras el
  peso real en ese momento era `-3.0000 kg`. `STA 7` devuelve `STA L` (parámetro no
  permitido). **`STA n` no lee plataformas: devuelve el argumento.**

Un montaje de dos plataformas conmutables requiere un terminal de otra gama (ICS449 / ICS469,
donde la segunda báscula debe ser digital SICS o SICSpro, no una célula analógica) o el IND400,
que es el reemplazo declarado desde que las versiones AC del ICS4_5 se descontinuaron en
febrero de 2026. Nada de eso es necesario para este trabajo.

### Qué significa cada plataforma

Confirmado con el responsable: **plataforma 1 es la pequeña, de precisión** (contar unidades,
calcular peso unitario) y **plataforma 2 es la grande, de capacidad** (la cubeta llena). Se
corresponden con la Mettler pequeña y la grande respectivamente. Mapearlo al revés enviaría
cada pesada a la báscula equivocada sin producir ningún error.

### Cómo se elige hoy

La elección **no la hace el operario**, la hace el flujo. Tres puntos la disparan, todos bajo
`window.scaleDecanting`:

- `riho/inbound-delivery/tub/js/product-scanner.blade.php`: al escanear producto,
  `product.weight ? 'change_to_2' : 'change_to_1'` — si se conoce el peso unitario va a la
  grande, si no a la pequeña.
- `riho/inbound-delivery/tub/js/calculator.blade.php`: tras calcular el peso unitario,
  `change_to_2`; al volver al paso de contar unidades, `change_to_1`.

Siempre el mismo par: cambiar de plataforma **y tarar**.

### Un hallazgo del análisis: cinco métodos inalcanzables

`Route::resource('scales', ...)` genera solo el CRUD. Las únicas rutas adicionales son
`scales.test-connection` y `scales.massDestroy`. Por tanto `ScaleController::info()`,
`tare()`, `deleteTare()`, `changeToScale()` y `getWeights()` **no tienen ruta y son
inalcanzables por HTTP**.

Eso explica retroactivamente por qué el test de propagación del 501 quedó saltado en su
momento: no existe ruta que golpear. En producción el peso lo obtiene el navegador hablando
directamente con VerentiaIP; del lado servidor solo se usan `testConnection()` y
`validateScaleSetup()`.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Modelo de datos | Báscula primaria con secundaria enlazada |
| Plataforma 1 / 2 | 1 = pequeña de precisión, 2 = grande de capacidad |
| Plataforma activa | La mantiene el navegador |
| Métodos huérfanos | Se borran |
| VerentiaIP | Sin cambios |

## Modelo de datos

`scales` gana una columna:

- `secondary_scale_id`, nullable, clave ajena a `scales.id` con `nullOnDelete`, e **índice
  único** para que dos primarias no puedan reclamar la misma secundaria.

Configuración resultante:

- **Bizerba**: una fila, `secondary_scale_id` nulo.
- **Mettler**: la pequeña es la primaria y apunta a la grande.

### La regla de precedencia

Una sola frase cubre las dos marcas, sin listas de marcas en el código:

> Si hay secundaria configurada, la plataforma 2 **es ese otro equipo**. Si no la hay, la
> plataforma 2 **es un comando al mismo equipo**.

Se elige una regla de precedencia en vez de una comprobación por marca porque no acopla el SGA
al catálogo de drivers, y porque permitiría sin cambios una Bizerba repartida en dos terminales
si algún día aparece.

### Validaciones

Sin ellas se configura mal en silencio, y una báscula mal enlazada no da error: da pesos de la
báscula equivocada.

- Una secundaria no puede tener a su vez secundaria (sin cadenas).
- Una báscula no puede ser su propia secundaria.
- Primaria y secundaria deben ser de la **misma marca**: una primaria Bizerba con secundaria
  Mettler no significa nada.
- Primaria y secundaria deben pertenecer al **mismo puesto de trabajo**. Son dos equipos en la
  misma mesa físicamente; enlazar básculas de puestos distintos describiría un montaje que no
  existe, y además `findScale()` resuelve por puesto, así que una secundaria de otro puesto sería
  inalcanzable de todas formas.
- La secundaria no puede estar ya enlazada por otra primaria (lo garantiza el índice único,
  pero se valida antes para dar un mensaje legible en vez de un error de integridad).

### Configuración desde la pantalla

El formulario de báscula gana un select **Báscula secundaria (plataforma 2)**, opcional, con la
opción vacía "Ninguna: plataforma 2 por comando" como valor por defecto — que es lo que deja a
Bizerba comportándose como hasta ahora sin tocar nada.

El select solo ofrece candidatas válidas, de modo que las validaciones de arriba sean una red y
no la vía normal de descubrir un error: básculas del **mismo puesto**, de la **misma marca**, que
no sean la propia báscula, que no estén ya enlazadas por otra primaria, y que no tengan a su vez
una secundaria. Si no hay ninguna candidata, el select sale deshabilitado con el motivo escrito,
en vez de vacío y sin explicación.

Al editar la báscula **secundaria**, el formulario avisa de que es la plataforma 2 de su primaria
y no ofrece enlazarle nada. Sin ese aviso, quien abra la ficha de la báscula grande no tiene
forma de saber que está enlazada, y las validaciones le rechazarían cambios sin contexto.

## Resolución

Un único punto de decisión, para que la regla de precedencia no se duplique:

```php
resolvePlatform(Scale $primary, int $platform): array{scale: Scale, command: bool}
```

- Plataforma 1 → la primaria, sin comando.
- Plataforma 2 → la secundaria si existe, sin comando; si no, la primaria con
  `selectPlatform(2)`.

### El arreglo de `findScale()`

Hoy resuelve la báscula del puesto con `orderByDesc('id')->first()`. Con dos filas en el mismo
puesto eso elige la de id más alto, es decir arbitrariamente, y deja la otra inalcanzable.

Pasa a excluir las básculas que son secundaria de alguien, de modo que devuelve siempre la
primaria. Es donde el modelo de primaria con enlace se paga solo: no hay que desambiguar nada,
porque la secundaria se alcanza únicamente a través de su primaria.

## Payload de `validateScaleSetup()`

Conserva la forma plana actual para la plataforma 1 —lo que ya consume el navegador— y añade
dos campos:

```json
{
  "message": "success",
  "scale": {
    "ip": "10.32.230.18", "port": 4305,
    "brand": "mettler_toledo", "model": "ics425", "options": null,
    "api": "scale-v1",
    "switchMode": "device",
    "platform2": {
      "ip": "10.32.230.19", "port": 4305,
      "brand": "mettler_toledo", "model": "ics4xx", "options": null
    }
  }
}
```

`switchMode` es `"device"` cuando hay secundaria y `"command"` cuando no. `platform2` es `null`
en modo `command`. El camino `legacy` mantiene sus `commands` y `mappings` como hasta ahora y
siempre sale en modo `command`, porque una Bizerba por telegramas hex no puede direccionar un
segundo equipo.

## Navegador

`change_to_N` pasa a significar "activa la plataforma N":

- En modo `command`: manda el telegrama exactamente como hoy.
- En modo `device`: solo mueve `window.scaleConfig.activePlatform` y **no toca la red**.

El resto de operaciones (`tare`, `get_weights`, `info`) resuelven ip, puerto, marca, modelo y
opciones contra la plataforma activa. `activePlatform` arranca en 1.

**Los tres puntos que disparan el cambio no se tocan**: siguen llamando `change_to_1` y
`change_to_2` igual que ahora. Ese es el objetivo del diseño: el paradigma se unifica por
debajo y el flujo de cubetas no se entera.

### Un efecto secundario que mejora lo actual

Con dos equipos independientes cada uno mantiene **su propia tara**, así que volver a la
plataforma 1 conserva la tara que ya tenía. Compartiendo terminal, la Bizerba no lo garantiza.
No se explota deliberadamente —el flujo tara tras cada cambio de todas formas— pero conviene
saber que el comportamiento no es idéntico, sino mejor.

## Limpieza

Se borran `ScaleController::info()`, `tare()`, `deleteTare()`, `changeToScale()` y
`getWeights()`, más el helper `runOperation()` que solo ellos usan, por ser inalcanzables. Con
ellos desaparece el test saltado de propagación del 501, cuyo sujeto deja de existir; eso cierra
honestamente un pendiente que se arrastraba en vez de dejarlo como cobertura fingida.

Se conservan `testConnection()`, el CRUD, `findScale()`, `getLocalIpFromElectron()`,
`getValidatedScale()` y `jsonError()`.

`ScaleGateway` se mantiene entero: `testConnection()` usa `call($scale, 'info')` y
`validateScaleSetup()` usa `apiFor()`. Sus operaciones de pesada quedan cubiertas solo por
tests, lo cual es correcto: son la vía por la que el servidor *podría* pesar si algún día se
decide mover el flujo, y borrarlas obligaría a reescribirlas.

## Pruebas

- `resolvePlatform()`: plataforma 1 devuelve la primaria; plataforma 2 con secundaria devuelve
  la secundaria y sin comando; plataforma 2 sin secundaria devuelve la primaria con comando; un
  número que no sea 1 ni 2 se rechaza.
- `findScale()`: con una primaria y su secundaria en el mismo puesto devuelve la primaria, no la
  de id más alto. Este test debe fallar contra el código actual.
- Validaciones: cadena de secundarias, autorreferencia, marcas distintas, puestos distintos y
  secundaria ya enlazada, cada una con su mensaje.
- Formulario: el select de secundaria ofrece solo candidatas válidas (mismo puesto, misma marca,
  no ella misma, no ya enlazada, sin secundaria propia), y sale deshabilitado con motivo cuando no
  hay ninguna. Editar una secundaria no ofrece enlazarle nada y avisa de quién es su primaria.
- `validateScaleSetup()`: modo `device` incluye `platform2` con la ip de la secundaria; modo
  `command` lo deja en `null`; el camino `legacy` sigue saliendo en modo `command` con sus
  `commands` y `mappings`.
- Navegador: `change_to_2` en modo `device` no hace ninguna petición y cambia la plataforma
  activa; en modo `command` sí manda el telegrama; una operación posterior usa la ip de la
  plataforma activa.
- Regresión: con una sola báscula sin secundaria, todo el flujo se comporta exactamente como
  antes.

## Fuera de alcance

- **VerentiaIP no cambia.** La plataforma 2 como equipo distinto es simplemente otra ip en la
  misma llamada `/scale/weigh`, y `selectPlatform` ya existe para el caso por comando.
- Más de dos plataformas. El modelo de primaria con enlace no escala a tres, y no hay caso de
  uso: el flujo de cubetas usa exactamente dos.
- Que el operario elija báscula a mano. La elección la hace el flujo según el producto, y
  cambiarlo alteraría el trabajo de la gente del almacén.
- Mover el flujo de pesada al servidor. Se registra como la alternativa considerada al borrar
  los métodos huérfanos, no como trabajo de este spec.
- Sustituir hardware por un ICS449/ICS469 o un IND400. Queda documentado arriba como el camino
  si algún día se quiere conmutación real en un solo terminal.

## Riesgo principal

Un enlace mal configurado no falla: pesa en la báscula equivocada y el peso parece bueno. Las
validaciones y el test de `findScale()` son la defensa, pero la comprobación que de verdad
cierra esto es manual y con las dos básculas delante: dar de alta la pequeña como primaria con
la grande como secundaria, y confirmar en el trasvase que al escanear un producto con peso
unitario conocido se enciende **la grande**, y al contar unidades **la pequeña**.
