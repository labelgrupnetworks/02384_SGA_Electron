const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
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

test('deliveries to the same labeler are serialized, so two boxes cannot interleave on the wire', async () => {
    const machine = await createFakeCmcMachine();
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111'), entry('222')] });
    const results = [];
    let active = 0;
    let maxActive = 0;
    const order = [];
    const deliver = async (args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${args.content}`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`end:${args.content}`);
        active -= 1;
    };
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache,
        labelers: [{ host: '127.0.0.1', port: 9100 }], logger: silentLogger,
        onResult: (r) => results.push(r), deliver,
    });

    try {
        await client.start();
        machine.send('ENQ|111');
        // Give the first delivery time to be picked up and start its 50ms
        // wait, but not enough to finish it, before firing the second ENQ.
        await new Promise((r) => setTimeout(r, 10));
        machine.send('ENQ|222');
        await new Promise((r) => setTimeout(r, 150));

        assert.equal(maxActive, 1, 'the two deliveries to the same labeler must never overlap');
        assert.deepEqual(order, [
            'start:^XA111^XZ', 'end:^XA111^XZ',
            'start:^XA222^XZ', 'end:^XA222^XZ',
        ]);
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

test('an onResult that throws synchronously does not break the ENQ loop', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: () => { throw new Error('onResult boom'); },
        deliver: ctx.deliver,
    });

    try {
        await client.start();

        const first = machine.next();
        machine.send('ENQ|111');
        assert.equal(await first, buildEnqReply({ accepted: true }));

        // The synchronous throw must not have killed the loop: a second ENQ
        // is still answered. This is the property worth pinning, not merely
        // that the error got logged.
        const second = machine.next();
        machine.send('ENQ|111');
        assert.equal(await second, buildEnqReply({ accepted: true }));
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('an onResult that rejects asynchronously does not break the ENQ loop', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: async () => {
            await new Promise((r) => setTimeout(r, 10));
            throw new Error('onResult rejected');
        },
        deliver: ctx.deliver,
    });

    const unhandled = [];
    const onUnhandledRejection = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
        await client.start();

        const first = machine.next();
        machine.send('ENQ|111');
        assert.equal(await first, buildEnqReply({ accepted: true }));

        // Give the rejected promise time to surface, so we can confirm it was
        // swallowed by report()'s .catch rather than becoming an unhandled
        // rejection that could crash a long-running process.
        await new Promise((r) => setTimeout(r, 50));

        // The property worth pinning: the loop survives and answers the next
        // ENQ, not merely that the rejection got logged.
        const second = machine.next();
        machine.send('ENQ|111');
        assert.equal(await second, buildEnqReply({ accepted: true }));

        assert.equal(unhandled.length, 0, 'onResult rejection must not surface as an unhandled rejection');
    } finally {
        process.removeListener('unhandledRejection', onUnhandledRejection);
        await client.stop();
        await machine.close();
    }
});

test('the adopted socket has keepalive enabled, so a half-open link can be detected', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();

    // net.Socket has no public getter for its keepalive state, so the only way
    // to observe that connect() called setKeepAlive on the socket it actually
    // adopts is to intercept the call itself.
    const calls = [];
    const originalSetKeepAlive = net.Socket.prototype.setKeepAlive;
    net.Socket.prototype.setKeepAlive = function patchedSetKeepAlive(...args) {
        calls.push(args);
        return originalSetKeepAlive.apply(this, args);
    };

    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();

        assert.equal(calls.length, 1, 'setKeepAlive must be called exactly once, on the adopted socket');
        assert.deepEqual(calls[0], [true, 30_000]);
    } finally {
        net.Socket.prototype.setKeepAlive = originalSetKeepAlive;
        await client.stop();
        await machine.close();
    }
});

test('a missing machine address is routed through the normal reconnect path instead of throwing synchronously', async () => {
    const ctx = setup();
    const client = createMachineClient({
        host: undefined,
        port: undefined,
        cache: ctx.cache,
        labelers: ctx.labelers,
        logger: silentLogger,
        onResult: (r) => ctx.results.push(r),
        deliver: ctx.deliver,
        // Long enough that the scheduled retry does not fire before stop().
        reconnectMs: 10_000,
    });

    try {
        // start() must still reject (the caller gets to know the first attempt
        // failed), but the failure must be recorded the same way any other
        // connect failure is, not bypass it via a synchronous throw.
        await assert.rejects(() => client.start(), /invalid machine address/);

        const state = client.state();
        assert.equal(state.connected, false);
        assert.match(state.last_error, /invalid machine address/);
    } finally {
        await client.stop();
    }
});

test('the client reconnects on its own after the connection drops', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();
    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
        reconnectMs: 100,
    });

    try {
        await client.start();
        assert.equal(client.state().connected, true);

        machine.dropConnection();
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(client.state().connected, false);

        // Wait past reconnectMs for the scheduled attempt to land, then prove
        // the reconnect is real (the fake machine accepted a fresh connection
        // and answers ENQ again), not merely that connected flipped back to
        // true by accident.
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(client.state().connected, true);

        const pending = machine.next();
        machine.send('ENQ|111');
        assert.equal(await pending, buildEnqReply({ accepted: true }));
    } finally {
        await client.stop();
        await machine.close();
    }
});

test('a transient runtime error does not leave state() reporting a stale last_error once traffic resumes', async () => {
    const machine = await createFakeCmcMachine();
    const ctx = setup();

    // Capture the socket connect() creates and adopts, so a transient
    // 'error' event can be simulated directly on it, without needing to
    // break the real TCP connection underneath.
    let capturedSocket = null;
    const originalConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function patchedConnect(...args) {
        capturedSocket = this;
        return originalConnect.apply(this, args);
    };

    const client = createMachineClient({
        host: '127.0.0.1', port: machine.port, cache: ctx.cache,
        labelers: ctx.labelers, logger: silentLogger,
        onResult: (r) => ctx.results.push(r), deliver: ctx.deliver,
    });

    try {
        await client.start();
        net.Socket.prototype.connect = originalConnect;
        assert.ok(capturedSocket, 'the adopted socket must have been captured');

        capturedSocket.emit('error', new Error('synthetic runtime error'));

        // The error alone must not be mistaken for the connection going
        // down: it is recorded, but connected stays true.
        assert.equal(client.state().connected, true);
        assert.match(client.state().last_error, /synthetic runtime error/);

        // Real traffic is the proof the link is healthy again; the stale
        // error must not keep haunting state() once that is established.
        const pending = machine.next();
        machine.send('ENQ|111');
        await pending;

        assert.equal(client.state().last_error, null);
    } finally {
        net.Socket.prototype.connect = originalConnect;
        await client.stop();
        await machine.close();
    }
});
