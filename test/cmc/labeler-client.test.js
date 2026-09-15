const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { sendZpl } = require('../../src/cmc/labeler-client');

async function createFakeLabeler() {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => received.push(chunk.toString('latin1')));
    });
    const port = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    return {
        port,
        received,
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

test('sendZpl writes the payload to the labeler', async () => {
    const labeler = await createFakeLabeler();
    try {
        await sendZpl({ host: '127.0.0.1', port: labeler.port, content: '^XA^FDhi^FS^XZ' });

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(labeler.received.join(''), '^XA^FDhi^FS^XZ');
    } finally {
        await labeler.close();
    }
});

test('sendZpl rejects with a peripheral error when nobody is listening', async () => {
    await assert.rejects(
        () => sendZpl({ host: '127.0.0.1', port: 1, content: '^XA^XZ' }),
        (error) => error.code === 'peripheral',
    );
});

test('sendZpl rejects with a timeout when the connection never completes', async () => {
    // 203.0.113.0/24 is TEST-NET-3: routable-looking but black-holed.
    await assert.rejects(
        () => sendZpl({ host: '203.0.113.1', port: 9100, content: '^XA^XZ', timeoutMs: 150 }),
        (error) => error.code === 'timeout' || error.code === 'peripheral',
    );
});

test('sendZpl validates its arguments', async () => {
    await assert.rejects(() => sendZpl({ host: '', port: 9100, content: 'x' }), /host/);
    await assert.rejects(() => sendZpl({ host: '127.0.0.1', port: 0, content: 'x' }), /port/);
    await assert.rejects(() => sendZpl({ host: '127.0.0.1', port: 9100, content: '' }), /content/);
    await assert.rejects(() => sendZpl(), (error) => error.code === 'peripheral');
    await assert.rejects(() => sendZpl(null), (error) => error.code === 'peripheral');
});
