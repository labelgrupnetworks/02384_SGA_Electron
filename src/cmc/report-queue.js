const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'cmc-report-queue.json';
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

    const queue = {
        push(result) {
            pending.push({ ...result, id: crypto.randomUUID() });
            persist();
        },

        size() {
            return pending.length;
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
                        'X-CMC-Station-Token': stationToken,
                    },
                    body: JSON.stringify({ results: batch }),
                    signal: AbortSignal.timeout(timeoutMs),
                });

                if (!response.ok) {
                    logger.warn(`⚠️ [cmc] Verentia responded ${response.status} to report; will retry`);
                    currentDelayMs = Math.min(currentDelayMs * 2, maxBackoffMs);
                    return;
                }

                const sent = new Set(batch.map((item) => item.id));
                pending = pending.filter((item) => !sent.has(item.id));
                persist();
                logger.info(`📤 [cmc] ${batch.length} results reported`);
                currentDelayMs = flushMs;
            } catch (error) {
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
