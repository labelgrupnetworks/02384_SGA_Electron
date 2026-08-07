// test/config/store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../src/config/store');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'verentia-store-'));
}

test('reading a store that was never written gives an empty object', () => {
    const store = createStore(path.join(tempDir(), 'does-not-exist-yet'));

    assert.deepEqual(store.read(), {});
});

test('what is written can be read back', () => {
    const store = createStore(tempDir());

    store.write({ interface: 'enp0s31f6' });

    assert.deepEqual(store.read(), { interface: 'enp0s31f6' });
});

test('writing twice keeps the last value', () => {
    const store = createStore(tempDir());

    store.write({ interface: 'eth0' });
    store.write({ interface: 'wlan0' });

    assert.equal(store.read().interface, 'wlan0');
});

test('it creates the directory when it does not exist', () => {
    const nested = path.join(tempDir(), 'deep', 'nested');
    const store = createStore(nested);

    store.write({ interface: 'eth0' });

    assert.equal(store.read().interface, 'eth0');
    assert.ok(fs.existsSync(nested));
});

test('corrupt JSON reads as unconfigured instead of throwing', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, '{ this is not json');

    // Preferring "unconfigured" over a crash means the app starts and asks again,
    // rather than refusing to boot over a damaged settings file.
    assert.deepEqual(store.read(), {});
});

test('valid JSON that is not an object reads as unconfigured', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, '"just a string"');

    assert.deepEqual(store.read(), {});
});

test('null reads as unconfigured', () => {
    const dir = tempDir();
    const store = createStore(dir);
    fs.writeFileSync(store.path, 'null');

    assert.deepEqual(store.read(), {});
});

test('path points inside the given directory', () => {
    const dir = tempDir();
    const store = createStore(dir);

    assert.equal(path.dirname(store.path), dir);
});
