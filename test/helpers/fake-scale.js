const net = require('node:net');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function closer(server, sockets) {
    return () => new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
    });
}

async function createRawScale(onData) {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => {
            received.push(Buffer.from(chunk));
            if (onData) onData(chunk, socket);
        });
    });
    const port = await listen(server);
    return { port, received, close: closer(server, sockets) };
}

function writeChunked(socket, text, chunkSize) {
    const payload = Buffer.from(text, 'latin1');
    if (!chunkSize) {
        socket.write(payload);
        return;
    }
    let offset = 0;
    const pump = () => {
        if (offset >= payload.length || socket.destroyed) return;
        socket.write(payload.subarray(offset, offset + chunkSize));
        offset += chunkSize;
        setTimeout(pump, 10);
    };
    pump();
}

async function createLineScale(table, { chunkSize = 0, delayMs = 0 } = {}) {
    const received = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', (chunk) => {
            buffer += chunk.toString('latin1');
            let index;
            while ((index = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                if (!line) continue;
                received.push(line);
                const key = line.trim().split(/\s+/)[0];
                let reply = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 'ES';
                if (typeof reply === 'function') reply = reply(line);
                if (reply === null || reply === undefined) continue;
                const lines = Array.isArray(reply) ? reply : [reply];
                const text = lines.map((l) => `${l}\r\n`).join('');
                if (delayMs) setTimeout(() => writeChunked(socket, text, chunkSize), delayMs);
                else writeChunked(socket, text, chunkSize);
            }
        });
    });
    const port = await listen(server);
    return { port, received, close: closer(server, sockets) };
}

module.exports = { createRawScale, createLineScale };
