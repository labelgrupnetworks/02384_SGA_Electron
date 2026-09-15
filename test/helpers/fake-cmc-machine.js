const net = require('node:net');
const { frame, createFrameReader } = require('../../src/cmc/protocol');

/**
 * A stand-in for the CMC machine: accepts one connection, lets the test push
 * ENQ frames down it, and records every payload the bridge writes back.
 */
async function createFakeCmcMachine() {
    const received = [];
    const sockets = new Set();
    let onPayload = null;

    const server = net.createServer((socket) => {
        sockets.add(socket);
        const read = createFrameReader();
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => {
            for (const payload of read(chunk)) {
                received.push({ payload, at: Date.now() });
                if (onPayload) onPayload(payload);
            }
        });
    });

    const port = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    return {
        port,
        received,
        send(payload) {
            for (const socket of sockets) socket.write(frame(payload));
        },
        // Resolves with the next payload written by the bridge, or rejects on timeout.
        next(timeoutMs = 1000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { onPayload = null; reject(new Error('no reply')); }, timeoutMs);
                onPayload = (payload) => {
                    clearTimeout(timer);
                    onPayload = null;
                    resolve(payload);
                };
            });
        },
        dropConnection() {
            for (const socket of sockets) socket.destroy();
        },
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
        }),
    };
}

module.exports = { createFakeCmcMachine };
