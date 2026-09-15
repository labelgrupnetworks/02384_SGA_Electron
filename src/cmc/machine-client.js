const net = require('node:net');
const {
    frame, createFrameReader, parseMessage, buildEnqReply, MESSAGE_TYPES, ENCODING,
} = require('./protocol');
const { sendZpl } = require('./labeler-client');

const DEFAULT_RECONNECT_MS = 5000;

function nowIso() {
    return new Date().toISOString();
}

/**
 * Persistent link to the CMC machine, and the ENQ loop on top of it.
 *
 * The ordering inside `handleEnq` is the heart of the whole design: the cache
 * lookup is synchronous and the reply is written immediately, before any labeler
 * is touched. Delivery happens afterwards and is never awaited on the reply path,
 * so a slow or dead labeler cannot eat into the machine's 500 ms budget.
 */
function createMachineClient({
    host,
    port,
    cache,
    labelers = [],
    logger,
    onResult = () => {},
    deliver = sendZpl,
    reconnectMs = DEFAULT_RECONNECT_MS,
}) {
    let socket = null;
    // Tracks a connection attempt that hasn't finished its handshake yet, so
    // stop() can reclaim it: `socket` itself is only assigned once the
    // handshake completes, which is too late for stop() to reach it there.
    let pendingSocket = null;
    let pendingSettle = null;
    let reconnectTimer = null;
    let stopped = false;
    let connected = false;
    let lastError = null;
    let lastEnqAt = null;

    const report = (result) => {
        try {
            const outcome = onResult({ occurred_at: nowIso(), ...result });
            // onResult may be async: a synchronous throw is caught above, but a
            // promise that rejects later would otherwise surface as an
            // unhandled rejection. Attach a catch without awaiting, so report()
            // stays synchronous — it sits on the ENQ reply path.
            if (outcome && typeof outcome.then === 'function') {
                outcome.catch((error) => {
                    logger.error(`❌ [cmc] onResult rejected: ${error.message}`);
                });
            }
        } catch (error) {
            logger.error(`❌ [cmc] onResult threw: ${error.message}`);
        }
    };

    const write = (payload) => {
        if (socket && !socket.destroyed) {
            socket.write(frame(payload));
        }
    };

    // Runs after the reply is already on the wire. Errors here are recorded
    // against the unit, never propagated into the ENQ path.
    const deliverLabels = async (entry) => {
        for (const [index, payload] of entry.label_payloads.entries()) {
            const labeler = labelers[index];

            if (!labeler) {
                report({
                    barcode: entry.barcode, phase: 'deliver', status: 'error',
                    detail: { reason: 'no_labeler_configured', index },
                });
                continue;
            }

            try {
                await deliver({
                    host: labeler.host,
                    port: labeler.port,
                    content: Buffer.from(payload.content_base64, 'base64').toString(ENCODING),
                });
            } catch (error) {
                report({
                    barcode: entry.barcode, phase: 'deliver', status: 'error',
                    detail: { reason: error.code ?? 'peripheral', message: error.message, index },
                });
            }
        }
    };

    const handleEnq = (fields) => {
        const barcode = fields[0] ?? '';
        lastEnqAt = nowIso();

        const entry = cache.lookup(barcode);

        // Reply first. Everything below this line is off the critical path.
        write(buildEnqReply({ accepted: Boolean(entry) }));

        if (!entry) {
            report({ barcode, phase: 'enq', status: 'unknown', detail: { batch_id: cache.state().batch_id } });
            return;
        }

        report({ barcode, phase: 'enq', status: 'accepted', detail: { labels: entry.label_payloads.length } });
        cache.markDispatched(barcode);

        deliverLabels(entry).catch((error) => {
            logger.error(`❌ [cmc] delivery crashed for ${barcode}: ${error.message}`);
        });
    };

    const handlePayload = (payload) => {
        let message;
        try {
            message = parseMessage(payload);
        } catch (error) {
            logger.warn(`⚠️ [cmc] unparseable frame: ${error.message}`);
            return;
        }

        if (message.type === MESSAGE_TYPES.ENQ) {
            handleEnq(message.fields);
            return;
        }

        if (message.type === MESSAGE_TYPES.ACK) {
            report({
                barcode: message.fields[0] ?? '',
                phase: 'ack',
                status: 'reported',
                detail: { fields: message.fields },
            });
            return;
        }

        logger.warn(`⚠️ [cmc] unhandled message type ${message.type}`);
    };

    const scheduleReconnect = () => {
        if (stopped || reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch(() => {});
        }, reconnectMs);
    };

    function connect() {
        return new Promise((resolve, reject) => {
            const next = new net.Socket();
            const read = createFrameReader();

            pendingSocket = next;
            pendingSettle = { resolve, reject };

            const clearPending = () => {
                if (pendingSocket === next) pendingSocket = null;
                if (pendingSettle && pendingSettle.resolve === resolve) pendingSettle = null;
            };

            const onConnectError = (error) => {
                clearPending();
                next.destroy();
                lastError = error.message;
                connected = false;
                scheduleReconnect();
                reject(error);
            };

            next.once('error', onConnectError);

            next.connect(port, host, () => {
                next.removeListener('error', onConnectError);
                clearPending();

                // The client was stopped while this handshake was still in
                // flight. stop() could not reach this socket earlier (it was
                // not yet `socket`), so the adoption is refused here instead:
                // no `socket` assignment, no `connected`, no handlers wired up.
                if (stopped) {
                    next.destroy();
                    resolve();
                    return;
                }

                socket = next;
                connected = true;
                lastError = null;
                logger.info(`🔌 [cmc] connected to machine ${host}:${port}`);

                next.on('data', (chunk) => {
                    for (const payload of read(chunk)) handlePayload(payload);
                });
                next.on('error', (error) => { lastError = error.message; });
                next.on('close', () => {
                    if (socket === next) {
                        socket = null;
                        connected = false;
                        logger.warn('⚠️ [cmc] machine closed the connection');
                        scheduleReconnect();
                    }
                });

                resolve();
            });
        });
    }

    return {
        start() {
            stopped = false;
            return connect();
        },

        async stop() {
            stopped = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (pendingSocket) {
                // Reclaim a handshake that is still in flight. This alone
                // cannot stop the connect callback from firing regardless
                // (see the `stopped` check inside it), but it does mean the
                // socket is destroyed and start()'s promise settles here
                // rather than waiting on an event that may never come.
                const inFlight = pendingSocket;
                const settle = pendingSettle;
                pendingSocket = null;
                pendingSettle = null;
                inFlight.removeAllListeners();
                inFlight.destroy();
                if (settle) settle.resolve(); // being stopped is not an error
            }
            if (socket) {
                const current = socket;
                socket = null;
                current.removeAllListeners();
                current.destroy();
            }
            connected = false;
        },

        state() {
            return { connected, last_error: lastError, last_enq_at: lastEnqAt };
        },
    };
}

module.exports = { createMachineClient, DEFAULT_RECONNECT_MS };
