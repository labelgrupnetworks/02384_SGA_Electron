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

test('GET /health anuncia version y APIs disponibles', async () => {
    const app = await startApp();
    try {
        const res = await fetch(`${app.base}/health`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.version, '1.3.0');
        assert.deepEqual(body.apis, ['legacy', 'scale-v1']);
        assert.deepEqual(body.brands.sort(), ['bizerba', 'mettler_toledo']);
    } finally {
        await app.close();
    }
});

test('GET /scale/brands devuelve el catalogo con capacidades y modelos', async () => {
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
        // Ningun driver declara overrides de modelo hoy: el catalogo de modelos del
        // SGA es a proposito mas amplio que esta tabla, que solo lista lo que se
        // desvia del protocolo base.
        assert.deepEqual(bizerba.models, []);
    } finally {
        await app.close();
    }
});

test('faltar ip, port o brand es 400 missing_params, no unknown_brand', async () => {
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
            // "falta ip/port/brand" no es lo mismo que "esa marca no existe": el SGA
            // rama sobre este code, y confundirlo con unknown_brand apunta a quien
            // depura hacia el sitio equivocado.
            assert.equal(responseBody.error.code, 'missing_params', JSON.stringify(body));
        }
    } finally {
        await app.close();
    }
});

test('una marca desconocida es 400 unknown_brand con la lista valida', async () => {
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

test('una operacion que la marca no soporta es 501 sin abrir socket', async () => {
    const app = await startApp();
    try {
        // Puerto 1 esta cerrado: si respondiera 502 significaria que intento conectar.
        for (const op of ['zero', 'display', 'beep', 'guided-weigh']) {
            const res = await post(app.base, `/scale/${op}`, {
                ip: '127.0.0.1', port: 1, brand: 'bizerba', text: 'X',
            });
            assert.equal(res.status, 501, `${op} deberia ser 501`);
            const body = await res.json();
            assert.equal(body.error.code, 'not_supported');
            assert.equal(body.brand, 'bizerba');
        }
    } finally {
        await app.close();
    }
});

test('weigh devuelve el sobre normalizado con data y raw', async () => {
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

test('un puerto cerrado es 502 connect', async () => {
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

test('una bascula muda es 504 timeout', async () => {
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

test('un ES del equipo llega como 501, no como 500', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });  // DS contesta ES
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

test('display pasa el texto al driver', async () => {
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

test('select-platform pasa el numero al driver', async () => {
    const scale = await createLineScale({ SNS: 'SNS A 2' });
    const app = await startApp();
    try {
        const res = await post(app.base, '/scale/select-platform', {
            ip: '127.0.0.1', port: scale.port, brand: 'mettler_toledo', platform: 2,
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).data.platform, 2);
        // La tabla del fake solo indexa por la primera palabra ("SNS"), asi que
        // el assert de arriba pasaria incluso si el driver siempre mandara "SNS 1":
        // el numero solicitado tiene que llegar de verdad al cable.
        assert.deepEqual(scale.received, ['SNS 2']);
    } finally {
        await app.close();
        await scale.close();
    }
});

test('el model se propaga a la respuesta y no rompe la operacion', async () => {
    // Ningun driver declara overrides de modelo hoy (ver el comentario de models
    // en bizerba.js), asi que un model cualquiera debe caer a la linea base y
    // funcionar igual. Lo que se comprueba aqui es que el model viaja de vuelta,
    // que es lo que el SGA necesita para saber con que configuracion se hablo.
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

test('un model sin override funciona con la linea base', async () => {
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

test('guided-weigh funciona de punta a punta y restaura el display', async () => {
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

// El registro real (`registry` de '../src/scales') se parchea temporalmente
// con una marca falsa cuyo driver lanza un valor concreto (no necesariamente
// un Error), para probar que el envelope de error se mantiene sin tocar
// ningun driver real. La conexion TCP sigue siendo real (una fake-scale que
// no hace falta que conteste nada, porque el driver falso lanza antes de
// tocar el link) para no saltarse el connect() real de la ruta.
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

test('un driver que lanza null no rompe el envelope de error', async () => {
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
        assert.ok(body.error.message.length > 0, 'el mensaje no deberia quedar vacio');
        assert.equal(body.error.detail, null);
    });
});

test('un driver que lanza un string no pierde el mensaje', async () => {
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

test('un driver que lanza un objeto plano no rompe el envelope de error', async () => {
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
        assert.ok(body.error.message.length > 0, 'el mensaje no deberia quedar vacio');
    });
});

test('todas las operaciones del registro tienen ruta montada', async () => {
    const { OPERATIONS, routePathFor } = require('../src/scales');
    const app = await startApp();
    try {
        for (const op of OPERATIONS) {
            const res = await post(app.base, `/scale/${routePathFor(op)}`, {});
            assert.notEqual(res.status, 404, `${op} no tiene ruta`);
        }
    } finally {
        await app.close();
    }
});
