const test = require('node:test');
const assert = require('node:assert/strict');
const driver = require('../../src/scales/drivers/bizerba');
const { buildTelegram, parseWeights } = require('../../src/scales/drivers/bizerba');
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

test('the driver identifies itself with the id the SGA uses', () => {
    assert.equal(driver.id, 'bizerba');
    assert.equal(driver.defaultPort, 10051);
});

test('does not declare zero, display, beep or guidedWeigh', () => {
    const all = [...driver.capabilities, ...driver.deviceDependent];
    for (const op of ['zero', 'display', 'displayClear', 'beep', 'guidedWeigh']) {
        assert.ok(!all.includes(op), `${op} should not be declared`);
    }
});

test('buildTelegram uses the production prefix by default', () => {
    assert.equal(buildTelegram('I!GX05'), `0${ETX}254${ETX}001${ETX}I!GX05`);
});

test('buildTelegram accepts a different prefix without touching the body', () => {
    assert.equal(
        buildTelegram('I!GX05', { addressPrefix: ['1', '200', '002'] }),
        `1${ETX}200${ETX}002${ETX}I!GX05`,
    );
});

test('buildTelegram rejects a prefix that does not have three fields', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', '254'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram still produces the default prefix byte for byte', () => {
    assert.equal(buildTelegram('I!GX05'), `0${ETX}254${ETX}001${ETX}I!GX05`);
});

test('buildTelegram still accepts a different legitimate prefix', () => {
    assert.equal(
        buildTelegram('I!GX05', { addressPrefix: ['1', '200', '002'] }),
        `1${ETX}200${ETX}002${ETX}I!GX05`,
    );
});

for (const [label, badChar] of [['ETX', ETX], ['CR', '\r'], ['LF', '\n']]) {
    test(`buildTelegram rejects ${label} inside an addressPrefix field`, () => {
        for (let i = 0; i < 3; i += 1) {
            const prefix = ['0', '254', '001'];
            prefix[i] = `x${badChar}y`;
            assert.throws(() => buildTelegram('I!GX05', { addressPrefix: prefix }), (err) => {
                assert.equal(err.code, 'protocol');
                return true;
            }, `field ${i} with ${label} should be rejected`);
        }
    });
}

test('buildTelegram rejects the reviewer\'s injection payload without producing two telegrams', () => {
    assert.throws(
        () => buildTelegram('I!GX05', { addressPrefix: ['001\r\n9\x03100\x03007', '254', '001'] }),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('buildTelegram rejects other control characters (not just ETX/CR/LF)', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['\x00', '254', '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', '\x1F', '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', '254', '\x7F'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects an empty field in addressPrefix', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['', '254', '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects null in an addressPrefix field, does not send it as the text "null"', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', null, '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects undefined in an addressPrefix field', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', undefined, '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects a sparse hole: validation is not skipped', () => {
    // eslint-disable-next-line no-sparse-arrays
    const prefix = ['0', , '001'];
    assert.equal(prefix.length, 3);
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: prefix }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects numbers in addressPrefix: they would silently lose the leading zero padding', () => {
    // String(1) is '1', not '001': accepting the number would silently
    // address a different field with nothing in the telegram to warn that it changed.
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: [0, 254, 1] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects a single non-string field among valid strings', () => {
    assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', 254, '001'] }), (err) => {
        assert.equal(err.code, 'protocol');
        return true;
    });
});

test('buildTelegram rejects other non-string types: boolean, object, array and String wrapper', () => {
    for (const bad of [true, { a: 1 }, ['0'], new String('001')]) {
        assert.throws(() => buildTelegram('I!GX05', { addressPrefix: ['0', bad, '001'] }), (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        }, `${Object.prototype.toString.call(bad)} should be rejected`);
    }
});

test('weigh sends the weights telegram and returns net, tare and gross in grams', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        // The fake scale indexes by the first token, which here is the entire telegram.
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

test('weigh from an empty scale gives zeros, with the real captured telegram', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));

    assert.deepEqual(result.data.net, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 0, unit: 'g' });
});

test('weigh marks stable true: the weights telegram only arrives once the weight has settled', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3;0|GD02|kg;-3;0|GD07|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, true);
});

