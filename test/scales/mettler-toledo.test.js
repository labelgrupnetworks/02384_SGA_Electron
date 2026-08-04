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

test('the driver identifies itself with the id the SGA uses', () => {
    assert.equal(driver.id, 'mettler_toledo');
    assert.equal(driver.defaultPort, 4305);
});

test('beep and selectPlatform are device-dependent, not guaranteed', () => {
    assert.deepEqual(driver.deviceDependent.sort(), ['beep', 'selectPlatform']);
    assert.ok(!driver.capabilities.includes('beep'));
    assert.ok(!driver.capabilities.includes('selectPlatform'));
});

test('weigh asks for S and TA, and computes the gross', async () => {
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

test('weigh marks stable false with status D', async () => {
    const result = await withScale({
        S: 'S D 0.700 kg',
        TA: 'TA A 0.000 kg',
    }, (link) => driver.weigh(link));
    assert.equal(result.data.stable, false);
    assert.deepEqual(result.data.gross, { value: 700, unit: 'g' });
});

test('weigh propagates the overload', async () => {
    await assert.rejects(
        () => withScale({ S: 'S +' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'overload');
            return true;
        },
    );
});

test('weigh fails as protocol if S answers something that is not a weight', async () => {
    await assert.rejects(
        () => withScale({ S: 'S A' }, (link) => driver.weigh(link)),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('weigh does not attribute to TA a late-arriving S response (reproduces C1 from the final review)', async () => {
    // Scenario reproduced by the reviewer: a device that repeats its "S"
    // response (e.g. left in SIR/SR streaming mode) lets it arrive again right
    // after "TA" is sent. Without matching the response to the command that
    // was requested, that leftover "S S 1.234 kg" was read as if it were TA's
    // response, giving an incorrect tare and gross with HTTP 200.
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
                // The leftover "S" arrives within TA's read window, before TA's
                // real response arrives.
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
        // Truth: the scale has no tare set (TA A 0.000 kg). Without the fix,
        // this came out as tare 1234g and gross 2468g (see mt-sics-protocol.test.js
        // for the equivalent and more direct test on assertOk).
        assert.deepEqual(result.data.tare, { value: 0, unit: 'g' });
        assert.deepEqual(result.data.gross, { value: 1234, unit: 'g' });
    } finally {
        link.close();
        await scale.close();
    }
});

test('tare sends T and returns the resulting tare', async () => {
    const result = await withScale({ T: 'T S 0.230 kg' }, async (link, scale) => {
        const res = await driver.tare(link);
        assert.deepEqual(scale.received, ['T']);
        return res;
    });
    assert.deepEqual(result.data.tare, { value: 230, unit: 'g' });
});

test('clearTare sends TAC', async () => {
    await withScale({ TAC: 'TAC A' }, async (link, scale) => {
        const res = await driver.clearTare(link);
        assert.deepEqual(scale.received, ['TAC']);
        assert.deepEqual(res.data, {});
    });
});

test('zero sends Z', async () => {
    await withScale({ Z: 'Z A' }, async (link, scale) => {
        await driver.zero(link);
        assert.deepEqual(scale.received, ['Z']);
    });
});

test('info splits model and capacity from I2, and reads the serial number from I4', async () => {
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

test('display sends the text in quotes', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'PESAR BIDON 3' });
        assert.deepEqual(scale.received, ['D "PESAR BIDON 3"']);
    });
});

test('display strips double quotes from the text so it does not break the telegram', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'DI "HOLA"' });
        assert.deepEqual(scale.received, ['D "DI HOLA"']);
    });
});

test('display rejects empty text before touching the network', async () => {
    await assert.rejects(
        () => withScale({ D: 'D A' }, (link) => driver.display(link, { text: '' })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('display does not allow injecting an additional command via \\r\\n', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'HOLA"\r\nDS "X' });
        assert.equal(scale.received.length, 1);
        assert.ok(!scale.received.some((line) => line.trim().split(/\s+/)[0] === 'DS'));
    });
});

test('display does not let through a destructive command injected as RST', async () => {
    await withScale({ D: 'D A' }, async (link, scale) => {
        await driver.display(link, { text: 'X"\r\nRST\r\nD "Y' });
        assert.ok(!scale.received.some((line) => line.trim().split(/\s+/)[0] === 'RST'));
    });
});

