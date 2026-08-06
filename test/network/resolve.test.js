// test/network/resolve.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocalIp } = require('../../src/network/resolve');

function ipv4(address, internal = false) {
    return { address, family: 'IPv4', internal, netmask: '255.255.255.0' };
}

function storeWith(config) {
    return { read: () => config };
}

const TWO = {
    lo: [ipv4('127.0.0.1', true)],
    enp0s31f6: [ipv4('192.168.0.47')],
    wlp0s20f3: [ipv4('192.168.0.225')],
    lerd0: [ipv4('192.0.2.1')],
};

test('a saved interface that still has an address is used', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'enp0s31f6' }),
    });

    assert.equal(result.status, 'configured');
    assert.equal(result.ip, '192.168.0.47');
    assert.equal(result.interface, 'enp0s31f6');
});

test('a single candidate is used without asking and without saving', () => {
    const writes = [];
    const store = { read: () => ({}), write: (c) => writes.push(c) };

    const result = resolveLocalIp({
        interfaces: { lo: [ipv4('127.0.0.1', true)], eth0: [ipv4('10.0.0.9')] },
        store,
    });

    assert.equal(result.status, 'single');
    assert.equal(result.ip, '10.0.0.9');
    assert.equal(result.interface, 'eth0');
    // Saving it would turn a default into a decision nobody made: if a second
    // interface appears tomorrow, the operator should be asked.
    assert.deepEqual(writes, []);
});

test('two or more candidates with nothing saved is not configured', () => {
    const result = resolveLocalIp({ interfaces: TWO, store: storeWith({}) });

    assert.equal(result.status, 'not_configured');
    assert.equal(result.ip, null);
    assert.deepEqual(result.candidates, [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ]);
});

test('a saved interface that no longer exists is stale, and says which', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'usb0' }),
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.ip, null);
    assert.equal(result.savedInterface, 'usb0');
    assert.equal(result.candidates.length, 2);
});

test('a saved interface that exists but was filtered out is also stale', () => {
    // lerd0 is present on the machine but excluded as a candidate, so a settings
    // file naming it must not resolve to 192.0.2.1.
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 'lerd0' }),
    });

    assert.equal(result.status, 'stale');
    assert.equal(result.ip, null);
    assert.equal(result.savedInterface, 'lerd0');
});

test('no candidates at all is no_network, with an empty list', () => {
    const result = resolveLocalIp({
        interfaces: { lo: [ipv4('127.0.0.1', true)], lerd0: [ipv4('192.0.2.1')] },
        store: storeWith({}),
    });

    assert.equal(result.status, 'no_network');
    assert.equal(result.ip, null);
    assert.deepEqual(result.candidates, []);
});

test('no interfaces whatsoever is no_network', () => {
    const result = resolveLocalIp({ interfaces: {}, store: storeWith({}) });

    assert.equal(result.status, 'no_network');
    assert.deepEqual(result.candidates, []);
});

test('a saved interface wins even when new candidates appear', () => {
    const withThree = { ...TWO, usb0: [ipv4('10.5.5.5')] };

    const result = resolveLocalIp({
        interfaces: withThree,
        store: storeWith({ interface: 'wlp0s20f3' }),
    });

    assert.equal(result.status, 'configured');
    assert.equal(result.ip, '192.168.0.225');
});

test('a saved interface wins even when it is the only candidate', () => {
    const result = resolveLocalIp({
        interfaces: { eth0: [ipv4('10.0.0.9')] },
        store: storeWith({ interface: 'eth0' }),
    });

    assert.equal(result.status, 'configured');
});

test('a store that returns a non-string interface is treated as unsaved', () => {
    const result = resolveLocalIp({
        interfaces: TWO,
        store: storeWith({ interface: 42 }),
    });

    assert.equal(result.status, 'not_configured');
});

test('when a saved interface has several addresses the first candidate wins', () => {
    const result = resolveLocalIp({
        interfaces: { eth0: [ipv4('192.168.0.47'), ipv4('10.0.0.9')] },
        store: storeWith({ interface: 'eth0' }),
    });

    assert.equal(result.ip, '192.168.0.47');
});
