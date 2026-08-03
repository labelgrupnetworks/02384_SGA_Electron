const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/mettler-toledo');
const { TcpLink } = require('../../src/scales/transport');
const { createLineScale, createRawScale } = require('../helpers/fake-scale');
const { ScaleError } = require('../../src/scales/errors');

async function withScale(table, fn) {
    const scale = await createLineScale(table);
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        return await fn(link, scale);
    } finally {
        link.close();
        await scale.close();
    }
}

test('el driver se identifica con el id que usa el SGA', () => {
    assert.equal(driver.id, 'mettler_toledo');
    assert.equal(driver.defaultPort, 4305);
});

test('beep y selectPlatform son dependientes del equipo, no garantizadas', () => {
    assert.deepEqual(driver.deviceDependent.sort(), ['beep', 'selectPlatform']);
    assert.ok(!driver.capabilities.includes('beep'));
    assert.ok(!driver.capabilities.includes('selectPlatform'));
});

test('weigh pide S y TA, y calcula el bruto', async () => {
    const result = await withScale({
        S: 'S S 1.234 kg',
        TA: 'TA A 0.050 kg',
    }, async (link, scale) => {
        const res = await driver.weigh(link);
        assert.deepEqual(scale.received, ['S', 'TA']);
        return res;
    });

    assert.deepEqual(result.data.net, { value: 1234, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 50, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 1284, unit: 'g' });
    assert.equal(result.data.stable, true);
    assert.deepEqual(result.raw, ['S S 1.234 kg', 'TA A 0.050 kg']);
});

test('weigh marca stable false con estado D', async () => {
    const result = await withScale({
        S: 'S D 0.700 kg',
        TA: 'TA A 0.000 kg',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, false);
    assert.deepEqual(result.data.gross, { value: 700, unit: 'g' });
});

test('weigh propaga la sobrecarga', async () => {
    await assert.rejects(
        () => withScale({ S: 'S +' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'overload');
            return true;
        },
    );
});

test('weigh falla como protocol si S contesta algo que no es un peso', async () => {
    await assert.rejects(
        () => withScale({ S: 'S A' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('weigh no atribuye a TA una respuesta S que llega tarde (reproduce C1 de la revision final)', async () => {
    // Escenario reproducido por el revisor: un equipo que repite su respuesta
    // "S" (p.ej. dejado en modo streaming SIR/SR) la deja llegar de nuevo justo
    // despues de que se envie "TA". Sin emparejar la respuesta con el comando
    // que se pidio, esa "S S 1.234 kg" sobrante se leia como si fuera la
    // respuesta de TA, dando una tara y un bruto incorrectos con HTTP 200.
    let buffer = '';
    const scale = await createRawScale((chunk, socket) => {
        buffer += chunk.toString('latin1');
        let index;
        while ((index = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            if (!line) continue;
            const key = line.split(/\s+/)[0];
            if (key === 'S') {
                socket.write(Buffer.from('S S 1.234 kg\r\n', 'latin1'));
            } else if (key === 'TA') {
                // La "S" sobrante llega dentro de la ventana de lectura de TA,
                // antes de que llegue la respuesta real de TA.
                socket.write(Buffer.from('S S 1.234 kg\r\n', 'latin1'));
                setTimeout(() => {
                    socket.write(Buffer.from('TA A 0.000 kg\r\n', 'latin1'));
                }, 20);
            }
        }
    });
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        const result = await driver.weigh(link);
        // Verdad: la bascula no tiene tara puesta (TA A 0.000 kg). Sin el fix,
        // esto salia como tare 1234g y gross 2468g (ver mt-sics-protocol.test.js
        // para la prueba equivalente y mas directa sobre assertOk).
        assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
        assert.deepEqual(result.data.gross, { value: 1234, unit: 'g' });
    } finally {
        link.close();
        await scale.close();
    }
});

test('tare envia T y devuelve la tara resultante', async () => {
    const result = await withScale({ T: 'T S 0.230 kg' }, async (link, scale) => {
        const res = await driver.tare(link);
        assert.deepEqual(scale.received, ['T']);
        return res;
    });
    assert.deepEqual(result.data.tare, { value: 230, unit: 'g' });
});

test('clearTare envia TAC', async () => {
    await withScale({ TAC: 'TAC A' }, async (link, scale) => {
        const res = await driver.clearTare(link);
        assert.deepEqual(scale.received, ['TAC']);
        assert.deepEqual(res.data, {});
    });
});

test('zero envia Z', async () => {
    await withScale({ Z: 'Z A' }, async (link, scale) => {
        await driver.zero(link);
        assert.deepEqual(scale.received, ['Z']);
    });
});

test('info separa modelo y capacidad de I2, y lee el numero de serie de I4', async () => {
    const result = await withScale({
        I2: 'I2 A "ICS425-BW 3.0045 kg"',
        I4: 'I4 A "C614409345"',
    }, async (link, scale) => {
        const res = await driver.info(link);
        assert.deepEqual(scale.received, ['I2', 'I4']);
        return res;
    });
    assert.equal(result.data.model, 'ICS425-BW');
    assert.equal(result.data.capacity, '3.0045 kg');
    assert.equal(result.data.serial, 'C614409345');
});

test('display envia el texto entre comillas', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'PESAR BIDON 3' });
        assert.deepEqual(scale.received, ['D "PESAR BIDON 3"']);
    });
});

test('display quita las comillas dobles del texto para no romper la trama', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'DI "HOLA"' });
        assert.deepEqual(scale.received, ['D "DI HOLA"']);
    });
});

