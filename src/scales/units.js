const { ScaleError } = require('./errors');

// Factor to grams. Units that are not units of mass are recognised so they
// can be ruled out as a weight, but they have no factor.
const TO_GRAMS = Object.freeze({
    kg: 1000,
    g: 1,
    mg: 0.001,
    t: 1000000,
    lb: 453.59237,
    oz: 28.349523125,
});

// Everything an MT-SICS terminal can put as a unit. Used to decide whether a
// response is a weight: without this filter `TIM A 14 09 50` would be read as
// "14 units 09".
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
    // 1.1 lb gives 498.9516070000001 without rounding. 4 decimals is a tenth of
    // a mg. + 0 normalises -0 to 0.
    return { value: Number(grams.toFixed(4)) + 0, unit: 'g' };
}

module.exports = { toGrams, KNOWN_UNITS };
