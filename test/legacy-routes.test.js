const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { createRawScale } = require('./helpers/fake-scale');
const { registerLegacyRoutes } = require('../src/server/legacy-routes');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

async function startApp() {
    const app = express();
    app.use(cors());
    app.use(express.json());
    registerLegacyRoutes(app, silentLogger);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((r) => server.close(() => r())) };
}

function post(base, path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('scale-command exige ip, port y command', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', { ip: '127.0.0.1' });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'Faltan parámetros requeridos: ip, port, command');
    } finally {
        await app.close();
    }
});

test('scale-command anade CRLF y traduce <ETX> a 0x03', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK\r\n'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: '0<ETX>254<ETX>001<ETX>I!GX06',
        });
        const sent = Buffer.concat(scale.received).toString('latin1');
        assert.equal(sent, '0\x03254\x03001\x03I!GX06\r\n');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-command no duplica el CRLF si ya venia', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK\r\n'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: 'S\r\n',
        });
        assert.equal(Buffer.concat(scale.received).toString('latin1'), 'S\r\n');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-command re-escapa STX y ETX en la respuesta y conserva la cruda', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('\x02I!LV01\x03\r\n', 'latin1'));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: 'S',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.response, '<STX>I!LV01<ETX>');
        assert.equal(body.raw_response, '\x02I!LV01\x03');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex envia los bytes exactos sin anadir terminador', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write('OK'));
    const app = await startApp();
    try {
        await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: scale.port, hex: '30 03 41',
        });
        assert.deepEqual([...Buffer.concat(scale.received)], [0x30, 0x03, 0x41]);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex acepta el hex sin espacios y devuelve hex y ascii', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(Buffer.from([0x41, 0x03])));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: scale.port, hex: '300341',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.response_hex, '41 03');
        assert.equal(body.response_ascii, 'A\x03');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex rechaza longitud impar', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: 1, hex: '303',
        });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'HEX con longitud impar');
    } finally {
        await app.close();
    }
});

test('un puerto cerrado da 500 y success false', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: 1, command: 'S',
        });
        assert.equal(res.status, 500);
        assert.equal((await res.json()).success, false);
    } finally {
        await app.close();
    }
});

test('scale-command decodifica en ascii: el byte alto pierde el bit 7', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(Buffer.from([0x41, 0xE9, 0x42]), 'latin1'));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-command', {
            ip: '127.0.0.1', port: scale.port, command: 'S',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.raw_response, 'AiB');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex decodifica en latin1: preserva bytes altos', async () => {
    const scale = await createRawScale((chunk, socket) => socket.write(Buffer.from([0x41, 0xE9, 0x42])));
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', {
            ip: '127.0.0.1', port: scale.port, hex: '300341',
        });
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.response_ascii, 'A\xe9B');
        assert.equal(body.response_hex, '41 e9 42');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('scale-hex exige ip, port y hex', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale-hex', { ip: '127.0.0.1' });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error, 'Faltan parámetros requeridos: ip, port, hex');
    } finally {
        await app.close();
    }
});
