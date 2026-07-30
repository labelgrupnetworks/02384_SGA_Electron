const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/mettler-toledo');
const { TcpLink } = require('../../src/scales/transport');
const { createLineScale } = require('../helpers/fake-scale');

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
