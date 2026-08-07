const { ScaleError } = require('../errors');
const { toGrams } = require('../units');

const ETX = '\x03';

// Device addressing. These are the values that work today in production. The
// exact meaning of the three fields (sender, receiver, sub-address, or some
// other combination) is not confirmed because there is no BCP documentation
// at hand; they are left as three tokens and will be named once there is.
const DEFAULT_ADDRESS_PREFIX = ['0', '254', '001'];

// Bodies of the five telegrams, as they were in the SGA's ScaleController.
const TELEGRAMS = Object.freeze({
    info: 'I?GV05|LX02',
    tare: 'I!GX05',
    clearTare: 'I!GX06',
    weigh: 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02',
    platform: (n) => `I!LV01|GW01|${n}|LX02`,
});

// Response field -> weight key.
const FIELD_MAP = Object.freeze({ GD01: 'net', GD02: 'tare', GD07: 'gross' });

// An addressPrefix field ends up inside the telegram between two ETX (or
// between the last ETX and the final \r\n that TcpLink appends). If it
// contained ETX itself, or a CR/LF, it could close the field early or close
// the whole telegram and open a second one: whoever controls addressPrefix
// could slip a different command into the same send. Any other control
// character (0x00-0x1F, 0x7F) is rejected too: an address has no reason to
// carry non-printable characters, and accepting them "just in case" is the
// same kind of carelessness. An empty field is rejected the same way: it
// would collapse two delimiters into one and shift which field is which. It
// is rejected instead of sanitised (unlike the Mettler driver's display
// text) because a silently corrected address is not an address: it would
// talk to the wrong scale, or to none at all, without whoever configured it
// finding out.
// eslint-disable-next-line no-control-regex
const INVALID_ADDRESS_CHARS = /[\x00-\x1F\x7F]/;

/**
 * Validates one addressPrefix element and returns it as-is, so that
 * buildTelegram builds the telegram by joining THAT returned value — never
 * the caller's original array. Round 1 validated against a derived string
 * but serialised with `prefix.join(ETX)` over the input array, and the two
 * conversions did not agree (e.g. `null`/`undefined` collapsed to an empty
 * field in the join even though `String(null)` passed validation, and a
 * sparse array hole was not even passed to the validator via `forEach`).
 * Round 2's structural fix was to normalise once, with direct index access
 * (`prefix[i]`, which gives `undefined` for a hole), and validate and
 * serialise over that same value.
 *
 * Round 2 still coerced any type to a string with `String(raw)`, which let a
 * number like `1` slip through for a field that in production is `'001'`:
 * `String(1) === '1'`, without the leading zero, with the same practical
 * result as a field mistyped by hand — incorrect addressing, with no error
 * and nothing visibly odd in the telegram. Accepting `null`, `undefined` and
 * empty strings as errors while silently coercing numbers was inconsistent
 * with the "reject instead of silently correct" philosophy that motivates
 * this whole validator. That is why only `typeof raw === 'string'` is now
 * accepted: any other type (number, boolean, object, array, `null`,
 * `undefined`, or a `new String(...)` wrapper, whose `typeof` is `'object'`)
 * is rejected with a message that explicitly asks for the string form with
 * the leading zero.
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
    // `options` may arrive as `null` (the SGA sends `"options": null` when the
    // operator hasn't touched anything, not `{}` nor the field being absent):
    // the parameter's default value only kicks in for `undefined`, so a
    // direct `options.addressPrefix` blows up with a TypeError ("Cannot read
    // properties of null") that /scale/* would return as a 500 instead of
    // treating null the same as "no options". Optional chaining covers both
    // cases (options absent or options null) without needing a separate
    // branch.
    const prefix = options?.addressPrefix || DEFAULT_ADDRESS_PREFIX;
    if (!Array.isArray(prefix) || prefix.length !== 3) {
        throw new ScaleError('protocol', 'addressPrefix debe tener exactamente tres campos', { addressPrefix: prefix });
    }
    // Direct index access (no forEach/map over the caller's array): this way
    // a sparse hole reads as undefined and doesn't skip validation.
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
 * Extracts net, tare and gross weight from a response like
 * `I!LV01|GD01|kg;-3;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02`.
 *
 * Each field answers with a triplet `unit;exponent;value`: the actual
 * magnitude is value * 10^exponent in the given unit. A missing field, or one
 * with an incomplete triplet, is left as null, not zero: "it weighs zero" is
 * not the same thing as "it didn't tell me".
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
        // The exponent is always an integer (it may legitimately be negative,
        // e.g. -3 for grams from a kg base): a triplet like `kg;abc;1234` or
        // `kg;1.5;1234` made `Number(exponent)` come out as NaN, and
        // `10 ** NaN` is NaN, which JSON.stringify serialises as `null` -- the
        // field ended up with the SAME shape as "absent", but for a different
        // reason (corrupt data, not missing data) with nothing to tell them
        // apart. It is validated with the same rigor as value, and if it
        // doesn't pass it is treated like any other malformed triplet: the
        // field is left at null instead of forcing a value derived from junk.
        if (!/^[+-]?\d+$/.test(exponent)) return;
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

    // Zeroing, display text, beep and guided weighing are deliberately not
    // here: there is no BCP documentation for those operations and no
    // telegrams are being invented. The registry makes them answer 501
    // without opening a socket.
    deviceDependent: [],

    // No model overrides. The original main.js carried this observation,
    // quoted here as-is because it is the only clue left as to why someone
    // thought a per-model distinction was needed:
    //   // Las IS30 suelen usar terminación \r o \r\n
    //   (037efa7:main.js:234)
    // That is an "usually", not a confirmation, and \r\n is the value that
    // works today in production via the legacy path: forcing \r for is30
    // would silence a scale that currently works. What would settle this is
    // a real IS30 (or its BCP manual) confirming the terminator it actually
    // uses; until then, a model without an override uses the baseline, which
    // is the right call while there is no better evidence. No override is
    // added without that confirmation.
    models: {},

    async weigh(link, { options } = {}) {
        const lines = await ask(link, TELEGRAMS.weigh, options);
        const weights = parseWeights(lines.join(''));
        return {
            data: {
                ...weights,
                // The weight telegram is only answered once the weight has
                // already settled, so there is no equivalent to MT-SICS's
                // dynamic state.
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
                // Without BCP documentation it isn't parsed apart: it is
                // handed over raw for whoever knows how to read it to decide.
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
