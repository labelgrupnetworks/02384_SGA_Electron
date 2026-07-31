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
