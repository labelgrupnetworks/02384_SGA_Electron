const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReportQueue } = require('../../src/cmc/report-queue');

const silent = { info() {}, warn() {}, error() {} };

function freshDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-queue-state-'));
}

function queueWith(fetchImpl) {
    return createReportQueue({
        baseDir: freshDir(),
        endpoint: 'http://verentia.test/api/v1/cmc/results',
        stationToken: 'token',
        logger: silent,
        fetchImpl,
    });
}

test('a queue that has never sent anything reports no error and no delivery', () => {
    const queue = queueWith(async () => ({ ok: true, status: 200 }));

    assert.deepEqual(queue.state(), { pending: 0, lastError: null, lastSentAt: null });
});

test('a successful flush records when results last reached Verentia', async () => {
    const queue = queueWith(async () => ({ ok: true, status: 200 }));

    queue.push({ barcode: '2620-1', outcome: 'delivered' });
    await queue.flush();

    const state = queue.state();
    assert.equal(state.pending, 0);
    assert.equal(state.lastError, null);
    assert.ok(state.lastSentAt, 'a successful delivery left no timestamp');
});

test('a refusal is remembered so the panel can show why the station is quiet', async () => {
    // The case this exists for: the queue grows, the log scrolls past, and the
    // station looks healthy because nothing on screen says otherwise.
    const queue = queueWith(async () => ({ ok: false, status: 401 }));

    queue.push({ barcode: '2620-1', outcome: 'delivered' });
    await queue.flush();

    const state = queue.state();
    assert.equal(state.pending, 1, 'a retryable refusal must keep the result queued');
    assert.match(state.lastError, /401/);
});

test('a transport failure is remembered with its reason', async () => {
    const queue = queueWith(async () => {
        throw new Error('fetch failed');
    });

    queue.push({ barcode: '2620-1', outcome: 'delivered' });
    await queue.flush();

    assert.match(queue.state().lastError, /fetch failed/);
});

test('a later success clears the previous error', async () => {
    let fails = true;
    const queue = queueWith(async () => {
        if (fails) throw new Error('fetch failed');

        return { ok: true, status: 200 };
    });

    queue.push({ barcode: '2620-1', outcome: 'delivered' });
    await queue.flush();
    assert.ok(queue.state().lastError, 'precondition: the first attempt failed');

    fails = false;
    await queue.flush();

    assert.equal(queue.state().lastError, null, 'the panel would still show a stale error');
});
