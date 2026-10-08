const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createReportQueue } = require('../../src/cmc/report-queue');

const silentLogger = {info() {}, warn() {}, error() {}};

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cmc-queue-'));
}

const result = (barcode) => ({barcode, phase: 'enq', status: 'unknown', occurred_at: '2026-10-08T13:41:18Z'});

/**
 * What happens to a batch Verentia will never accept.
 *
 * Observed against the running backend on 2026-10-08: a report carrying an
 * empty barcode is refused with 422, and because nothing was ever removed from
 * the queue the bridge retried it for as long as it was up. Five results sat
 * there, one of them perfectly valid, and `queued_reports` only climbed.
 *
 * A station that cannot report is silent, and the only sign of it is a warning
 * every few minutes.
 */
test('a batch the backend refuses is set aside instead of retried forever', async () => {
    const baseDir = tempDir();
    const attempts = [];

    const queue = createReportQueue({
        baseDir,
        endpoint: 'http://verentia.test/api/v1/cmc/results',
        stationToken: 'tok',
        logger: silentLogger,
        fetchImpl: async () => {
            attempts.push(Date.now());

            return {
                ok: false,
                status: 422,
                json: async () => ({message: 'El campo results.0.barcode es obligatorio.'}),
            };
        },
    });

    queue.push(result('IT0001'));
    await queue.flush();

    assert.equal(queue.size(), 0, 'a refused batch must leave the queue');

    await queue.flush();
    assert.equal(attempts.length, 1, 'and must never be sent again');

    // Set aside rather than dropped: the machine cycle already happened and the
    // result cannot be recovered from anywhere else.
    const dead = JSON.parse(fs.readFileSync(path.join(baseDir, 'cmc-report-rejected.json'), 'utf8'));

    assert.equal(dead.length, 1);
    assert.equal(dead[0].result.barcode, 'IT0001');
    assert.equal(dead[0].status, 422);
});

test('a batch that failed on the network is kept and retried', async () => {
    const baseDir = tempDir();
    let calls = 0;

    const queue = createReportQueue({
        baseDir,
        endpoint: 'http://verentia.test/api/v1/cmc/results',
        stationToken: 'tok',
        logger: silentLogger,
        fetchImpl: async () => {
            calls++;
            if (calls === 1) throw new Error('fetch failed');

            return {ok: true, status: 200, json: async () => ({})};
        },
    });

    queue.push(result('IT0001'));

    await queue.flush();
    assert.equal(queue.size(), 1, 'a network failure keeps the result');

    await queue.flush();
    assert.equal(queue.size(), 0, 'and it goes out once the backend is back');
});

test('a 5xx is kept and retried, because it may succeed later', async () => {
    const baseDir = tempDir();

    const queue = createReportQueue({
        baseDir,
        endpoint: 'http://verentia.test/api/v1/cmc/results',
        stationToken: 'tok',
        logger: silentLogger,
        fetchImpl: async () => ({ok: false, status: 503, json: async () => ({})}),
    });

    queue.push(result('IT0001'));
    await queue.flush();

    assert.equal(queue.size(), 1);
});

test('the request asks for JSON, so a refusal arrives as a refusal', async () => {
    const baseDir = tempDir();
    let headers = null;

    const queue = createReportQueue({
        baseDir,
        endpoint: 'http://verentia.test/api/v1/cmc/results',
        stationToken: 'tok',
        logger: silentLogger,
        fetchImpl: async (url, options) => {
            headers = options.headers;

            return {ok: true, status: 200, json: async () => ({})};
        },
    });

    queue.push(result('IT0001'));
    await queue.flush();

    // Without this, Laravel answers a validation error with a redirect to the
    // site root. fetch follows it, lands on https, and the self-signed
    // certificate turns a readable 422 into "fetch failed" - which is what the
    // bridge's log actually said while the real cause went unseen.
    assert.equal(headers.Accept, 'application/json');
});
