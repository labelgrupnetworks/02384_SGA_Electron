const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerIpRoute } = require('../src/server/ip-route');

async function startApp(resolve, logger = null) {
    const app = express();
    app.use(express.json());
    registerIpRoute(app, { resolve, logger });
    const server = await new Promise((resolve2) => {
        const s = app.listen(0, '127.0.0.1', () => resolve2(s));
    });
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(() => r())),
    };
}

// Captures what a real logger.error call would receive, without pulling in
// electron-log or console noise.
function fakeLogger() {
    const errors = [];
    return { errors, error: (...args) => errors.push(args) };
}

test('a configured workstation answers 200 with just the ip, as before', async () => {
    const app = await startApp(() => ({
        ip: '192.168.0.47', interface: 'enp0s31f6', status: 'configured',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 200);
        // The SGA's getLocalIpFromElectron() and the browser's ip-detector both read
        // this exact field, so the successful shape must not change.
        assert.deepEqual(await res.json(), { ip: '192.168.0.47' });
    } finally {
        await app.close();
    }
});

test('a single candidate also answers 200', async () => {
    const app = await startApp(() => ({
        ip: '10.0.0.9', interface: 'eth0', status: 'single',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ip: '10.0.0.9' });
    } finally {
        await app.close();
    }
});

test('not configured answers 409 with the reason and the candidates', async () => {
    const candidates = [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ];
    const app = await startApp(() => ({ ip: null, candidates, status: 'not_configured' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.ip, null);
        assert.equal(body.reason, 'not_configured');
        assert.deepEqual(body.candidates, candidates);
    } finally {
        await app.close();
    }
});

test('stale answers 409 and names the interface that vanished', async () => {
    const app = await startApp(() => ({
        ip: null, candidates: [], status: 'stale', savedInterface: 'usb0',
    }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.reason, 'stale');
        assert.equal(body.savedInterface, 'usb0');
    } finally {
        await app.close();
    }
});

test('no_network answers 409 with an empty candidate list', async () => {
    const app = await startApp(() => ({ ip: null, candidates: [], status: 'no_network' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.reason, 'no_network');
        assert.deepEqual(body.candidates, []);
    } finally {
        await app.close();
    }
});

test('a 409 is not a successful response, which is what keeps the SGA safe', async () => {
    // The SGA does `$response->successful() ? $response->json('ip') : null`, so any
    // 4xx already degrades to null and findScale() treats that as "no workstation".
    // This asserts the property that makes the SGA need no changes.
    const app = await startApp(() => ({ ip: null, candidates: [], status: 'not_configured' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
        assert.equal(res.ok, false);
    } finally {
        await app.close();
    }
});

test('an unexpected status does not answer 200 with a null ip', async () => {
    // Defensive: if resolveLocalIp ever grows a status this route does not know,
    // answering 200 with ip: null would look like success to every caller.
    const app = await startApp(() => ({ ip: null, status: 'something_new' }));
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.notEqual(res.status, 200);
    } finally {
        await app.close();
    }
});

test('resolve() throwing answers 500, not 409, and leaves a trace', async () => {
    // resolve() throwing means the app itself is broken (e.g. a corrupted config
    // file) rather than "the interface merely hasn't been chosen yet". A 409 would
    // send the operator to the tray to pick an interface, which fixes nothing; the
    // SGA maps any non-409 4xx-or-5xx to "unreachable", so 500 keeps that signal.
    const log = fakeLogger();
    const app = await startApp(() => {
        throw new Error('settings.json is corrupt');
    }, log);
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 500);
        assert.notEqual(res.status, 409);
        const body = await res.json();
        assert.equal(body.ip, null);
        // The failure must reach a log, not disappear silently.
        assert.equal(log.errors.length, 1);
    } finally {
        await app.close();
    }
});

test('a working resolve is unaffected by the throw-handling path: 200 body stays byte-equivalent', async () => {
    const app = await startApp(() => ({
        ip: '192.168.0.47', interface: 'enp0s31f6', status: 'configured',
    }), fakeLogger());
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ip: '192.168.0.47' });
    } finally {
        await app.close();
    }
});

test('a not_configured resolve is unaffected by the throw-handling path: 409 body stays as before', async () => {
    const candidates = [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ];
    const app = await startApp(() => ({ ip: null, candidates, status: 'not_configured' }), fakeLogger());
    try {
        const res = await fetch(`${app.base}/ip`);
        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.ip, null);
        assert.equal(body.reason, 'not_configured');
        assert.deepEqual(body.candidates, candidates);
    } finally {
        await app.close();
    }
});
