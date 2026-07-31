const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/bizerba');
const { buildTelegram } = require('../../src/scales/drivers/bizerba');
const { TcpLink } = require('../../src/scales/transport');
const { createLineScale } = require('../helpers/fake-scale');

const ETX = '\x03';

async function withScale(table, fn, options) {
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
    assert.equal(driver.id, 'bizerba');
    assert.equal(driver.defaultPort, 10051);
});

test('no declara zero, display, beep ni guidedWeigh', () => {
    const all = [...driver.capabilities, ...driver.deviceDependent];
    for (const op of ['zero', 'display', 'displayClear', 'beep', 'guidedWeigh']) {
        assert.ok(!all.includes(op), `${op} no deberia estar declarada`);
    }
});

test('buildTelegram usa el prefijo de produccion por defecto', () => {
    assert.equal(buildTelegram('I!GX05'), `0${ETX}254${ETX}001${ETX}I!GX05`);
});

test('buildTelegram acepta un prefijo distinto sin tocar el cuerpo', () => {
    assert.equal(
        buildTelegram('I!GX05', { addressPrefix: ['1', '200', '002'] }),
        `1${ETX}200${ETX}002${ETX}I!GX05`,
    );
});

test('buildTelegram rechaza un prefijo que no tiene tres campos', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', '254'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('weigh envia la trama de pesos y devuelve neto, tara y bruto en gramos', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        // La bascula falsa indexa por el primer token, que aqui es la trama entera.
        [`0${ETX}254${ETX}001${ETX}${body}`]: `I!LV01|GD01|kg;-3;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02`,
    }, async (link, scale) => {
        const res = await driver.weigh(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}${body}`]);
        return res;
    });

    assert.deepEqual(result.data.net, { value: 1234, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 50, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 1284, unit: 'g' });
});

test('weigh de una bascula vacia da ceros, con la trama real capturada', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));

    assert.deepEqual(result.data.net, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 0, unit: 'g' });
});

test('weigh marca stable true: la trama de pesos solo llega con peso asentado', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, true);
});

test('weigh salta los tripletes mal formados y deja el campo a null', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3|GD02|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.net, null);
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.equal(result.data.gross, null);
});

test('weigh sin respuesta es timeout', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    await assert.rejects(
        () => withScale({ [`0${ETX}254${ETX}001${ETX}${body}`]: null }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'timeout');
            return true;
        },
    );
});

test('tare envia I!GX05', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX05`]: 'I!GX05 OK',
    }, async (link, scale) => {
        await driver.tare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX05`]);
    });
});

test('clearTare envia I!GX06', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX06`]: 'I!GX06 OK',
    }, async (link, scale) => {
        await driver.clearTare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX06`]);
    });
});

test('info envia I?GV05|LX02 y devuelve la respuesta cruda', async () => {
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}I?GV05|LX02`]: 'I!GV05|1.23|LX02',
    }, (link) => driver.info(link));
    assert.deepEqual(result.raw, ['I!GV05|1.23|LX02']);
    // Sin documentacion BCP no se descompone en modelo y serie: se entrega crudo.
    assert.equal(result.data.model, null);
    assert.equal(result.data.raw_info, 'I!GV05|1.23|LX02');
});

test('selectPlatform 1 y 2 envian sus tramas', async () => {
    for (const platform of [1, 2]) {
        const body = `I!LV01|GW01|${platform}|LX02`;
        await withScale({
            [`0${ETX}254${ETX}001${ETX}${body}`]: 'OK',
        }, async (link, scale) => {
            const res = await driver.selectPlatform(link, { platform });
            assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}${body}`]);
            assert.equal(res.data.platform, platform);
        });
    }
});

test('selectPlatform rechaza un numero que no es 1 ni 2', async () => {
    await assert.rejects(
        () => withScale({}, (link) => driver.selectPlatform(link, { platform: 3 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('un prefijo por options cambia las seis tramas', async () => {
    const body = 'I!GX05';
    await withScale({
        [`9${ETX}100${ETX}007${ETX}${body}`]: 'OK',
    }, async (link, scale) => {
        await driver.tare(link, { options: { addressPrefix: ['9', '100', '007'] } });
        assert.deepEqual(scale.received, [`9${ETX}100${ETX}007${ETX}${body}`]);
    });
});
