const test = require('node:test');
const assert = require('node:assert/strict');
const { CmcError, httpStatusFor, ERROR_CODES } = require('../../src/cmc/errors');

test('CmcError carries code and detail', () => {
    const error = new CmcError('unknown_barcode', 'not in manifest', { barcode: '123' });
    assert.equal(error.name, 'CmcError');
    assert.equal(error.code, 'unknown_barcode');
    assert.deepEqual(error.detail, { barcode: '123' });
    assert.ok(error instanceof Error);
});

test('CmcError rejects an unknown code', () => {
    assert.throws(() => new CmcError('nope', 'x'), /unknown code/);
});

test('every code maps to an http status', () => {
    for (const code of ERROR_CODES) {
        assert.equal(typeof httpStatusFor(code), 'number');
    }
});

test('an unmapped code falls back to 500', () => {
    assert.equal(httpStatusFor('not-a-code'), 500);
});
