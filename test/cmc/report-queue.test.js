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
