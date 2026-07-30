const test = require('node:test');
const assert = require('node:assert/strict');
const { toGrams, KNOWN_UNITS } = require('../../src/scales/units');
const { ScaleError } = require('../../src/scales/errors');

test('kg se convierte a gramos', () => {
    assert.deepEqual(toGrams(1.234, 'kg'), { value: 1234, unit: 'g' });
});

test('gramos pasan tal cual', () => {
    assert.deepEqual(toGrams(500, 'g'), { value: 500, unit: 'g' });
});

test('aplica el exponente antes de la unidad, como en las tramas Bizerba', () => {
    // kg;-3;1234 => 1234 * 10^-3 kg = 1.234 kg = 1234 g
    assert.deepEqual(toGrams(1234, 'kg', -3), { value: 1234, unit: 'g' });
});

test('el cero se conserva sin signo negativo', () => {
    assert.deepEqual(toGrams(0, 'kg', -3), { value: 0, unit: 'g' });
});

test('redondea a 4 decimales: 1.1 lb da 498.9516 no 498.9516070000001', () => {
    // 1.1 * 453.59237 da 498.9516070000001 sin redondear. 4 decimales lo fija.
    assert.deepEqual(toGrams(1.1, 'lb'), { value: 498.9516, unit: 'g' });
});

test('valores negativos se conservan', () => {
    assert.deepEqual(toGrams(-0.5, 'kg'), { value: -500, unit: 'g' });
});

test('valores negativos muy pequeños se normalizan a +0, no -0', () => {
    const result = toGrams(-0.000001, 'mg');
    assert.deepEqual(result, { value: 0, unit: 'g' });
    // Negative control: verify -0 was NOT leaked
    assert.equal(Object.is(result.value, -0), false);
});

test('milígramos se convierten correctamente', () => {
    // 1234 * 10^-3 mg = 1.234 mg = 0.001234 g
    assert.deepEqual(toGrams(1234, 'mg', -3), { value: 0.0012, unit: 'g' });
});

test('toneladas se convierten correctamente', () => {
    // 2 t = 2000000 g
    assert.deepEqual(toGrams(2, 't'), { value: 2000000, unit: 'g' });
});

test('onzas se convierten correctamente', () => {
    // 2.3 oz = 65.2039 g
    assert.deepEqual(toGrams(2.3, 'oz'), { value: 65.2039, unit: 'g' });
});

test('una unidad desconocida es error de protocolo', () => {
    assert.throws(() => toGrams(1, 'pcs'), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('KNOWN_UNITS incluye las unidades de peso y las no convertibles', () => {
    for (const unit of ['kg', 'g', 'mg', 't', 'lb', 'oz', 'pcs', '%']) {
        assert.ok(KNOWN_UNITS.has(unit), `falta ${unit}`);
    }
});
