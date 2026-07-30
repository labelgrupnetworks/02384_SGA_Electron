const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitTokens, parseWeight, assertOk, isStable,
} = require('../../src/scales/drivers/mt-sics-protocol');
const { ScaleError } = require('../../src/scales/errors');

test('splitTokens trocea por espacios', () => {
    assert.deepEqual(splitTokens('S S 1.234 kg'), ['S', 'S', '1.234', 'kg']);
});

test('splitTokens respeta las comillas dobles como un solo token', () => {
    assert.deepEqual(
        splitTokens('I2 A "ICS425-BW 3.0045 kg"'),
        ['I2', 'A', 'ICS425-BW 3.0045 kg'],
    );
});

test('splitTokens tolera comillas vacias', () => {
    assert.deepEqual(splitTokens('I10 A ""'), ['I10', 'A', '']);
});

test('parseWeight lee valor y unidad de los dos ultimos tokens', () => {
    assert.deepEqual(parseWeight(['S', 'S', '1.234', 'kg']), { value: 1.234, unit: 'kg' });
});

test('parseWeight acepta pesos negativos', () => {
    assert.deepEqual(parseWeight(['S', 'S', '-0.500', 'kg']), { value: -0.5, unit: 'kg' });
});

test('parseWeight ignora una respuesta cuya ultima palabra no es unidad', () => {
    // Sin este filtro `TIM A 14 09 50` se leeria como "14 unidades 09".
    assert.equal(parseWeight(['TIM', 'A', '14', '09', '50']), null);
});

test('parseWeight ignora una respuesta demasiado corta', () => {
    assert.equal(parseWeight(['Z', 'A']), null);
});

test('parseWeight ignora un valor no numerico aunque la unidad sea buena', () => {
    assert.equal(parseWeight(['S', 'S', 'abc', 'kg']), null);
});

test('assertOk devuelve los tokens de una respuesta correcta', () => {
    assert.deepEqual(assertOk(['Z A']), ['Z', 'A']);
});

test('assertOk traduce ES a not_supported, porque el equipo no conoce el comando', () => {
    assert.throws(() => assertOk(['ES']), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'not_supported');
        return true;
    });
});

test('assertOk traduce ET y EL a protocol', () => {
    for (const code of ['ET', 'EL']) {
        assert.throws(() => assertOk([code]), (err) => {
            assert.equal(err.code, 'protocol', `${code} deberia ser protocol`);
            return true;
        });
    }
});

test('assertOk traduce + y - a overload', () => {
    assert.throws(() => assertOk(['S +']), (err) => {
        assert.equal(err.code, 'overload');
        assert.equal(err.detail.status, '+');
        return true;
    });
    assert.throws(() => assertOk(['S -']), (err) => {
        assert.equal(err.code, 'overload');
        return true;
    });
});

test('assertOk traduce I y L a protocol con el estado en detail', () => {
    assert.throws(() => assertOk(['T I']), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'I');
        return true;
    });
    assert.throws(() => assertOk(['SNS L']), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'L');
        return true;
    });
});

test('assertOk sin lineas es timeout', () => {
    assert.throws(() => assertOk([]), (err) => {
        assert.equal(err.code, 'timeout');
        return true;
    });
});

test('assertOk acepta el estado D de peso dinamico', () => {
    assert.deepEqual(assertOk(['S D 0.500 kg']), ['S', 'D', '0.500', 'kg']);
});

test('isStable distingue S de D', () => {
    assert.equal(isStable(['S', 'S', '1.234', 'kg']), true);
    assert.equal(isStable(['S', 'D', '1.234', 'kg']), false);
});
