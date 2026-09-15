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

async function startApp({ machineState = () => ({ connected: true }) } = {}) {
    const app = express();
    app.use(express.json());
    const cache = createManifestCache();
    registerCmcRoutes(app, silentLogger, { cache, machineState });
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
    const app = await startApp({ machineState: () => ({ connected: false, last_error: 'ECONNREFUSED' }) });
    try {
        await post(app.base, '/cmc/preload', { batch_id: 'B1', entries: [entry('111')] });

        const res = await fetch(`${app.base}/cmc/status`);
        const body = await res.json();

        assert.equal(res.status, 200);
        assert.equal(body.manifest.batch_id, 'B1');
        assert.equal(body.machine.connected, false);
        assert.equal(body.machine.last_error, 'ECONNREFUSED');
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
