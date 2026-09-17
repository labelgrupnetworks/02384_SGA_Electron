const test = require('node:test');
const assert = require('node:assert/strict');
const { createManifestCache } = require('../../src/cmc/manifest-cache');

const entry = (barcode) => ({
    barcode,
    label_payloads: [{ content_base64: Buffer.from(`^XA${barcode}^XZ`).toString('base64'), content_type: 'application/zpl', filename: `${barcode}.zpl` }],
});

test('an empty cache resolves nothing', () => {
    const cache = createManifestCache();
    assert.equal(cache.lookup('123'), null);
    assert.equal(cache.state().total, 0);
    assert.equal(cache.state().batch_id, null);
});

test('replace loads a batch and lookup resolves its entries', () => {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111'), entry('222')] });

    assert.equal(cache.lookup('111').barcode, '111');
    assert.equal(cache.lookup('222').label_payloads.length, 1);
    assert.equal(cache.lookup('999'), null);
    assert.equal(cache.state().batch_id, 'B1');
    assert.equal(cache.state().total, 2);
});

test('replace wipes the previous batch instead of merging', () => {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111')] });
    cache.replace({ batch_id: 'B2', entries: [entry('222')] });

    assert.equal(cache.lookup('111'), null);
    assert.ok(cache.lookup('222'));
    assert.equal(cache.state().batch_id, 'B2');
    assert.equal(cache.state().total, 1);
});

test('markDispatched moves an entry from pending to dispatched', () => {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111'), entry('222')] });

    cache.markDispatched('111');

    assert.equal(cache.state().dispatched, 1);
    assert.equal(cache.state().pending, 1);
    // Still resolvable: a reread of the same box must not fail.
    assert.ok(cache.lookup('111'));
});

test('a malformed manifest is rejected', () => {
    const cache = createManifestCache();
    assert.throws(() => cache.replace(null), /bad_manifest/);
    assert.throws(() => cache.replace({ entries: [] }), /batch_id/);
    assert.throws(() => cache.replace({ batch_id: 'B', entries: 'nope' }), /entries/);
    assert.throws(() => cache.replace({ batch_id: 'B', entries: [{ barcode: '' }] }), /barcode/);
});

test('a rejected manifest leaves the previous batch untouched', () => {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111')] });

    assert.throws(() => cache.replace({ batch_id: 'B2', entries: 'nope' }));

    assert.ok(cache.lookup('111'));
    assert.equal(cache.state().batch_id, 'B1');
});

test('duplicate barcodes in one manifest are rejected', () => {
    const cache = createManifestCache();
    assert.throws(
        () => cache.replace({ batch_id: 'B', entries: [entry('111'), entry('111')] }),
        /duplicate/,
    );
});

test('a label payload missing content_base64 is rejected', () => {
    const cache = createManifestCache();
    const badEntry = {
        barcode: '111',
        label_payloads: [{ content_type: 'application/zpl', filename: '111.zpl' }],
    };
    assert.throws(
        () => cache.replace({ batch_id: 'B', entries: [badEntry] }),
        /content_base64/,
    );
});

test('a label payload with malformed content_base64 is rejected', () => {
    const cache = createManifestCache();
    const badEntry = {
        barcode: '111',
        label_payloads: [{ content_base64: 'not-valid-base64!!!', content_type: 'application/zpl', filename: '111.zpl' }],
    };
    assert.throws(
        () => cache.replace({ batch_id: 'B', entries: [badEntry] }),
        /malformed content_base64/,
    );
});

test('a manifest with an invalid label payload leaves the previous batch untouched', () => {
    const cache = createManifestCache();
    cache.replace({ batch_id: 'B1', entries: [entry('111')] });

    const badEntry = { barcode: '222', label_payloads: [{ content_base64: '' }] };
    assert.throws(() => cache.replace({ batch_id: 'B2', entries: [badEntry] }));

    assert.ok(cache.lookup('111'));
    assert.equal(cache.state().batch_id, 'B1');
});
