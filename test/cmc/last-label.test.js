const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachineClient } = require('../../src/cmc/machine-client');

const silent = { info() {}, warn() {}, error() {} };

const entry = {
    barcode: '2620-2595156',
    label_payloads: [{ content_base64: Buffer.from('^XA^FDhola^FS^XZ').toString('base64') }],
};

/**
 * The client is built without starting it: these tests exercise label delivery
 * only, which never touches the machine socket.
 */
function clientWith(deliver, labelers = [{ host: '127.0.0.1', port: 9100 }]) {
    return createMachineClient({
        host: '10.0.0.1',
        port: 12001,
        cache: { lookup: () => entry, state: () => ({ batch_id: null }) },
        labelers,
        logger: silent,
        onResult: () => {},
        deliver,
    });
}

test('a station that has printed nothing says so', () => {
    const client = clientWith(async () => {});

    assert.equal(client.state().last_label, null);
});

test('a delivered label is remembered with where it went and which box it was', async () => {
    const client = clientWith(async () => {});

    await client.deliverLabels(entry);

    const label = client.state().last_label;
    assert.equal(label.barcode, '2620-2595156');
    assert.equal(label.target, '127.0.0.1:9100');
    assert.equal(label.ok, true);
    assert.equal(label.error, null);
    assert.ok(label.at, 'a delivered label left no timestamp');
});

test('a labeller that refuses the connection is remembered as a failure', async () => {
    // The panel's whole purpose: without this, a labeller that has been
    // unplugged since the morning looks identical to a quiet shift.
    const client = clientWith(async () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:9100');
        error.code = 'ECONNREFUSED';
        throw error;
    });

    await client.deliverLabels(entry);

    const label = client.state().last_label;
    assert.equal(label.ok, false);
    assert.match(label.error, /ECONNREFUSED/);
    assert.equal(label.barcode, '2620-2595156');
});

test('having no labeller configured is recorded as its own failure', async () => {
    const client = clientWith(async () => {}, []);

    await client.deliverLabels(entry);

    const label = client.state().last_label;
    assert.equal(label.ok, false);
    assert.match(label.error, /etiquetadora/i);
});
