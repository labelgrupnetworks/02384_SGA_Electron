const { ScaleError } = require('../errors');
const { toGrams } = require('../units');

const ETX = '\x03';

// Direccionamiento del equipo. Estos son los valores que funcionan hoy en
// produccion. El significado exacto de los tres campos (emisor, receptor,
// subdireccion u otra combinacion) no esta confirmado porque no hay documentacion
// BCP a mano; se dejan como tres tokens y se les pondra nombre cuando la haya.
const DEFAULT_ADDRESS_PREFIX = ['0', '254', '001'];

// Cuerpos de las cinco tramas, tal como estaban en ScaleController del SGA.
const TELEGRAMS = Object.freeze({
    info: 'I?GV05|LX02',
    tare: 'I!GX05',
    clearTare: 'I!GX06',
    weigh: 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02',
    platform: (n) => `I!LV01|GW01|${n}|LX02`,
});

// Campo de la respuesta -> clave de peso.
const FIELD_MAP = Object.freeze({ GD01: 'net', GD02: 'tare', GD07: 'gross' });

// Un campo de addressPrefix acaba dentro de la trama entre dos ETX (o entre el
// ultimo ETX y el \r\n final que anade TcpLink). Si contuviera el propio ETX o
// un CR/LF podria cerrar el campo antes de tiempo o cerrar la trama entera y
// abrir una segunda: quien controle addressPrefix podria colar un comando
// distinto en el mismo envio. Se rechaza tambien cualquier otro caracter de
// control (0x00-0x1F, 0x7F): un direccionamiento no tiene motivo para llevar
// caracteres no imprimibles, y aceptarlos "por si acaso" es la misma clase de
// descuido. Un campo vacio se rechaza igual: colapsaria dos delimitadores en
// uno y desplazaria que campo es cual. Se rechaza en vez de sanear (a
// diferencia del texto de pantalla del driver Mettler) porque una direccion
// corregida en silencio no es una direccion: hablaria con la bascula
// equivocada, o con ninguna, sin que quien lo configuro se entere.
// eslint-disable-next-line no-control-regex
const INVALID_ADDRESS_CHARS = /[\x00-\x1F\x7F]/;

/**
 * Valida un elemento de addressPrefix y lo devuelve tal cual, para que
 * buildTelegram construya la trama uniendo ESE valor devuelto — nunca el
 * array original del llamador. Round 1 validaba sobre un string derivado
 * pero serializaba con `prefix.join(ETX)` sobre el array de entrada, y las
 * dos conversiones no coincidian (p.ej. `null`/`undefined` colapsaban a
 * campo vacio en el join aunque `String(null)` pasara la validacion, y un
 * hueco de array disperso ni siquiera llamaba al validador via `forEach`).
 * La correccion estructural de round 2 fue normalizar una sola vez, con
 * acceso directo por indice (`prefix[i]`, que da `undefined` para un hueco),
 * y validar y serializar sobre ese mismo valor.
 *
 * Round 2 seguia coaccionando cualquier tipo a string con `String(raw)`, lo
 * que colaba un numero como `1` para el campo que en produccion es `'001'`:
 * `String(1) === '1'`, sin el cero de relleno, con el mismo resultado
 * practico que un campo mal escrito a mano — direccionamiento incorrecto,
 * sin ningun error ni nada visiblemente raro en la trama. Aceptar `null`,
 * `undefined` y cadenas vacias como errores pero coaccionar numeros en
 * silencio era inconsistente con la filosofia "rechazar en vez de corregir en
 * silencio" que motiva todo este validador. Por eso ahora solo se acepta
 * `typeof raw === 'string'`: cualquier otro tipo (number, boolean, object,
 * array, `null`, `undefined`, o un wrapper `new String(...)`, cuyo `typeof`
 * es `'object'`) se rechaza con un mensaje que pide explicitamente la forma
 * string con el cero de relleno.
 */
function normalizeAddressElement(raw, index) {
    if (typeof raw !== 'string') {
        throw new ScaleError('protocol', `addressPrefix[${index}] debe ser un string, no ${typeof raw}; escribelo entre comillas y con el cero de relleno si lo lleva (p.ej. "001", no 1)`, { addressPrefix: raw, index });
    }
    if (raw.length === 0) {
        throw new ScaleError('protocol', `addressPrefix[${index}] esta vacio`, { addressPrefix: raw, index });
    }
    if (INVALID_ADDRESS_CHARS.test(raw)) {
        throw new ScaleError('protocol', `addressPrefix[${index}] contiene un caracter de control no permitido: ${JSON.stringify(raw)}`, { addressPrefix: raw, index });
    }
    return raw;
}

function buildTelegram(body, options = {}) {
    const prefix = options.addressPrefix || DEFAULT_ADDRESS_PREFIX;
    if (!Array.isArray(prefix) || prefix.length !== 3) {
        throw new ScaleError('protocol', 'addressPrefix debe tener exactamente tres campos', { addressPrefix: prefix });
    }
    // Acceso directo por indice (no forEach/map sobre el array del llamador):
    // asi un hueco disperso lee como undefined y no se salta la validacion.
    const normalized = [0, 1, 2].map((index) => normalizeAddressElement(prefix[index], index));
    return `${normalized.join(ETX)}${ETX}${body}`;
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

    // Puesta a cero, texto en display, pitido y pesada guiada no estan aqui a
    // proposito: no hay documentacion BCP para esas operaciones y no se inventan
    // tramas. El registro hace que respondan 501 sin abrir socket.
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
