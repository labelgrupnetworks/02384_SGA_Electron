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
    // 1.1 lb da 498.9516070000001 sin redondear. 4 decimales es decima de mg.
    // + 0 normaliza -0 a 0.
    return { value: Number(grams.toFixed(4)) + 0, unit: 'g' };
}

module.exports = { toGrams, KNOWN_UNITS };