test('display rejects a text that only has quotes, which is empty after cleaning', async () => {
    await assert.rejects(
        () => withScale({ D: 'D A' }, (link) => driver.display(link, { text: '"""' })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('displayClear sends DW', async () => {
    await withScale({ DW: 'DW A' }, async (link, scale) => {
        await driver.displayClear(link);
        assert.deepEqual(scale.received, ['DW']);
    });
});

test('beep sends DS', async () => {
    await withScale({ DS: 'DS A' }, async (link, scale) => {
        await driver.beep(link);
        assert.deepEqual(scale.received, ['DS']);
    });
});

test('beep on a device without a buzzer gives not_supported', async () => {
    // The fake scale answers ES to whatever is not in the table, just like a real one.
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.beep(link)),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});

test('selectPlatform sends SNS with the number', async () => {
    await withScale({ SNS: 'SNS A 2' }, async (link, scale) => {
        const res = await driver.selectPlatform(link, { platform: 2 });
        assert.deepEqual(scale.received, ['SNS 2']);
        assert.equal(res.data.platform, 2);
    });
});

test('selectPlatform rejects a number that is neither 1 nor 2', async () => {
    await assert.rejects(
        () => withScale({ SNS: 'SNS A' }, (link) => driver.selectPlatform(link, { platform: 7 })),
        (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        },
    );
});

test('selectPlatform on a single-platform device gives not_supported', async () => {
    await assert.rejects(
        () => withScale({ S: 'S S 0.000 kg' }, (link) => driver.selectPlatform(link, { platform: 1 })),
        (err) => {
            assert.equal(err.code, 'not_supported');
            return true;
        },
    );
});

test('guidedWeigh declares the capability as guaranteed', () => {
    assert.ok(driver.capabilities.includes('guidedWeigh'));
});

test('guidedWeigh runs the full D, DS, S, TA, DW sequence', async () => {
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

test('guidedWeigh without text does not send D', async () => {
    await withScale({
        S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, {});
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    });
});

test('guidedWeigh without beep does not send DS', async () => {
    await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        await driver.guidedWeigh(link, { text: 'HOLA', beep: false });
        assert.deepEqual(scale.received, ['D "HOLA"', 'S', 'TA', 'DW']);
    });
});

test('guidedWeigh proceeds even if the device has no buzzer', async () => {
    // DS is not in the table, so the fake scale answers ES.
    const result = await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'HOLA', beep: true });
        assert.deepEqual(scale.received, ['D "HOLA"', 'DS', 'S', 'TA', 'DW']);
        return res;
    });
    // A beep that doesn't sound is not a reason to withhold the weighing.
    assert.deepEqual(result.data.net, { value: 1000, unit: 'g' });
    assert.ok(result.raw.some((line) => line === 'ES'), 'the ES should stay in raw');
});

test('guidedWeigh uses SI when waitStable is false', async () => {
    await withScale({
        SI: 'SI D 0.900 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { waitStable: false });
        assert.deepEqual(scale.received, ['SI', 'TA', 'DW']);
        assert.equal(res.data.stable, false);
    });
});

// --- C2: an invalid timeoutMs must not hang the connection forever ---

function describeBadValue(value) {
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return JSON.stringify(value);
}

for (const bad of ['10000', NaN, Infinity, 0, -500, {}]) {
    const label = describeBadValue(bad);
    test(`guidedWeigh rejects timeoutMs=${label} immediately, without hanging`, async () => {
        await withScale({
            S: 'S S 1.234 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
        }, async (link) => {
            const ceiling = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('should not have hung')), 4000);
            });
            await assert.rejects(
                Promise.race([driver.guidedWeigh(link, { timeoutMs: bad }), ceiling]),
                (err) => {
                    assert.ok(err instanceof ScaleError, `expected ScaleError, got: ${err}`);
                    assert.equal(err.code, 'protocol');
                    return true;
                },
            );
        });
    });
}

test('guidedWeigh accepts the default timeoutMs (10000) without needing to specify it', async () => {
    await withScale({
        S: 'S S 1.234 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, {});
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
        assert.equal(res.data.net.value, 1234);
    });
});

test('guidedWeigh restores the display even if the weighing fails', async () => {
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
        // This is the important part: the display doesn't stay stuck showing the text.
        assert.ok(scale.received.includes('DW'), 'should have sent DW despite the failure');
    } finally {
        link.close();
        await scale.close();
    }
});

test('guidedWeigh does not mask the original error if the DW also fails', async () => {
    const scale = await createLineScale({ D: 'D A', S: 'S +' });  // DW answers ES
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
                assert.equal(err.code, 'overload', 'the weighing error should win');
                return true;
            },
        );
    } finally {
        link.close();
        await scale.close();
    }
});

test('guidedWeigh gives the weighing even if the final DW fails: it does not throw, and displayRestored is false', async () => {
    // DW is not in the table, so the fake scale answers ES: the weighing
    // itself goes fine, but restoring the display fails afterwards.
    const result = await withScale({
        D: 'D A', S: 'S S 1.000 kg', TA: 'TA A 0.000 kg',
    }, async (link, scale) => {
        const res = await driver.guidedWeigh(link, { text: 'PESAR' });
        assert.deepEqual(scale.received, ['D "PESAR"', 'S', 'TA', 'DW']);
        return res;
    });
    // A DW that fails must not throw away the weight: the operator has already been weighed.
    assert.deepEqual(result.data.net, { value: 1000, unit: 'g' });
    assert.equal(result.data.displayRestored, false);
    // The ES from the failed DW should stay in raw, just like the beep's.
    assert.ok(result.raw.some((line) => line === 'ES'), 'the ES from the failed DW should stay in raw');
});
