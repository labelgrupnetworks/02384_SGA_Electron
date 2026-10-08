const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { createMachineClient } = require('../../src/cmc/machine-client');
const { frame, parseMessage } = require('../../src/cmc/protocol');

const silentLogger = {info() {}, warn() {}, error() {}};

/**
 * The whole machine cycle, driven over a real socket.
 *
 * The frames come from CMCDPsim, captured on 2026-10-08: ENQ, IND, ACK, LAB1,
 * END and HBT. The bridge answered exactly one of them and everything else fell
 * into "unhandled message type", which for LAB1 means the machine rejects the
 * box when the label never appears under the tamper.
 */
function startMachine() {
    const replies = [];
    let machineSocket = null;
    const server = net.createServer((socket) => {
        machineSocket = socket;

        // Frames can share a TCP segment, so they are split on the delimiters
        // rather than assumed one per chunk.
        socket.on('data', (chunk) => {
            for (const part of chunk.toString('latin1').split('\x03')) {
                const payload = part.replace('\x02', '');
                if (payload.length > 0) replies.push(payload);
            }
        });
    });

    return {
        replies,
        listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
        close: () => new Promise((resolve) => server.close(resolve)),
        send: (payload) => machineSocket.write(frame(payload)),
        connected: () => machineSocket !== null,
    };
}

const entry = {
    barcode: 'IT0001',
    label_payloads: [{content_base64: Buffer.from('^XA^XZ', 'latin1').toString('base64')}],
};

const cacheWith = (found) => ({
    lookup: () => (found ? entry : null),
    markDispatched() {},
    state: () => ({batch_id: 'batch-1'}),
});

/** Waits until `check()` holds, rather than guessing at a sleep. */
async function until(check, what) {
    for (let attempt = 0; attempt < 300; attempt++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
}

async function withBridge({found = true, labelers = [{host: '127.0.0.1', port: 9100}]}, run) {
    const machine = startMachine();
    const port = await machine.listen();
    const delivered = [];

    const client = createMachineClient({
        host: '127.0.0.1',
        port,
        cache: cacheWith(found),
        labelers,
        logger: silentLogger,
        deliver: async (options) => {
            delivered.push(options);
        },
    });

    await client.start();
    await until(() => machine.connected(), 'the bridge to connect');

    try {
        await run({machine, delivered});
    } finally {
        await client.stop();
        await machine.close();
    }
}

test('every message the machine sends gets its reply', async () => {
    await withBridge({}, async ({machine}) => {
        machine.send('0001|ENQ|1|IT0001|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        // The machine replicates the reference the CIS assigned, so the rest of
        // the cycle carries ours rather than one of its own.
        const reference = parseMessage(machine.replies[0]).fields[0];

        machine.send(`0001|IND|2|${reference}|`);
        machine.send(`0001|ACK|3|${reference}|1|0|80|200|250|2200|`);
        machine.send(`0001|LAB1|4|${reference}|1|0|2200|150|680|1000000`);
        machine.send(`0001|END|5|${reference}|1|0|80|200|250|2200|150|680|0|`);
        machine.send('0001|HBT');

        await until(() => machine.replies.length >= 6, 'a reply to every message');

        assert.deepStrictEqual(
            machine.replies.slice(0, 6).map((reply) => parseMessage(reply).type),
            ['enq', 'ind', 'ack', 'lab1', 'end', 'hbt'],
        );
    });
});

test('the enq reply assigns a reference instead of leaving it empty', async () => {
    await withBridge({}, async ({machine}) => {
        machine.send('0001|ENQ|1|IT0001|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        const reply = parseMessage(machine.replies[0]);

        // Empty is what this used to send, and it leaves the whole cycle with no
        // identifier of ours to match a LAB1 back to the box it belongs to.
        assert.notStrictEqual(reply.fields[0], '');
        assert.ok(reply.fields[0].length > 0, 'MSG_REFERENCE must be assigned');
    });
});

test('the label goes to the labeller on LAB1, not on the ENQ', async () => {
    await withBridge({}, async ({machine, delivered}) => {
        machine.send('0001|ENQ|1|IT0001|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        // The protocol has the CIS send the label when LAB1 arrives, which is
        // when the box is in front of the labeller. Sending it at ENQ time is
        // early by a whole conveyor.
        assert.deepStrictEqual(delivered, [], 'nothing may be delivered on the ENQ');

        const reference = parseMessage(machine.replies[0]).fields[0];
        machine.send(`0001|LAB1|4|${reference}|1|0|2200|150|680|1000000`);

        await until(() => delivered.length === 1, 'the label to reach the labeller');
        assert.strictEqual(delivered[0].content, '^XA^XZ');
    });
});

test('lab1 declares the barcode the reader will compare against', async () => {
    await withBridge({}, async ({machine}) => {
        machine.send('0001|ENQ|1|IT0001|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        const reference = parseMessage(machine.replies[0]).fields[0];
        machine.send(`0001|LAB1|4|${reference}|1|0|2200|150|680|1000000`);
        await until(() => machine.replies.length >= 2, 'the lab1 reply');

        // Without MSG_MATCH_LAB1 the reader after the labeller has nothing to
        // compare the printed code against, and the box is rejected.
        assert.strictEqual(parseMessage(machine.replies[1]).fields[2], 'IT0001');
    });
});

test('a box the manifest does not hold is answered, and nothing is delivered', async () => {
    await withBridge({found: false}, async ({machine, delivered}) => {
        machine.send('0001|ENQ|1|NOPE|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        machine.send('0001|LAB1|4|whatever|1|0|2200|150|680|1000000');
        await until(() => machine.replies.length >= 2, 'the lab1 reply');

        // MSG_RESULT 0: the sending cycle did not start. Claiming otherwise
        // would have the machine wait for a label that is never coming.
        const lab1 = parseMessage(machine.replies[1]);

        assert.strictEqual(lab1.type, 'lab1');
        assert.strictEqual(lab1.fields[1], '0');
        assert.deepStrictEqual(delivered, []);
    });
});

test('a LAB1 with no labeller configured still answers the machine', async () => {
    await withBridge({labelers: []}, async ({machine, delivered}) => {
        machine.send('0001|ENQ|1|IT0001|');
        await until(() => machine.replies.length >= 1, 'the enq reply');

        const reference = parseMessage(machine.replies[0]).fields[0];
        machine.send(`0001|LAB1|4|${reference}|1|0|2200|150|680|1000000`);
        await until(() => machine.replies.length >= 2, 'the lab1 reply');

        assert.strictEqual(parseMessage(machine.replies[1]).fields[1], '0');
        assert.deepStrictEqual(delivered, []);
    });
});
