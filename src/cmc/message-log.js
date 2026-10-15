/**
 * The last few protocol messages, for the status panel.
 *
 * electron-log already records all of this, but a log file is the wrong place
 * to look while standing next to a machine with a box going past: you want the
 * last four lines, now, on the screen you already have open.
 *
 * It also puts a number on the two budgets the protocol sets - 500 ms to answer
 * an ENQ, 1000 ms for a LAB1 - which is otherwise only knowable by reading
 * timestamps out of a file.
 */

const { parseMessage } = require('./protocol');

const DEFAULT_LIMIT = 20;
const MAX_PAYLOAD_CHARS = 120;

/**
 * Both directions carry the type in field 1: the machine leads with its own id
 * too, exactly as our replies do. Reading field 0 instead is a mistake this
 * protocol has produced more than once, so the type is taken from the real
 * parser rather than by splitting the string here.
 */
function typeOf(payload) {
    try {
        return parseMessage(String(payload ?? '')).type ?? '';
    } catch {
        // A frame that does not parse is still worth showing - that is the case
        // someone opens the panel to understand.
        return '?';
    }
}

function shorten(payload) {
    const text = String(payload ?? '');

    return text.length <= MAX_PAYLOAD_CHARS
        ? text
        : `${text.slice(0, MAX_PAYLOAD_CHARS)}…`;
}

/**
 * @param {{limit?: number}} options
 */
function createMessageLog({ limit = DEFAULT_LIMIT } = {}) {
    /** @type {Array<{at: string, direction: string, type: string, payload: string, ms: number|null}>} */
    let entries = [];
    let lastReceivedAt = null;

    const push = (entry) => {
        // Newest first: the panel shows the top of this list, and what matters
        // is what just happened.
        entries.unshift(entry);
        if (entries.length > limit) {
            entries = entries.slice(0, limit);
        }
    };

    return {
        /** A frame from the machine. */
        received(payload, now = Date.now()) {
            lastReceivedAt = now;
            push({
                at: new Date(now).toISOString(),
                direction: 'in',
                type: typeOf(payload),
                payload: shorten(payload),
                ms: null,
            });
        },

        /** A frame to the machine. */
        sent(payload, now = Date.now()) {
            push({
                at: new Date(now).toISOString(),
                direction: 'out',
                type: typeOf(payload),
                payload: shorten(payload),
                // Only when it answers something. A heartbeat reply sent on our
                // own initiative would otherwise carry the age of whatever
                // arrived last, which looks like a very slow answer.
                ms: lastReceivedAt === null ? null : now - lastReceivedAt,
            });
            lastReceivedAt = null;
        },

        entries() {
            return entries;
        },
    };
}

module.exports = { createMessageLog, DEFAULT_LIMIT };
