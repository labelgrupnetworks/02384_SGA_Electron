const test = require('node:test');
const assert = require('node:assert/strict');
const { TcpLink } = require('../../src/scales/transport');
const { ScaleError } = require('../../src/scales/errors');
const { createLineScale, createRawScale } = require('../helpers/fake-scale');

const FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 120, totalMs: 1500 };

function linkTo(port, framing = FRAMING) {
    return new TcpLink({ host: '127.0.0.1', port, framing });
}

test('command devuelve la linea de respuesta sin el terminador', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('anade el terminador al enviar', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.command('S');
        assert.deepEqual(scale.received, ['S']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('reune una respuesta que llega partida en varias rafagas', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' }, { chunkSize: 2 });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('devuelve varias lineas cuando la respuesta es multilinea', async () => {
    const scale = await createLineScale({ I0: ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A'] });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('I0'), ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('silencio total devuelve array vacio, no un error', async () => {
    const scale = await createLineScale({ SI: null });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('SI'), []);
    } finally {
        link.close();
        await scale.close();
    }
});

test('varios comandos sobre una sola conexion no se mezclan', async () => {
    const scale = await createLineScale({ S: 'S S 1.000 kg', TA: 'TA A 0.050 kg', DW: 'DW A' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
        assert.deepEqual(await link.command('TA'), ['TA A 0.050 kg']);
        assert.deepEqual(await link.command('DW'), ['DW A']);
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('drena la cola de un comando anterior antes de enviar el siguiente', async () => {
    // La bascula contesta a SIR dos veces: la segunda linea llega tarde y sin
    // drenado se leeria como respuesta de S.
    const scale = await createLineScale({
        SIR: ['S D 0.500 kg', 'S D 0.600 kg'],
        S: 'S S 1.234 kg',
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.send('SIR');
        await new Promise((r) => setTimeout(r, 150));
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('totalMs corta una bascula que no calla nunca', async () => {
    const scale = await createRawScale((chunk, socket) => {
        const pump = () => {
            if (socket.destroyed) return;
            socket.write('S D 0.100 kg\r\n');
            setTimeout(pump, 20);
        };
        pump();
    });
    const link = linkTo(scale.port, { ...FRAMING, quietMs: 50, totalMs: 300 });
    try {
        await link.connect();
        const started = Date.now();
        const lines = await link.command('SIR');
        const elapsed = Date.now() - started;
        assert.ok(lines.length > 1, 'deberia haber leido varias lineas');
        assert.ok(elapsed < 1000, `tardo ${elapsed}ms, deberia cortar cerca de 300`);
    } finally {
        link.close();
        await scale.close();
    }
});

test('connect contra un puerto cerrado lanza ScaleError connect', async () => {
    const link = linkTo(1);
    await assert.rejects(() => link.connect(), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'connect');
        return true;
    });
});

test('si la bascula cierra a media lectura es error de protocolo', async () => {
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.2');
        setTimeout(() => socket.destroy(), 30);
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await assert.rejects(() => link.command('S'), (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        });
    } finally {
        link.close();
        await scale.close();
    }
});

test('close es idempotente y deja connected en false', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    await link.connect();
    assert.equal(link.connected, true);
    link.close();
    link.close();
    assert.equal(link.connected, false);
    await scale.close();
});

test('command reconecta solo si no hay socket', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        assert.equal(link.connected, false);
        assert.deepEqual(await link.command('S'), ['S S 0.000 kg']);
        assert.equal(link.connected, true);
    } finally {
        link.close();
        await scale.close();
    }
});

test('acepta \\r como terminador para modelos que lo usan', async () => {
    const scale = await createRawScale((chunk, socket) => {
        if (chunk.toString('latin1') === 'S\r') socket.write('S S 1.000 kg\r');
    });
    const link = linkTo(scale.port, { ...FRAMING, terminator: '\r' });
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});
