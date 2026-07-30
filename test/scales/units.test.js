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

test('redondea a 4 decimales para no arrastrar error de coma flotante', () => {
    // 0.1 * 1000 da 100.00000000000001 en IEEE754 si no se redondea
    assert.deepEqual(toGrams(0.1, 'kg'), { value: 100, unit: 'g' });
});

test('valores negativos se conservan', () => {
    assert.deepEqual(toGrams(-0.5, 'kg'), { value: -500, unit: 'g' });
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
