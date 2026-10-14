const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'cmc-report-queue.json';
// Results the backend refused. They never become sendable, so they leave the
// queue, but they are not thrown away: the machine cycle they describe already
// happened.
const REJECTED_FILE_NAME = 'cmc-report-rejected.json';
// The statuses that say the payload itself is the problem: no amount of
// retrying makes these batches sendable. 422 is the one seen in the field —
// Verentia refuses a result whose barcode is empty.
const UNSENDABLE_STATUSES = new Set([400, 413, 422]);
const DEFAULT_FLUSH_MS = 5000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 4500;
// Caps how long a fully-down Verentia backend makes the bridge wait between
// retries. Without a cap, doubling forever would eventually mean waiting
// hours between attempts; a few minutes keeps recovery reasonably prompt
// once the backend comes back, while still backing off a busy/erroring one.
const DEFAULT_MAX_BACKOFF_MS = 180_000;

/**
 * Outbound results, queued on disk.
 *
 * `push` is called from the ENQ path, so it never touches the network: it appends,
 * persists and returns. Sending happens on a timer, and a failed send keeps its
 * items rather than dropping them — the machine cycle has already happened and a
 * lost result cannot be recovered from anywhere else.
 *
 * Each result carries a uuid so a resend after a network outage is recognisable
 * as the same event. PENDING: the Laravel side must dedupe on it.
 */
