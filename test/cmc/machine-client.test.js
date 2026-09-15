const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeCmcMachine } = require('../helpers/fake-cmc-machine');
const { createManifestCache } = require('../../src/cmc/manifest-cache');
const { createMachineClient } = require('../../src/cmc/machine-client');
const { parseMessage, buildEnqReply } = require('../../src/cmc/protocol');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

const entry = (barcode) => ({
    barcode,
    label_payloads: [{
        content_base64: Buffer.from(`^XA${barcode}^XZ`).toString('base64'),
        content_type: 'application/zpl',
        filename: `${barcode}.zpl`,
    }],
});

function setup({ deliver, labelers = [{ host: '127.0.0.1', port: 9100 }] } = {}) {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111')] });
    const results = [];
    return { cache, results, deliver: deliver ?? (async () => {}), labelers };
}

test('an ENQ for a known barcode is accepted', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        const pending = machine.next();
        machine.send('ENQ|111');

        assert.equal(await pending, buildEnqReply({ accepted: true }));
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('an ENQ for an unknown barcode is rejected and reported', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        const pending = machine.next();
        machine.send('ENQ|999');

        assert.equal(await pending, buildEnqReply({ accepted: false }));
        await new Promise((r) => setTimeout(r, 50));
        const reported = ctx.results.find((r) => r.barcode === '999');
        assert.equal(reported.status, 'unknown');
        assert.equal(reported.phase, 'enq');
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('the ENQ reply is not delayed by a slow labeler', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup({ deliver: () => new Promise((r) => setTimeout(r, 800)) });
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        const startedAt = Date.now();
        const pending = machine.next();
        machine.send('ENQ|111');
        await pending;

        // The whole point of the design: the cache lookup answers, delivery waits.
        assert.ok(Date.now() - startedAt < 500, 'reply must beat the 500ms budget');
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('a known barcode is dispatched to its labeler and reported', async () => {
    const machine = await createFakeCmcMachine();
    const delivered = [];
    const ctx = setup({ deliver: async (args) => { delivered.push(args); } });
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        machine.send('ENQ|111');
        await new Promise((r) => setTimeout(r, 100));

        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].content, '^XA111^XZ');
        assert.equal(delivered[0].port, 9100);
        const reported = ctx.results.find((r) => r.phase === 'enq' && r.barcode === '111');
        assert.equal(reported.status, 'accepted');
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('a labeler failure is reported as an error without breaking the loop', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup({ deliver: async () => { throw new Error('printer on fire'); } });
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        machine.send('ENQ|111');
        await new Promise((r) => setTimeout(r, 100));

        assert.ok(ctx.results.some((r) => r.status === 'error' && r.phase === 'deliver'));

        // The connection survives: a second ENQ still gets answered.
        const pending = machine.next();
        machine.send('ENQ|111');
        assert.equal(await pending, buildEnqReply({ accepted: true }));
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('an ACK is reported for traceability', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        machine.send('ACK|111|REJECTED_SIZE');
        await new Promise((r) => setTimeout(r, 50));

        const reported = ctx.results.find((r) => r.phase === 'ack');
        assert.equal(reported.barcode, '111');
        assert.deepEqual(reported.detail.fields, ['111', 'REJECTED_SIZE']);
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('state reflects the connection going down', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
        reconnectMs: 10_000,
    });

    try {
        await client.start();
        assert.equal(client.state().connected, true);

        machine.dropConnection();
        await new Promise((r) => setTimeout(r, 100));

        assert.equal(client.state().connected, false);
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('stop() during an in-flight handshake prevents the connection from being adopted', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        // Deliberately not awaited: stop() must land while the TCP handshake
        // is still in flight. Node's event loop guarantees the handshake's
        // connect callback cannot fire until this synchronous block finishes,
        // so calling stop() right here (before awaiting anything) is a
        // deterministic way to land inside that window, not a sleep-and-hope.
        const started = client.start();
        await client.stop();

        // A stopped client must never leave a caller of start() hanging.
        await started;

        assert.equal(client.state().connected, false);

        // Give the handshake every chance to land and be wrongly adopted
        // anyway (the defect this guards against: a completed handshake
        // silently reconnecting a client that was told to stop).
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(client.state().connected, false);
    } finally {
        await client.stop();
        await machine.close();
    }
});
