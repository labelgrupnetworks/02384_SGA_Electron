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

test('todos los codes declarados tienen estado', () => {
    for (const code of ERROR_CODES) {
        assert.equal(typeof httpStatusFor(code), 'number', `falta estado para ${code}`);
    }
});
