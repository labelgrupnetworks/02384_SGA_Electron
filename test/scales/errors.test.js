const test = require('node:test');
const assert = require('node:assert/strict');
const { ScaleError, httpStatusFor, ERROR_CODES } = require('../../src/scales/errors');

test('ScaleError guarda code y detail', () => {
    const err = new ScaleError('timeout', 'la bascula no contesto', { command: 'S' });
    assert.equal(err.code, 'timeout');
    assert.equal(err.message, 'la bascula no contesto');
    assert.deepEqual(err.detail, { command: 'S' });
    assert.ok(err instanceof Error);
});

test('ScaleError rechaza un code que no esta en la lista', () => {
    assert.throws(() => new ScaleError('inventado', 'x'), /code desconocido/);
});

test('cada code mapea a su estado HTTP', () => {
    assert.equal(httpStatusFor('unknown_brand'), 400);
    assert.equal(httpStatusFor('not_supported'), 501);
    assert.equal(httpStatusFor('connect'), 502);
    assert.equal(httpStatusFor('timeout'), 504);
    assert.equal(httpStatusFor('protocol'), 500);
    assert.equal(httpStatusFor('overload'), 500);
});

test('cada code declarado mapea exactamente a su status esperado', () => {
    const expectedStatuses = {
        unknown_brand: 400,
        not_supported: 501,
        connect: 502,
        timeout: 504,
        protocol: 500,
        overload: 500,
    };
    // Verificar que la tabla test tiene una entrada para cada code
    for (const code of ERROR_CODES) {
        assert.ok(code in expectedStatuses, `test table falta ${code}`);
    }
    // Verificar que httpStatusFor devuelve exactamente lo esperado
    for (const [code, status] of Object.entries(expectedStatuses)) {
        assert.equal(httpStatusFor(code), status, `${code} deberia ser ${status}`);
    }
});
