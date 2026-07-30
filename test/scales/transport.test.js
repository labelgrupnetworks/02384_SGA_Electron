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

test('dos comandos simultaneos sobre el mismo link: exactamente uno se lleva la linea, el otro se queda vacio', async () => {
    // La bascula solo contesta al primer envio que le llega; cualquier envio
    // posterior no recibe respuesta. Decision de diseno (a falta de otra senal
    // para desempatar): cuando dos _readLines() solapados compiten por la misma
    // linea, exactamente una de las dos llamadas debe quedarsela intacta y la
    // otra debe resolver [] -- igual que "la bascula no contesto a esta". Lo que
    // NUNCA debe pasar es que ambas la vean (duplicado) o que ninguna la vea
    // (perdida) o que llegue partida entre las dos.
    let replied = false;
    const scale = await createRawScale((chunk, socket) => {
        if (!replied) {
            replied = true;
            socket.write('S S 1.234 kg\r\n');
        }
    });
    const link = linkTo(scale.port, { ...FRAMING, quietMs: 30, totalMs: 200 });
    try {
        await link.connect();
        const [a, b] = await Promise.all([link.command('S'), link.command('S')]);
        const results = [a, b];
        const withLine = results.filter((r) => r.length > 0);
        const empty = results.filter((r) => r.length === 0);
        assert.equal(withLine.length, 1, 'exactamente una de las dos llamadas debe llevarse la linea');
        assert.deepEqual(withLine[0], ['S S 1.234 kg']);
        assert.equal(empty.length, 1, 'la otra debe quedarse vacia, no con una mezcla ni un duplicado');
        assert.deepEqual(empty[0], []);
    } finally {
        link.close();
        await scale.close();
    }
});

test('close() a media lectura resuelve enseguida y conserva lo ya recibido, sin unhandledRejection', async () => {
    // La bascula contesta una vez y luego calla. Se llama a close() mientras el
    // comando todavia esta en su hueco de silencio (quietMs=300, muy por debajo
    // de totalMs=3000). Debe resolver ya, con la linea que ya habia llegado
    // (close() cancela la lectura, no la descarta), y sin dejar escapar ningun
    // unhandledRejection (una cancelacion nunca debe rechazar).
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.234 kg\r\n');
    });
    const framing = { terminator: '\r\n', encoding: 'latin1', quietMs: 300, totalMs: 3000 };
    const link = linkTo(scale.port, framing);

    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);

    try {
        await link.connect();
        const started = Date.now();
        const pending = link.command('S');
        await new Promise((r) => setTimeout(r, 40)); // deja que la linea llegue y se acumule
        link.close();
        const lines = await pending;
        const elapsed = Date.now() - started;
        assert.deepEqual(lines, ['S S 1.234 kg'], 'close() no deberia tirar lo ya recibido');
        assert.ok(elapsed < 200, `tardo ${elapsed}ms, deberia resolver al cerrar (no agotar totalMs=3000 ni quietMs=300)`);
        await new Promise((r) => setTimeout(r, 20)); // deja aflorar un unhandledRejection tardio si lo hubiera
        assert.equal(unhandled, null, 'una lectura cancelada por close() no deberia rechazar nunca');
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await scale.close();
    }
});
