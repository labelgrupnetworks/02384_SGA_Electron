const test = require('node:test');
const assert = require('node:assert/strict');
const { ScaleError, httpStatusFor, ERROR_CODES } = require('../../src/scales/errors');

test('ScaleError stores code and detail', () => {
    const err = new ScaleError('timeout', 'la bascula no contesto', { command: 'S' });
    assert.equal(err.code, 'timeout');
    assert.equal(err.message, 'la bascula no contesto');
    assert.deepEqual(err.detail, { command: 'S' });
    assert.ok(err instanceof Error);
});

test('ScaleError rejects a code that is not in the list', () => {
    assert.throws(() => new ScaleError('inventado', 'x'), /code desconocido/);
});

test('each code maps to its HTTP status', () => {
    assert.equal(httpStatusFor('unknown_brand'), 400);
    assert.equal(httpStatusFor('missing_params'), 400);
    assert.equal(httpStatusFor('not_supported'), 501);
    assert.equal(httpStatusFor('connect'), 502);
    assert.equal(httpStatusFor('timeout'), 504);
    assert.equal(httpStatusFor('protocol'), 500);
    assert.equal(httpStatusFor('overload'), 500);
});

test('each declared code maps exactly to its expected status', () => {
    const expectedStatuses = {
        unknown_brand: 400,
        missing_params: 400,
        not_supported: 501,
        connect: 502,
        timeout: 504,
        protocol: 500,
        overload: 500,
    };
    // Verify that the test table has an entry for each code
    for (const code of ERROR_CODES) {
        assert.ok(code in expectedStatuses, `test table is missing ${code}`);
    }
    // Verify that httpStatusFor returns exactly what is expected
    for (const [code, status] of Object.entries(expectedStatuses)) {
        assert.equal(httpStatusFor(code), status, `${code} should be ${status}`);
    }
});
