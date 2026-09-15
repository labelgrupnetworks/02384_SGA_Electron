const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerScaleRoutes } = require('../src/server/scale-routes');
const { registry } = require('../src/scales');
const { createLineScale } = require('./helpers/fake-scale');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

async function startApp() {
    const app = express();
    app.use(express.json());
    registerScaleRoutes(app, silentLogger, { version: '1.3.0' });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}

function post(base, path, body) {
    return fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('GET /health announces the version and available APIs', async () => {
    const app = await startApp();
    try {
        const res = await fetch(`${app.base}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.version, '1.3.0');
        assert.deepEqual(body.apis, ['legacy', 'scale-v1', 'cmc-v1']);
        assert.deepEqual(body.brands.sort(), ['bizerba', 'mettler_toledo']);
    } finally {
        await app.close();
    }
});

test('GET /scale/brands returns the catalog with capabilities and models', async () => {
    const app = await startApp();
    try {
        const body = await (await fetch(`${app.base}/scale/brands`)).json();
        const mettler = body.brands.find((b) => b.id === 'mettler_toledo');
        assert.equal(mettler.defaultPort, 4305);
        assert.ok(mettler.capabilities.includes('guidedWeigh'));
        assert.deepEqual(mettler.deviceDependent.sort(), ['beep', 'selectPlatform']);

        const bizerba = body.brands.find((b) => b.id === 'bizerba');
        assert.equal(bizerba.defaultPort, 10051);
        assert.ok(!bizerba.capabilities.includes('zero'));
        // No driver declares model overrides today: the SGA's model catalog is
        // deliberately broader than this table, which only lists what deviates
        // from the base protocol.
        assert.deepEqual(bizerba.models, []);
    } finally {
        await app.close();
    }
});

test('missing ip, port or brand is 400 missing_params, not unknown_brand', async () => {
    const app = await startApp();
    try {
        for (const body of [
            { port: 4305, brand: 'mettler_toledo' },
            { ip: '127.0.0.1', brand: 'mettler_toledo' },
            { ip: '127.0.0.1', port: 4305 },
        ]) {
            const res = await post(app.base, '/scale/weigh', body);
            assert.equal(res.status, 400, JSON.stringify(body));
            const responseBody = await res.json();
            assert.equal(responseBody.success, false);
            // "missing ip/port/brand" is not the same as "that brand does not exist":
            // the SGA branches on this code, and confusing it with unknown_brand
            // points whoever is debugging to the wrong place.
            assert.equal(responseBody.error.code, 'missing_params', JSON.stringify(body));
        }
    } finally {
        await app.close();
    }
});

test('a malformed ip is 400 missing_params, not 500 nor a connection to localhost', async () => {
    const app = await startApp();
    try {
        for (const ip of [{}, [], 123, true, '']) {
            const res = await post(app.base, '/scale/weigh', { ip, port: 4305, brand: 'mettler_toledo' });
            assert.equal(res.status, 400, JSON.stringify(ip));
            const body = await res.json();
            assert.equal(body.success, false);
            assert.equal(body.error.code, 'missing_params', JSON.stringify(ip));
        }
    } finally {
        await app.close();
    }
});

test('a malformed port is 400 missing_params, not a raw Node error', async () => {
    const app = await startApp();
    try {
        for (const port of ['abc', 0, 99999, -1, 1.5, {}, null]) {
            const res = await post(app.base, '/scale/weigh', { ip: '127.0.0.1', port, brand: 'mettler_toledo' });
            assert.equal(res.status, 400, JSON.stringify(port));
            const body = await res.json();
            assert.equal(body.success, false);
            assert.equal(body.error.code, 'missing_params', JSON.stringify(port));
        }
    } finally {
        await app.close();
    }
});

test('a valid port as a numeric string is accepted the same as a numeric port', async () => {
    const app = await startApp();
    const scale = await createLineScale({ S: 'S S 1.234 kg', TA: 'TA A 0.000 kg' });
    try {
        const res = await post(app.base, '/scale/weigh', { ip: '127.0.0.1', port: String(scale.port), brand: 'mettler_toledo' });
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('an unknown brand is 400 unknown_brand with the list of valid ones', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: 4305, brand: 'acme',
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.error.code, 'unknown_brand');
        assert.deepEqual(body.error.detail.validBrands.sort(), ['bizerba', 'mettler_toledo']);
    } finally {
        await app.close();
    }
});

test('an operation the brand does not support is 501 without opening a socket', async () => {
    const app = await startApp();
    try {
        // Port 1 is closed: if it answered 502 it would mean it tried to connect.
        for (const op of ['zero', 'display', 'beep', 'guided-weigh']) {
            const res = await post(app.base, `/scale/${op}`, {
                ip: '127.0.0.1', port: 1, brand: 'bizerba', text: 'X',
            });
            assert.equal(res.status, 501, `${op} should be 501`);
            const body = await res.json();
            assert.equal(body.error.code, 'not_supported');
            assert.equal(body.brand, 'bizerba');
        }
    } finally {
        await app.close();
    }
});

test('weigh returns the normalised envelope with data and raw', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg', TA: 'TA A 0.050 kg' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.brand, 'mettler_toledo');
        assert.equal(body.op, 'weigh');
        assert.deepEqual(body.data.net, { value: 1234, unit: 'g' });
        assert.deepEqual(body.data.gross, { value: 1284, unit: 'g' });
        assert.equal(body.data.stable, true);
        assert.deepEqual(body.raw, ['S S 1.234 kg', 'TA A 0.050 kg']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('a closed port is 502 connect', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: 1, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 502);
        assert.equal((await res.json()).error.code, 'connect');
    } finally {
        await app.close();
    }
});

test('a silent scale is 504 timeout', async () => {
    const scale = await createLineScale({ S: null });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 504);
        assert.equal((await res.json()).error.code, 'timeout');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('an ES from the device arrives as 501, not as 500', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });  // DS answers ES
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/beep', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
        });
        assert.equal(res.status, 501);
        assert.equal((await res.json()).error.code, 'not_supported');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('display passes the text to the driver', async () => {
    const scale = await createLineScale({ D: 'D A' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/display', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', text: 'HOLA',
        });
        assert.equal(res.status, 200);
        assert.deepEqual(scale.received, ['D "HOLA"']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('select-platform passes the number to the driver', async () => {
    const scale = await createLineScale({ SNS: 'SNS A 2' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/select-platform', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', platform: 2,
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).data.platform, 2);
        // The fake's table only indexes by the first word ("SNS"), so the assert
        // above would pass even if the driver always sent "SNS 1": the requested
        // number actually has to reach the wire.
        assert.deepEqual(scale.received, ['SNS 2']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('the model propagates to the response and does not break the operation', async () => {
    // No driver declares model overrides today (see the models comment in
    // bizerba.js), so any model should fall back to the baseline and work the
    // same. What is being checked here is that the model travels back, which
    // is what the SGA needs to know which configuration it talked to.
    const scale = await createLineScale({ [`0\x03254\x03001\x03I!GX05`]: 'OK' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/tare', {
            ip: '127.0.0.1', port: scale.port, brand: 'bizerba', model: 'is30',
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).model, 'is30');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('a model without an override works with the baseline', async () => {
    const scale = await createLineScale({ S: 'S S 1.000 kg', TA: 'TA A 0.000 kg' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', model: 'ics425',
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).model, 'ics425');
    } finally {
        await app.close();
        await scale.close();
    }
});

test('guided-weigh works end to end and restores the display', async () => {
    const scale = await createLineScale({
        D: 'D A', DS: 'DS A', S: 'S S 2.000 kg', TA: 'TA A 0.000 kg', DW: 'DW A',
    });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/guided-weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo',
            text: 'PESAR', beep: true,
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body.data.net, { value: 2000, unit: 'g' });
        assert.equal(body.data.displayRestored, true);
        assert.deepEqual(scale.received, ['D "PESAR"', 'DS', 'S', 'TA', 'DW']);
    } finally {
        await app.close();
        await scale.close();
    }
});

// The real registry (`registry` from '../src/scales') is temporarily patched
// with a fake brand whose driver throws a specific value (not necessarily
// an Error), to prove that the error envelope holds up without touching any
// real driver. The TCP connection stays real (a fake-scale that doesn't need
// to answer anything, because the fake driver throws before touching the
// link) so as not to skip over the route's real connect().
async function withThrowingDriver(thrownValue, run) {
    const originalResolveDriver = registry.resolveDriver;
    const originalAllOperations = registry.allOperations;
    const fakeDriver = {
        id: 'fake_thrower',
        framing: {},
        async weigh() {
            throw thrownValue;
        },
    };
    registry.resolveDriver = (brand, model) => (
        brand === 'fake_thrower' ? fakeDriver : originalResolveDriver(brand, model)
    );
    registry.allOperations = (driver) => (
        driver === fakeDriver ? ['weigh'] : originalAllOperations(driver)
    );

    const scale = await createLineScale({});
    const app = await startApp();
    try {
        await run({ app, scale });
    } finally {
        registry.resolveDriver = originalResolveDriver;
        registry.allOperations = originalAllOperations;
        await app.close();
        await scale.close();
    }
}

test('a driver that throws null does not break the error envelope', async () => {
    await withThrowingDriver(null, async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.ok(body.error.message.length > 0, 'the message should not end up empty');
        assert.equal(body.error.detail, null);
    });
});

test('a driver that throws a string does not lose the message', async () => {
    await withThrowingDriver('la bascula exploto', async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.equal(body.error.message, 'la bascula exploto');
    });
});

test('a driver that throws a plain object does not break the error envelope', async () => {
    await withThrowingDriver({ reason: 'inesperado' }, async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.ok(body.error.message.length > 0, 'the message should not end up empty');
    });
});

test('a driver that throws an object whose message getter throws does not break the envelope', async () => {
    // The first round of this fix normalised with
    // `String(error?.message ?? error)`, which still throws if READING
    // `error.message` throws. This is exactly that case: a message getter
    // that blows up when read, not an absent message.
    const thrown = {
        get message() {
            throw new Error('el getter de message tambien exploto');
        },
    };
    await withThrowingDriver(thrown, async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.ok(body.error.message.length > 0, 'the message should not end up empty');
    });
});

test('a driver that throws an object whose toString throws does not break the envelope', async () => {
    // Without `.message`, `String(error)` falls back to `toString()`. If that
    // `toString` also throws, the same kind of failure shows up through a
    // different door.
    const thrown = {
        toString() {
            throw new Error('el toString tambien exploto');
        },
    };
    await withThrowingDriver(thrown, async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.ok(body.error.message.length > 0, 'the message should not end up empty');
    });
});

test('a driver that throws an object with no prototype (no toString) does not break the envelope', async () => {
    // Object.create(null) has neither toString nor valueOf: String(object) has
    // no method to fall back on and throws "Cannot convert object to primitive
    // value". This is another way the message derivation can throw without
    // anyone having deliberately written a malicious toString.
    const thrown = Object.create(null);
    await withThrowingDriver(thrown, async ({ app, scale }) => {
        const res = await post(app.base, '/scale/weigh', {
            ip: '127.0.0.1', port: scale.port, brand: 'fake_thrower',
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.brand, 'fake_thrower');
        assert.equal(body.model, null);
        assert.equal(body.op, 'weigh');
        assert.equal(body.error.code, 'protocol');
        assert.ok(body.error.message.length > 0, 'the message should not end up empty');
    });
});

test('all operations in the registry have a mounted route', async () => {
    const { OPERATIONS, routePathFor } = require('../src/scales');
    const app = await startApp();
    try {
        for (const op of OPERATIONS) {
            const res = await post(app.base, `/scale/${routePathFor(op)}`, {});
            assert.notEqual(res.status, 404, `${op} has no route`);
        }
    } finally {
        await app.close();
    }
});