test('display rechaza un texto vacio antes de tocar la red', async () => {
    await assert.rejects(
        () => withScale({ D: 'D A' }, (link) => driver.display(link, { text: '' })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('display no permite inyectar un comando adicional via \\r\\n', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'HOLA"\r\nDS "X' });
        assert.equal(scale.received.length, 1);
        assert.ok(!scale.received.some((line) => line.trim().split(/\s+/)[0] === 'DS'));
    });
});

test('display no deja pasar un comando destructivo inyectado como RST', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'X"\r\nRST\r\nD "Y' });
        assert.ok(!scale.received.some((line) => line.trim().split(/\s+/)[0] === 'RST'));
    });
});

test('display rechaza un texto que solo tiene comillas, tras limpiarlas queda vacio', async () => {
    await assert.rejects(
        () => withScale({ D: 'D A' }, (link) => driver.display(link, { text: '"""' })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('displayClear envia DW', async () => {
    await withScale({ DW: 'DW A' }, async (link, scale) => {
        await driver.displayClear(link);
        assert.deepEqual(scale.received, ['DW']);
    });
});

test('beep envia DS', async () => {
    await withScale({ DS: 'DS A' }, async (link, scale) => {
        await driver.beep(link);
        assert.deepEqual(scale.received, ['DS']);
    });
});

test('beep en un equipo sin zumbador da not_supported', async () => {
    // La bascula falsa contesta ES a lo que no esta en la tabla, igual que una real.
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.beep(link)),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});

test('selectPlatform envia SNS con el numero', async () => {
    await withScale({ SNS: 'SNS A 2' }, async (link, scale) => {
        const res = await driver.selectPlatform(link, { platform: 2 });
        assert.deepEqual(scale.received, ['SNS 2']);
        assert.equal(res.data.platform, 2);
    });
});

test('selectPlatform rechaza un numero que no es 1 ni 2', async () => {
    await assert.rejects(
        () => withScale({ SNS: 'SNS A' }, (link) => driver.selectPlatform(link, { platform: 7 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('selectPlatform en un equipo de una sola plataforma da not_supported', async () => {
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.selectPlatform(link, { platform: 1 })),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});

test('guidedWeigh declara la capacidad como garantizada', () => {
    assert.ok(driver.capabilities.includes('guidedWeigh'));
});

test('guidedWeigh hace la secuencia completa D, DS, S, TA, DW', async () => {
    const result = await withScale({
        D: 'D A', DS: 'DS A', S: 'S S 2.500 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'PESAR BIDON 3', beep: true });
        assert.deepEqual(scale.received, ['D "PESAR BIDON 3"', 'DS', 'S', 'TA', 'DW']);
        return res;
    });
    assert.deepEqual(result.data.net, { value: 2500, unit: 'g' });
    assert.equal(result.data.stable, true);
    assert.equal(result.data.displayRestored, true);
});

test('guidedWeigh sin texto no envia D', async () => {
    await withScale({
        S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, {});
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    });
});

test('guidedWeigh sin beep no envia DS', async () => {
    await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, { text: 'HOLA', beep: false });
        assert.deepEqual(scale.received, ['D "HOLA"', 'S', 'TA', 'DW']);
    });
});

test('guidedWeigh sigue adelante si el equipo no tiene zumbador', async () => {
    // DS no esta en la tabla, asi que la bascula falsa contesta ES.
    const result = await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'HOLA', beep: true });
        assert.deepEqual(scale.received, ['D "HOLA"', 'DS', 'S', 'TA', 'DW']);
        return res;
    });
    // Un pitido que no suena no es razon para no dar la pesada.
    assert.deepEqual(result.data.net, { value: 1000, unit: 'g' });
    assert.ok(result.raw.some((line) => line === 'ES'), 'el ES deberia quedar en raw');
});

