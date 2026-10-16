const test = require('node:test');
const assert = require('node:assert/strict');
const { isTargetAlreadyLinked } = require('../../src/cmc/already-connected');

// Probing an address the driver already holds is both pointless and
// misleading: we know it is reachable, and the probe opens a SECOND socket.
// The CMC simulator accepts one client, so that second socket is refused and
// the button reports "no responde" about a machine that is working - which in
// a warehouse reads as "the machine is down".

test('an address the driver is connected to is reported as linked', () => {
    const state = { connected: true, address: '172.18.224.1:12001' };

    assert.equal(isTargetAlreadyLinked(state, { host: '172.18.224.1', port: 12001 }), true);
});

test('a different address is not', () => {
    const state = { connected: true, address: '172.18.224.1:12001' };

    assert.equal(isTargetAlreadyLinked(state, { host: '10.200.230.10', port: 8705 }), false);
    assert.equal(isTargetAlreadyLinked(state, { host: '172.18.224.1', port: 9100 }), false);
});

test('a driver that is not connected does not claim the address', () => {
    const state = { connected: false, address: '172.18.224.1:12001' };

    assert.equal(isTargetAlreadyLinked(state, { host: '172.18.224.1', port: 12001 }), false);
});

test('no driver at all is not a link', () => {
    assert.equal(isTargetAlreadyLinked(null, { host: '172.18.224.1', port: 12001 }), false);
    assert.equal(isTargetAlreadyLinked(undefined, { host: 'x', port: 1 }), false);
});

test('the port is compared as a number, not as text', () => {
    // The dialog hands over whatever is in the field.
    const state = { connected: true, address: '172.18.224.1:12001' };

    assert.equal(isTargetAlreadyLinked(state, { host: '172.18.224.1', port: '12001' }), true);
});
