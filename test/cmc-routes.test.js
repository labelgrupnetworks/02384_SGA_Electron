const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerCmcRoutes } = require('../src/server/cmc-routes');
const { createManifestCache } = require('../src/cmc/manifest-cache');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

const entry = (barcode) => ({
    barcode,
    label_payloads: [{
        content_base64: Buffer.from(`^XA${barcode}^XZ`).toString('base64'),
        content_type: 'application/zpl',
        filename: `${barcode}.zpl`,
    }],
});

async function startApp({
    machineState = () => ({ connected: true }),
    queuedReports = () => 0,
    enabled = false,
} = {}) {
    const app = express();
    const cache = createManifestCache();
    // Register CMC routes BEFORE the global express.json(), matching main.js.
    // The preload handler ends the response itself, so the global parser is
    // never reached at all for that request. This proves the real
    // arrangement works; see 'wrong order' test below for what happens
    // otherwise.
    registerCmcRoutes(app, silentLogger, {
        cache, machineState, queuedReports, enabled,
    });
    app.use(express.json());
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return {
        cache,
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

test('POST /cmc/preload loads a batch and reports its state', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/cmc/preload', {
            batch_id: 'B1', entries: [entry('111'), entry('222')],
        });

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(body.manifest.batch_id, 'B1');
        assert.equal(body.manifest.total, 2);
        assert.ok(app.cache.lookup('111'));
    } finally {
        await app.close();
    }
});

test('POST /cmc/preload replaces the previous batch', async () => {
    const app = await startApp();
    try {
        await post(app.base, '/cmc/preload', { batch_id: 'B1', entries: [entry('111')] });
        await post(app.base, '/cmc/preload', { batch_id: 'B2', entries: [entry('222')] });

        assert.equal(app.cache.lookup('111'), null);
        assert.ok(app.cache.lookup('222'));
    } finally {
        await app.close();
    }
});

test('POST /cmc/preload rejects a malformed manifest with 400', async () => {
    const app = await startApp();
    try {
        const res = await post(app.base, '/cmc/preload', { entries: [] });

        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.error.code, 'bad_manifest');
    } finally {
        await app.close();
    }
});

test('a rejected preload leaves the loaded batch untouched', async () => {
    const app = await startApp();
    try {
        await post(app.base, '/cmc/preload', { batch_id: 'B1', entries: [entry('111')] });
        await post(app.base, '/cmc/preload', { batch_id: 'B2', entries: 'nope' });

        assert.ok(app.cache.lookup('111'));
    } finally {
        await app.close();
    }
});

test('POST /cmc/preload accepts a payload larger than the express default of 100kb', async () => {
    const app = await startApp();
    try {
        // 400 entries of ~4 KB of base64 each: comfortably over the default limit.
        const entries = Array.from({ length: 400 }, (_, i) => ({
            barcode: String(i).padStart(8, '0'),
            label_payloads: [{
                content_base64: Buffer.alloc(3000, 'x').toString('base64'),
                content_type: 'application/zpl',
                filename: `${i}.zpl`,
            }],
        }));

        const res = await post(app.base, '/cmc/preload', { batch_id: 'BIG', entries });

        assert.equal(res.status, 200);
        assert.equal((await res.json()).manifest.total, 400);
    } finally {
        await app.close();
    }
});

test('GET /cmc/status reports manifest and machine state', async () => {
    const app = await startApp({
        machineState: () => ({ connected: false, last_error: 'ECONNREFUSED' }),
        queuedReports: () => 3,
        enabled: true,
    });
    try {
        await post(app.base, '/cmc/preload', { batch_id: 'B1', entries: [entry('111')] });

        const res = await fetch(`${app.base}/cmc/status`);
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.manifest.batch_id, 'B1');
        assert.equal(body.machine.connected, false);
        assert.equal(body.machine.last_error, 'ECONNREFUSED');
        // The same backlog figure the socket.io 'cmc-status' event reports,
        // now also visible over plain HTTP polling (I3).
        assert.equal(body.queued_reports, 3);
        assert.equal(body.enabled, true);
    } finally {
        await app.close();
    }
});

test('GET /cmc/status works before anything is preloaded', async () => {
    const app = await startApp();
    try {
        const body = await (await fetch(`${app.base}/cmc/status`)).json();

        assert.equal(body.manifest.batch_id, null);
        assert.equal(body.manifest.total, 0);
    } finally {
        await app.close();
    }
});

test('GET /cmc/status defaults queued_reports and enabled when the caller omits them', async () => {
    // Mirrors any caller (present or future) that does not pass queuedReports
    // or enabled to registerCmcRoutes: the route must still respond with a
    // sane, well-typed value rather than throwing or reporting undefined.
    const app = await startApp();
    try {
        const body = await (await fetch(`${app.base}/cmc/status`)).json();

        assert.equal(body.queued_reports, 0);
        assert.equal(body.enabled, false);
    } finally {
        await app.close();
    }
});

test('POST /cmc/preload still 413s when routes are registered in the WRONG order', async () => {
    // The comment in registerCmcRoutes (src/server/cmc-routes.js) explains why
    // it must be called BEFORE the global express.json(): the route's own
    // express.json({ limit: PRELOAD_BODY_LIMIT }) only takes effect when it
    // runs first. This test builds the app the wrong way round — global
    // express.json() first, registerCmcRoutes after — and proves an
    // oversized manifest that the real (correct) ordering accepts (see
    // 'accepts a payload larger than the express default of 100kb' above)
    // gets rejected with a 413 here instead.
    const app = express();
    const cache = createManifestCache();
    app.use(express.json());
    registerCmcRoutes(app, silentLogger, { cache, machineState: () => ({ connected: true }) });
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const entries = Array.from({ length: 400 }, (_, i) => ({
            barcode: String(i).padStart(8, '0'),
            label_payloads: [{
                content_base64: Buffer.alloc(3000, 'x').toString('base64'),
                content_type: 'application/zpl',
                filename: `${i}.zpl`,
            }],
        }));

        const res = await post(base, '/cmc/preload', { batch_id: 'BIG', entries });

        assert.equal(res.status, 413);
    } finally {
        await new Promise((r) => server.close(() => r()));
    }
});
