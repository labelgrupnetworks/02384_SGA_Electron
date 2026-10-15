const test = require('node:test');
const assert = require('node:assert/strict');
const { manifestUrlFrom } = require('../../src/cmc/manifest-url');

// The station is configured with the results endpoint, because that is the one
// the bridge posts to on its own. Asking Verentia about an order needs its
// sibling, and making someone type a second URL that is always the first with
// one word changed is a way to get one of them wrong.

test('it swaps the last segment for manifests', () => {
    assert.equal(
        manifestUrlFrom('http://sga-pal.fedefarma.com/api/v1/cmc/results'),
        'http://sga-pal.fedefarma.com/api/v1/cmc/manifests',
    );
});

test('it keeps the host, the scheme and the port', () => {
    assert.equal(
        manifestUrlFrom('http://10.200.10.11:8080/api/v1/cmc/results'),
        'http://10.200.10.11:8080/api/v1/cmc/manifests',
    );
});

test('a trailing slash does not produce an empty segment', () => {
    assert.equal(
        manifestUrlFrom('http://verentia.test/api/v1/cmc/results/'),
        'http://verentia.test/api/v1/cmc/manifests',
    );
});

test('a query string is dropped rather than carried into the new path', () => {
    assert.equal(
        manifestUrlFrom('http://verentia.test/api/v1/cmc/results?debug=1'),
        'http://verentia.test/api/v1/cmc/manifests',
    );
});

test('an unconfigured or unparseable endpoint yields null rather than a guess', () => {
    // The dialog says "configura primero la URL de Verentia" instead of posting
    // an order number somewhere unintended.
    assert.equal(manifestUrlFrom(''), null);
    assert.equal(manifestUrlFrom(null), null);
    assert.equal(manifestUrlFrom('no es una url'), null);
});