test('guidedWeigh usa SI cuando waitStable es false', async () => {
    await withScale({
        SI: 'SI D 0.900 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { waitStable: false });
        assert.deepEqual(scale.received, ['SI', 'TA', 'DW']);
        assert.equal(res.data.stable, false);
    });
});

// --- C2: timeoutMs invalido no debe colgar la conexion para siempre ---

function describeBadValue(value) {
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return JSON.stringify(value);
}

for (const bad of ['10000', NaN, Infinity, 0, -500, {}]) {
    const label = describeBadValue(bad);
    test(`guidedWeigh rechaza timeoutMs=${label} de inmediato, sin colgarse`, async () => {
        await withScale({
            S: 'S S 1.234 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
        }, async (link) => {
            const ceiling = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('no debia colgarse')), 4000);
            });
            await assert.rejects(
                Promise.race([driver.guidedWeigh(link, { timeoutMs: bad }), ceiling]),
                (err) => {
                    assert.ok(err instanceof ScaleError, `esperaba ScaleError, recibido: ${err}`);
                    assert.equal(err.code, 'protocol');
                    return true;
                },
            );
        });
    });
}

test('guidedWeigh acepta el timeoutMs por defecto (10000) sin necesidad de indicarlo', async () => {
    await withScale({
        S: 'S S 1.234 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, {});
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
        assert.equal(res.data.net.value, 1234);
    });
});

test('guidedWeigh restaura el display aunque la pesada falle', async () => {
    const scale = await createLineScale({ D: 'D A', S: 'S +', DW: 'DW A' });
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        await assert.rejects(
            () => driver.guidedWeigh(link, { text: 'PESAR' }),
            (err) => {
                assert.equal(err.code, 'overload');
                return true;
            },
        );
        // Esto es lo importante: el display no se queda con el texto puesto.
        assert.ok(scale.received.includes('DW'), 'deberia haber enviado DW pese al fallo');
    } finally {
        link.close();
        await scale.close();
    }
});

test('guidedWeigh no enmascara el error original si tambien falla el DW', async () => {
    const scale = await createLineScale({ D: 'D A', S: 'S +' });  // DW contesta ES
    const link = new TcpLink({
        host: '127.0.0.1',
        port: scale.port,
        framing: { ...driver.framing, quietMs: 80, totalMs: 1200 },
    });
    try {
        await link.connect();
        await assert.rejects(
            () => driver.guidedWeigh(link, { text: 'PESAR' }),
            (err) => {
                assert.equal(err.code, 'overload', 'debe ganar el error de la pesada');
                return true;
            },
        );
    } finally {
        link.close();
        await scale.close();
    }
});

test('guidedWeigh da la pesada aunque el DW final falle: no lanza, y displayRestored es false', async () => {
    // DW no esta en la tabla, asi que la bascula falsa contesta ES: la pesada
    // en si sale bien, pero restaurar el display falla despues.
    const result = await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'PESAR' });
        assert.deepEqual(scale.received, ['D "PESAR"', 'S', 'TA', 'DW']);
        return res;
    });
    // Un DW que falla no debe tirar el peso: el operario ya se ha pesado.
    assert.deepEqual(result.data.net, { value: 1000, unit: 'g' });
    assert.equal(result.data.displayRestored, false);
    // El ES del DW fallido deberia quedar en raw, igual que el del pitido.
    assert.ok(result.raw.some((line) => line === 'ES'), 'el ES del DW fallido deberia quedar en raw');
});
