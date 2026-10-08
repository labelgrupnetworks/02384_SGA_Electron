const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { createMachineClient } = require('../../src/cmc/machine-client');
const { frame, parseMessage } = require('../../src/cmc/protocol');

const silentLogger = {info() {}, warn() {}, error() {}};

/**
 * What the bridge reports for a box it never answered.
 *
 * Only the ENQ carries a barcode; every later message of the cycle carries the
 * reference instead. For a box that was not in the manifest there is no
 * reference held, so there is no barcode to report either — and Verentia
 * requires one. Reporting an empty string had the whole batch refused with 422,
 * taking four valid results down with it, and retried for as long as the bridge
 * was up (observed 2026-10-08).
 */
async function machineOn(run) {
    let machineSocket = null;
    const replies = [];
    const results = [];

    const server = net.createServer((socket) => {
        machineSocket = socket;
        socket.on('data', (chunk) => {
            for (const part of chunk.toString('latin1').split('\x03')) {
                const payload = part.replace('\x02', '');
                if (payload.length > 0) replies.push(payload);
            }
        });
    });

    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

    const client = createMachineClient({
        host: '127.0.0.1',
        port,
        cache: {lookup: () => null, markDispatched() {}, state: () => ({batch_id: 'B1'})},
        labelers: [{host: '127.0.0.1', port: 9100}],
        logger: silentLogger,
        onResult: (result) => results.push(result),
        deliver: async () => {},
    });

    await client.start();

    for (let attempt = 0; attempt < 200 && machineSocket === null; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    try {
        await run({send: (payload) => machineSocket.write(frame(payload)), replies, results});
    } finally {
        await client.stop();
        await new Promise((resolve) => server.close(resolve));
    }
}

test('nothing is reported without a barcode the backend will accept', async () => {
    await machineOn(async ({send, results}) => {
        send('0001|ACK|3|ref-we-never-issued|1|0|80|200|250|2200|');
        send('0001|END|5|ref-we-never-issued|1|0|80|200|250|2200|150|680|0|');
        await new Promise((resolve) => setTimeout(resolve, 100));

        for (const result of results) {
            assert.notEqual(result.barcode, '', `${result.phase} reported an empty barcode`);
        }
    });
});

test('the machine is still answered, whatever we know about the box', async () => {
    // Staying quiet is not an option: an unanswered LAB1 has the machine reject
    // the box, and an unanswered ACK leaves the cycle hanging.
    await machineOn(async ({send, replies}) => {
        send('0001|ACK|3|ref-we-never-issued|1|0|80|200|250|2200|');
        send('0001|LAB1|4|ref-we-never-issued|1|0|2200|150|680|1000000');
        send('0001|END|5|ref-we-never-issued|1|0|80|200|250|2200|150|680|0|');

        for (let attempt = 0; attempt < 200 && replies.length < 3; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        assert.deepEqual(
            replies.slice(0, 3).map((reply) => parseMessage(reply).type),
            ['ack', 'lab1', 'end'],
        );
    });
});

test('an ENQ for an unknown box still reports: it has a barcode', async () => {
    // This one is worth keeping. The machine is holding a box the manifest does
    // not have, and the barcode is right there in the ENQ.
    await machineOn(async ({send, results}) => {
        send('0001|ENQ|1|NOT-IN-BATCH|');
        await new Promise((resolve) => setTimeout(resolve, 100));

        const reported = results.find((result) => result.phase === 'enq');

        assert.equal(reported.barcode, 'NOT-IN-BATCH');
        assert.equal(reported.status, 'unknown');
    });
});
