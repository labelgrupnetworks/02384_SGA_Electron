const test = require('node:test');
const assert = require('node:assert/strict');
const { toGrams, KNOWN_UNITS } = require('../../src/scales/units');
const { ScaleError } = require('../../src/scales/errors');

test('kg converts to grams', () => {
    assert.deepEqual(toGrams(1.234, 'kg'), { value: 1234, unit: 'g' });
});

test('grams pass through as-is', () => {
    assert.deepEqual(toGrams(500, 'g'), { value: 500, unit: 'g' });
});

test('applies the exponent before the unit, as in Bizerba telegrams', () => {
    // kg;-3;1234 => 1234 * 10^-3 kg = 1.234 kg = 1234 g
    assert.deepEqual(toGrams(1234, 'kg', -3), { value: 1234, unit: 'g' });
});

test('zero is kept without a negative sign', () => {
    assert.deepEqual(toGrams(0, 'kg', -3), { value: 0, unit: 'g' });
});

test('rounds to 4 decimals: 1.1 lb gives 498.9516, not 498.9516070000001', () => {
    // 1.1 * 453.59237 gives 498.9516070000001 unrounded. 4 decimals fixes it.
    assert.deepEqual(toGrams(1.1, 'lb'), { value: 498.9516, unit: 'g' });
});

test('negative values are kept', () => {
    assert.deepEqual(toGrams(-0.5, 'kg'), { value: -500, unit: 'g' });
});

test('very small negative values are normalised to +0, not -0', () => {
    const result = toGrams(-0.000001, 'mg');
    assert.deepEqual(result, { value: 0, unit: 'g' });
    // Negative control: verify -0 was NOT leaked
    assert.equal(Object.is(result.value, -0), false);
});

test('milligrams convert correctly', () => {
    // 1234 * 10^-3 mg = 1.234 mg = 0.001234 g
    assert.deepEqual(toGrams(1234, 'mg', -3), { value: 0.0012, unit: 'g' });
});

test('tonnes convert correctly', () => {
    // 2 t = 2000000 g
    assert.deepEqual(toGrams(2, 't'), { value: 2000000, unit: 'g' });
});

test('ounces convert correctly', () => {
    // 2.3 oz = 65.2039 g
    assert.deepEqual(toGrams(2.3, 'oz'), { value: 65.2039, unit: 'g' });
});

test('an unknown unit is a protocol error', () => {
    assert.throws(() => toGrams(1, 'pcs'), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('KNOWN_UNITS includes the weight units and the non-convertible ones', () => {
    for (const unit of ['kg', 'g', 'mg', 't', 'lb', 'oz', 'pcs', '%']) {
        assert.ok(KNOWN_UNITS.has(unit), `missing ${unit}`);
    }
});
