const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReportQueue } = require('../../src/cmc/report-queue');

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-queue-'));
}

const result = (barcode) => ({ barcode, phase: 'enq', status: 'accepted', detail: null, occurred_at: '2026-09-15T08:00:00.000Z' });

function okFetch(calls) {
    return async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return { ok: true, status: 200 };
    };
}

test('push stamps an id and persists to disk', () => {
    const baseDir = tempDir();
    const queue = createReportQueue({ baseDir, endpoint: 'https://x/api', stationToken: 't', logger: silentLogger });

    queue.push(result('111'));

    assert.equal(queue.size(), 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(baseDir, 'cmc-report-queue.json'), 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.match(onDisk[0].id, /^[0-9a-f-]{36}$/);
});

test('a queue reloads what a previous run left on disk', () => {
    const baseDir = tempDir();
    const first = createReportQueue({ baseDir, endpoint: 'https://x/api', stationToken: 't', logger: silentLogger });
    first.push(result('111'));

    const second = createReportQueue({ baseDir, endpoint: 'https://x/api', stationToken: 't', logger: silentLogger });

    assert.equal(second.size(), 1);
});

test('flush posts the batch with the station token and empties the queue', async () => {
    const calls = [];
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://verentia/api/v1/cmc/results',
        stationToken: 'secret', logger: silentLogger, fetchImpl: okFetch(calls),
    });

    queue.push(result('111'));
    queue.push(result('222'));
    await queue.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://verentia/api/v1/cmc/results');
    assert.equal(calls[0].options.headers['X-CMC-Station-Token'], 'secret');
    assert.equal(calls[0].body.results.length, 2);
    assert.equal(queue.size(), 0);
});

test('a failed flush keeps the results for the next attempt', async () => {
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't', logger: silentLogger,
        fetchImpl: async () => { throw new Error('network down'); },
    });

    queue.push(result('111'));
    await queue.flush();

    assert.equal(queue.size(), 1);
});

test('a non-2xx response also keeps the results', async () => {
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't', logger: silentLogger,
        fetchImpl: async () => ({ ok: false, status: 401 }),
    });

    queue.push(result('111'));
    await queue.flush();

    assert.equal(queue.size(), 1);
});

test('results survive across a failure and are resent intact', async () => {
    const baseDir = tempDir();
    const calls = [];
    let failing = true;
    const queue = createReportQueue({
        baseDir, endpoint: 'https://x/api', stationToken: 't', logger: silentLogger,
        fetchImpl: async (url, options) => {
            if (failing) throw new Error('down');
            return okFetch(calls)(url, options);
        },
    });

    queue.push(result('111'));
    await queue.flush();
    failing = false;
    await queue.flush();

    assert.equal(calls[0].body.results[0].barcode, '111');
    assert.equal(queue.size(), 0);
});

test('flush on an empty queue does not call the network', async () => {
    const calls = [];
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't',
        logger: silentLogger, fetchImpl: okFetch(calls),
    });

    await queue.flush();

    assert.equal(calls.length, 0);
});

test('flush sends at most batchSize results per call', async () => {
    const calls = [];
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't',
        logger: silentLogger, fetchImpl: okFetch(calls), batchSize: 2,
    });

    queue.push(result('111'));
    queue.push(result('222'));
    queue.push(result('333'));
    await queue.flush();

    assert.equal(calls[0].body.results.length, 2);
    assert.equal(queue.size(), 1);
});

test('a hung fetch times out and keeps items, and the same queue can flush right after', async () => {
    const calls = [];
    // 'hang' only settles when the real AbortSignal actually fires (mirrors
    // what a real fetch() implementation does on cancellation) rather than
    // reacting to `options.signal` merely being present, which is always
    // true since flush() always passes one. Switched to 'succeed' after the
    // abort to prove the `flushing` guard was released on the SAME queue
    // instance, instead of standing up a second queue with a different temp
    // dir that never touched the guard being tested.
    let behavior = 'hang';
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't',
        logger: silentLogger,
        fetchImpl: async (url, options) => {
            if (behavior === 'hang') {
                return new Promise((resolve, reject) => {
                    // AbortSignal.timeout()'s own internal timer is unref'd,
                    // so with nothing else pending, Node would consider the
                    // event loop idle and exit before the abort ever fires.
                    // This ref'd keep-alive timer only holds the process
                    // open; the actual abort decision still comes solely
                    // from `options.signal` firing.
                    const keepAlive = setInterval(() => {}, 1000);
                    options.signal.addEventListener('abort', () => {
                        clearInterval(keepAlive);
                        reject(new Error('The operation was aborted'));
                    });
                });
            }
            return okFetch(calls)(url, options);
        },
        timeoutMs: 50,
    });

    queue.push(result('111'));
    await queue.flush();

    // Items preserved after a genuine timeout abort.
    assert.equal(queue.size(), 1);

    // Guard released: the same queue must flush successfully right after.
    behavior = 'succeed';
    await queue.flush();

    assert.equal(calls.length, 1);
    assert.equal(queue.size(), 0);
});