test('weigh skips malformed triplets and leaves the field as null', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;-3|GD02|kg;-3;0|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.net, null);
    assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
    assert.equal(result.data.gross, null);
});

// --- I1: an invalid exponent in the triplet must leave the field as null, not NaN ---

test('parseWeights leaves the field as null if the exponent is not an integer: "abc"', () => {
    const weights = parseWeights('GD01|kg;abc;1234');
    assert.equal(weights.net, null);
});

test('parseWeights leaves the field as null if the exponent is empty', () => {
    const weights = parseWeights('GD01|kg;;1234');
    assert.equal(weights.net, null);
});

test('parseWeights leaves the field as null if the exponent is a decimal: "1.5"', () => {
    const weights = parseWeights('GD01|kg;1.5;1234');
    assert.equal(weights.net, null);
});

test('parseWeights accepts a valid negative exponent', () => {
    const weights = parseWeights('GD01|kg;-3;1234');
    assert.deepEqual(weights.net, { value: 1234, unit: 'g' });
});

test('weigh with an unreadable exponent in the real telegram leaves that field as null (not NaN serialised as null some other way)', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'I!LV01|GD01|kg;abc;1234|GD02|kg;-3;50|GD07|kg;-3;1284|LX02',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.net, null);
    assert.deepEqual(result.data.tare, { value: 50, unit: 'g' });
    assert.deepEqual(result.data.gross, { value: 1284, unit: 'g' });
});

test('weigh with no response is a timeout', async () => {
    const body = 'I?LV01|RX02|STA7|GD01;GD02;GD07|LX02';
    await assert.rejects(
        () => withScale({ [`0${ETX}254${ETX}001${ETX}${body}`]: null }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'timeout');
            return true;
        },
    );
});

test('tare sends I!GX05', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX05`]: 'I!GX05 OK',
    }, async (link, scale) => {
        await driver.tare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX05`]);
    });
});

test('clearTare sends I!GX06', async () => {
    await withScale({
        [`0${ETX}254${ETX}001${ETX}I!GX06`]: 'I!GX06 OK',
    }, async (link, scale) => {
        await driver.clearTare(link);
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}I!GX06`]);
    });
});

test('info sends I?GV05|LX02 and returns the raw response', async () => {
    const result = await withScale({
        [`0${ETX}254${ETX}001${ETX}I?GV05|LX02`]: 'I!GV05|1.23|LX02',
    }, (link) => driver.info(link));
    assert.deepEqual(result.raw, ['I!GV05|1.23|LX02']);
    // Without BCP documentation it is not split into model and serial: delivered raw.
    assert.equal(result.data.model, null);
    assert.equal(result.data.raw_info, 'I!GV05|1.23|LX02');
});

test('selectPlatform 1 and 2 send their telegrams', async () => {
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

test('selectPlatform rejects a number that is neither 1 nor 2', async () => {
    await assert.rejects(
        () => withScale({}, (link) => driver.selectPlatform(link, { platform: 3 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('a prefix passed via options changes all six telegrams', async () => {
    const body = 'I!GX05';
    await withScale({
        [`9${ETX}100${ETX}007${ETX}${body}`]: 'OK',
    }, async (link, scale) => {
        await driver.tare(link, { options: { addressPrefix: ['9', '100', '007'] } });
        assert.deepEqual(scale.received, [`9${ETX}100${ETX}007${ETX}${body}`]);
    });
});

// The SGA sends `"options": null` when the operator did not touch anything
// (not `{}` nor the field being absent). This used to blow up with a
// TypeError inside buildTelegram ("Cannot read properties of null") that
// /scale/* returned as a 500 instead of treating null the same as "use the
// default prefix".
test('tare with options: null uses the default addressPrefix instead of failing', async () => {
    const body = 'I!GX05';
    await withScale({
        [`0${ETX}254${ETX}001${ETX}${body}`]: 'OK',
    }, async (link, scale) => {
        await driver.tare(link, { options: null });
        assert.deepEqual(scale.received, [`0${ETX}254${ETX}001${ETX}${body}`]);
    });
});

test('buildTelegram with options: null uses the default addressPrefix', () => {
    assert.equal(
        buildTelegram('I!GX05', null),
        `0${ETX}254${ETX}001${ETX}I!GX05`,
    );
});
