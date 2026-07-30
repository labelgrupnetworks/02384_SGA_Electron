const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createRawScale, createLineScale } = require('./fake-scale');

function talk(port, payload, { waitMs = 200 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(port, '127.0.0.1');
        let received = Buffer.alloc(0);
        socket.on('connect', () => socket.write(payload, 'latin1'));
        socket.on('data', (d) => { received = Buffer.concat([received, d]); });
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); resolve(received.toString('latin1')); }, waitMs);
    });
}

test('createRawScale entrega los bytes exactos que recibe', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(chunk));
    try {
        const reply = await talk(scale.port, Buffer.from([0x30, 0x03, 0x41]));
        assert.equal(reply, '0\x03A');
        assert.equal(scale.received.length, 1);
        assert.deepEqual([...scale.received[0]], [0x30, 0x03, 0x41]);
    } finally {
        await scale.close();
    }
});

test('createLineScale responde segun el primer token de la linea', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg', I2: 'I2 A "ICS425-BW 3.0045 kg"' });
    try {
        assert.equal(await talk(scale.port, 'S\r\n'), 'S S 1.234 kg\r\n');
        assert.deepEqual(scale.received, ['S']);
    } finally {
        await scale.close();
    }
});

test('createLineScale devuelve varias lineas cuando el valor es un array', async () => {
    const scale = await createLineScale({ I0: ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A'] });
    try {
        assert.equal(await talk(scale.port, 'I0\r\n'), 'I0 B 1 "S"\r\nI0 B 2 "T"\r\nI0 A\r\n');
    } finally {
        await scale.close();
    }
});

test('createLineScale no contesta nada cuando el valor es null', async () => {
    const scale = await createLineScale({ SI: null });
    try {
        assert.equal(await talk(scale.port, 'SI\r\n', { waitMs: 120 }), '');
        assert.deepEqual(scale.received, ['SI']);
    } finally {
        await scale.close();
    }
});

test('chunkSize parte la respuesta sin cambiar el contenido', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' }, { chunkSize: 3 });
    try {
        assert.equal(await talk(scale.port, 'S\r\n', { waitMs: 400 }), 'S S 1.234 kg\r\n');
    } finally {
        await scale.close();
    }
});