test('flushing guard prevents concurrent flush calls', async () => {
    const calls = [];
    let holdFirst = true;
    const holdResolver = { resolve: null };
    const holdPromise = new Promise(resolve => {
        holdResolver.resolve = resolve;
    });

    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't',
        logger: silentLogger,
        fetchImpl: async (url, options) => {
            if (holdFirst) {
                // Wait for explicit signal before returning
                await holdPromise;
            }
            return okFetch(calls)(url, options);
        },
    });

    queue.push(result('111'));

    // Fire two flush calls without awaiting the first
    const flush1 = queue.flush();
    const flush2 = queue.flush(); // Should be a no-op while flush1 is in flight

    // Give both promises a microtask to start
    await new Promise(resolve => setImmediate(resolve));

    // Release the hold and wait for both to complete
    holdResolver.resolve();
    await flush1;
    await flush2;

    // Only one network call should have been made despite two flush() invocations
    assert.equal(calls.length, 1);
    assert.equal(queue.size(), 0);
});

test('start() backs off exponentially on repeated failures, capped at maxBackoffMs', async () => {
    const timestamps = [];
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't', logger: silentLogger,
        flushMs: 15,
        maxBackoffMs: 60,
        fetchImpl: async () => {
            timestamps.push(Date.now());
            return { ok: false, status: 500 };
        },
    });

    queue.push(result('111'));
    queue.start();
    // Enough real time for several attempts: 15, 30, 60, 60, 60... capped.
    await new Promise((resolve) => setTimeout(resolve, 260));
    queue.stop();

    assert.ok(timestamps.length >= 4, `expected several retries, got ${timestamps.length}`);
    const gaps = [];
    for (let i = 1; i < timestamps.length; i += 1) {
        gaps.push(timestamps[i] - timestamps[i - 1]);
    }

    // The first retry follows close to flushMs...
    assert.ok(gaps[0] < 45, `first gap should be near flushMs (15ms), got ${gaps[0]}`);
    // ...later gaps grow well past it as failures keep piling up...
    const lastGap = gaps[gaps.length - 1];
    assert.ok(lastGap > gaps[0], `backoff should have grown, first=${gaps[0]} last=${lastGap}`);
    // ...but never past the cap (with generous slack for scheduler jitter).
    assert.ok(lastGap <= 120, `backoff must be capped near maxBackoffMs (60ms), got ${lastGap}`);
});

test('a successful flush resets the backoff delay back to flushMs', async () => {
    const timestamps = [];
    let callCount = 0;
    const queue = createReportQueue({
        baseDir: tempDir(), endpoint: 'https://x/api', stationToken: 't', logger: silentLogger,
        flushMs: 15,
        maxBackoffMs: 500,
        fetchImpl: async () => {
            callCount += 1;
            timestamps.push(Date.now());
            // Fail enough times to build up real backoff, then start
            // succeeding — but keep succeeding so the queue stays non-empty
            // (a new item is pushed after each success) and start()'s loop
            // keeps scheduling attempts at whatever delay it currently holds.
            return callCount <= 2 ? { ok: false, status: 500 } : { ok: true, status: 200 };
        },
    });

    queue.push(result('111'));
    queue.start();

    // Let it fail twice (backing off past flushMs), then succeed once.
    await new Promise((resolve) => setTimeout(resolve, 90));
    // Re-arm the queue with fresh work so the loop keeps attempting.
    queue.push(result('222'));
    const attemptsBeforeReset = callCount;
    await new Promise((resolve) => setTimeout(resolve, 60));
    queue.stop();

    // After the reset, the next attempt should follow quickly (close to
    // flushMs) instead of waiting out the much longer backoff the earlier
    // failures had built up — observable as extra attempts fitting inside
    // this short window.
    assert.ok(
        callCount > attemptsBeforeReset,
        `expected at least one more attempt shortly after the reset, had ${attemptsBeforeReset}, now ${callCount}`,
    );
});