function createReportQueue({
    baseDir,
    endpoint,
    stationToken,
    logger,
    fetchImpl = globalThis.fetch,
    flushMs = DEFAULT_FLUSH_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
}) {
    const filePath = path.join(baseDir, FILE_NAME);
    let timer = null;
    let flushing = false;
    // Backing off on a per-attempt basis rather than retrying at a fixed
    // interval: a Verentia outage that lasts minutes should not be hammered
    // every `flushMs`. Resets to `flushMs` the moment a flush succeeds, so a
    // recovered backend is noticed again promptly instead of staying on a
    // long-delay schedule from the earlier outage.
    let currentDelayMs = flushMs;

    const load = () => {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            if (error.code !== 'ENOENT') {
                // Move corrupt file aside for inspection, don't silently drop it
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const corruptPath = `${filePath}.corrupt-${timestamp}`;
                try {
                    fs.renameSync(filePath, corruptPath);
                    logger.warn(`⚠️ [cmc] report queue corrupted, moved to ${path.basename(corruptPath)}, starting empty`);
                } catch (renameError) {
                    logger.warn(`⚠️ [cmc] report queue unreadable and could not be moved aside: ${renameError.message}`);
                }
            }
            return [];
        }
    };

    let pending = load();

    const persist = () => {
        try {
            fs.mkdirSync(baseDir, { recursive: true });
            // Write to temp file first, then rename atomically to avoid corruption on crash
            const tempPath = `${filePath}.tmp`;
            fs.writeFileSync(tempPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
            fs.renameSync(tempPath, filePath);
        } catch (error) {
            logger.error(`❌ [cmc] failed to persist report queue: ${error.message}`);
        }
    };

    /**
     * Moves a refused batch out of the queue and onto disk.
     *
     * Set aside rather than dropped: the machine cycle already happened and a
     * lost result cannot be recovered from anywhere else. Somebody has to look
     * at these, so they are kept with the status and the reason the backend
     * gave, and the failure is logged at error level rather than as a warning
     * among the retries.
     */
    const setAside = async (batch, response) => {
        let reason = '';
        try {
            reason = JSON.stringify(await response.json());
        } catch {
            reason = `HTTP ${response.status}`;
        }

        const rejectedPath = path.join(baseDir, REJECTED_FILE_NAME);
        let rejected = [];

        try {
            rejected = JSON.parse(fs.readFileSync(rejectedPath, 'utf8'));
            if (!Array.isArray(rejected)) rejected = [];
        } catch {
            rejected = [];
        }

        const at = new Date().toISOString();
        for (const result of batch) {
            rejected.push({ at, status: response.status, reason, result });
        }

        try {
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(rejectedPath, `${JSON.stringify(rejected, null, 2)}\n`, 'utf8');
        } catch (error) {
            logger.error(`❌ [cmc] could not set aside the refused batch: ${error.message}`);

            return;
        }

        const refused = new Set(batch.map((item) => item.id));
        pending = pending.filter((item) => !refused.has(item.id));
        persist();

        logger.error(
            `❌ [cmc] Verentia refused ${batch.length} result(s) with ${response.status}; `
            + `set aside in ${REJECTED_FILE_NAME}: ${reason}`,
        );
    };

    // What the status panel shows. The log already carries all of this, but a
    // log scrolls: a station whose reports stopped reaching Verentia looks
    // exactly like one with nothing to report unless the last failure is kept.
    let lastError = null;
    let lastSentAt = null;

    const queue = {
        push(result) {
            pending.push({ ...result, id: crypto.randomUUID() });
            persist();
        },

        size() {
            return pending.length;
        },

        state() {
            return { pending: pending.length, lastError, lastSentAt };
        },

        async flush() {
            if (flushing || pending.length === 0) {
                return;
            }

            flushing = true;
            const batch = pending.slice(0, batchSize);

            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        // Without this Laravel answers a validation error with a
                        // redirect to the site root; fetch follows it, lands on
                        // https, and a self-signed certificate turns a readable
                        // 422 into "fetch failed". The reason never reaches the
                        // log, which is exactly how one went unnoticed.
                        Accept: 'application/json',
                        'X-CMC-Station-Token': stationToken,
                    },
                    body: JSON.stringify({ results: batch }),
                    signal: AbortSignal.timeout(timeoutMs),
                });

                // A refusal of the CONTENT is not a failed delivery: the backend
                // received the batch and will not accept it however many times
                // it is sent. Retrying holds the head of the queue forever, and
                // since a batch is validated as a whole, one malformed result
                // drags every valid one travelling with it. The station then
                // goes quiet with nothing but a warning every few minutes.
                //
                // Deliberately not every 4xx. A 401 or a 404 is the environment
                // being wrong - a stale token, the wrong endpoint - and the
                // same payload goes through untouched once that is fixed, so
                // those keep retrying.
                if (!response.ok && UNSENDABLE_STATUSES.has(response.status)) {
                    lastError = `Verentia rechazó ${batch.length} resultado(s) con ${response.status}`;
                    await setAside(batch, response);

                    return;
                }

                if (!response.ok) {
                    lastError = `Verentia respondió ${response.status}; se reintentará`;
                    logger.warn(`⚠️ [cmc] Verentia responded ${response.status} to report; will retry`);
                    currentDelayMs = Math.min(currentDelayMs * 2, maxBackoffMs);
                    return;
                }

                const sent = new Set(batch.map((item) => item.id));
                pending = pending.filter((item) => !sent.has(item.id));
                persist();
                logger.info(`📤 [cmc] ${batch.length} results reported`);
                lastError = null;
                lastSentAt = new Date().toISOString();
                currentDelayMs = flushMs;
            } catch (error) {
                lastError = error.message;
                logger.warn(`⚠️ [cmc] failed to report, will retry: ${error.message}`);
                currentDelayMs = Math.min(currentDelayMs * 2, maxBackoffMs);
            } finally {
                flushing = false;
            }
        },

        start() {
            if (timer) return;
            const scheduleNext = () => {
                timer = setTimeout(async () => {
                    await queue.flush().catch(() => {});
                    scheduleNext();
                }, currentDelayMs);
                if (typeof timer.unref === 'function') timer.unref();
            };
            scheduleNext();
        },

        stop() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };

    return queue;
}

module.exports = { createReportQueue, DEFAULT_FLUSH_MS, DEFAULT_BATCH_SIZE, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BACKOFF_MS };
