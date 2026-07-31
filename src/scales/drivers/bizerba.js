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
 * Convierte un elemento de addressPrefix al string que de verdad se va a
 * enviar, y lo valida sobre ESE string. Antes se validaba `String(raw)` pero
 * se serializaba con `prefix.join(ETX)`, y esas dos conversiones no coinciden:
 * `String(null)` da `'null'` (no vacio, sin caracteres de control: pasaba la
 * validacion) pero `[..., null, ...].join(ETX)` renderiza ese hueco como
 * cadena vacia (colapsa el campo igual que si hubiera sido `''` a mano). Un
 * agujero de array disperso (`['0', , '001']`) es peor todavia: `forEach` ni
 * siquiera llama al callback para el hueco, asi que la validacion se saltaba
 * por completo. La correccion es estructural: normalizar una sola vez por
 * indice (con acceso directo `prefix[i]`, que si devuelve `undefined` para un
 * hueco), validar el resultado, y construir la trama uniendo ESE array
 * normalizado — nunca el array original del llamador.
 *
 * `null` y `undefined` (explicitos o por hueco) se rechazan en vez de
 * normalizarse a texto: un campo que el llamador no proporciono es un error
 * de configuracion, y tanto mandar el texto literal `"null"` como colapsar el
 * campo en silencio son peores que un mensaje claro.
 */
function normalizeAddressElement(raw, index) {
    if (raw === null || raw === undefined) {
        throw new ScaleError('protocol', `addressPrefix[${index}] no puede ser null ni undefined`, { addressPrefix: raw, index });
    }
    const value = String(raw);
    if (value.length === 0) {
        throw new ScaleError('protocol', `addressPrefix[${index}] esta vacio`, { addressPrefix: raw, index });
    }
    if (INVALID_ADDRESS_CHARS.test(value)) {
        throw new ScaleError('protocol', `addressPrefix[${index}] contiene un caracter de control no permitido: ${JSON.stringify(value)}`, { addressPrefix: raw, index });
    }
    return value;
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
