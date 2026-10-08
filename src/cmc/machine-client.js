const net = require('node:net');
const {
    frame, createFrameReader, parseMessage, buildEnqReply, buildAcknowledgement,
    buildLabelReply, buildHeartbeatReply, MESSAGE_TYPES, ENCODING,
} = require('./protocol');
const { sendZpl } = require('./labeler-client');

const DEFAULT_RECONNECT_MS = 5000;
// Bounds the TCP handshake itself. Without this, a blackholed SYN (a firewall
// or NAT silently dropping packets instead of refusing the connection) would
// leave `connect()` waiting on an event that never fires, occupying
// `pendingSocket` indefinitely instead of scheduling a retry.
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
// Once connected, this is the mechanism that detects a half-open link (machine
// powered off, cable pulled, NAT mapping silently expired): TCP itself has no
// way to notice a peer that stopped acknowledging without probing for it.
const KEEPALIVE_DELAY_MS = 30_000;

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
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
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

    // Serializes deliveries to the same physical labeler so two boxes handled
    // close together cannot interleave their ZPL on the wire (some label
    // printers are line-oriented and will happily merge two concurrent jobs
    // into garbage output). Keyed by "host:port" rather than by labeler index,
    // since two configured labelers could point at the same physical device.
    // Deliberately NOT awaited from handleEnq: this only chains deliverLabels
    // calls against each other, off the ENQ reply path.
    const labelerChains = new Map();
    const withLabelerLock = (labelerHost, labelerPort, task) => {
        const key = `${labelerHost}:${labelerPort}`;
        const previous = labelerChains.get(key) ?? Promise.resolve();
        const settled = previous.catch(() => {}).then(task);
        // Stored with errors swallowed so one failed job never poisons the
        // chain for the next box; the real result/error still flows to the
        // caller through the returned `settled` promise.
        labelerChains.set(key, settled.catch(() => {}));
        return settled;
    };

    const report = (result) => {
        // Verentia requires a barcode on every result, and only the ENQ carries
        // one: the rest of the cycle identifies the box by the reference. For a
        // box that was never in the manifest there is nothing to report under,
        // and sending an empty string had the backend refuse the whole batch -
        // taking the valid results travelling with it down too.
        if (!result.barcode) {
            logger.warn(
                `⚠️ [cmc] ${result.phase} for an unknown reference `
                + `(${result.detail?.reference ?? '?'}): not reported, no barcode to report it under`,
            );

            return;
        }

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
            return;
        }
        // report() upstream of this still records the ENQ as "accepted"
        // (that decision was made from the cache lookup, independent of the
        // link), so this is the only signal that the reply never actually
        // reached the machine.
        logger.warn('⚠️ [cmc] write skipped: no live connection to the machine');
    };

    // Boxes answered at ENQ time, keyed by the reference this bridge assigned
    // them. Every later message of the cycle (IND, ACK, LAB1, END) carries that
    // reference back, and LAB1 is where the label is finally owed, so the box
    // has to survive in between. Dropped on END, which closes the cycle.
    const inFlight = new Map();
    let references = 0;

    /**
     * The reference the machine will replicate through the rest of the cycle.
     *
     * The document has the CIS assign it ("CIS receives the barcode and sends
     * the info related to the item and assigns a `unique' reference"). Sending
     * it empty, as this bridge used to, leaves the whole cycle with no
     * identifier of ours to match a LAB1 back to the box it belongs to.
     */
    const nextReference = () => `V${String(++references).padStart(8, '0')}`;

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
                await withLabelerLock(labeler.host, labeler.port, () => deliver({
                    host: labeler.host,
                    port: labeler.port,
                    content: Buffer.from(payload.content_base64, 'base64').toString(ENCODING),
                }));
            } catch (error) {
                report({
                    barcode: entry.barcode, phase: 'deliver', status: 'error',
                    detail: { reason: error.code ?? 'peripheral', message: error.message, index },
                });
            }
        }
    };

    const handleEnq = (message) => {
        const barcode = message.fields[0] ?? '';
        lastEnqAt = nowIso();

        const entry = cache.lookup(barcode);
        const known = Boolean(entry);
        const reference = nextReference();

        // Reply first. Everything below this line is off the critical path.
        //
        // The machine id and the counter travel back untouched: the protocol
        // defines them as replicated from the request. FLAG_LAB1 is what routes
        // the box past labeller 1, where the label this bridge delivers over
        // the labeller's own socket is applied - so an unknown box leaves it
        // unset and is simply not labelled.
        //
        // MSG_MATCH_LAB1 is the barcode printed on the label, which a reader
        // after the labeller compares against. The box's own code is what our
        // labels carry, so it is declared here rather than left for `lab1'.
        write(buildEnqReply({
            machineId: message.machineId,
            counter: message.counter,
            reference,
            barcode,
            found: known,
            printLabel1: known,
            matchLabel1: known ? barcode : '',
        }));

        if (!entry) {
            report({ barcode, phase: 'enq', status: 'unknown', detail: { batch_id: cache.state().batch_id } });
            return;
        }

        // The label is NOT sent here. The protocol owes it when LAB1 arrives,
        // which is when the box is actually in front of the labeller; sending
        // it at ENQ time is early by a whole conveyor.
        inFlight.set(reference, { barcode, entry });

        report({ barcode, phase: 'enq', status: 'accepted', detail: { labels: entry.label_payloads.length, reference } });
        cache.markDispatched(barcode);
    };

    /**
     * LAB1/LAB2/LAB3: the box is at a labeller and its label is owed now.
     *
     * The reply is due within 1000 ms. If it does not arrive before the box
     * passes under the tamper the machine rejects it, so the reply goes out
     * without waiting for the labeller to finish.
     */
    const handleLabel = (message, index, replyType) => {
        const reference = message.fields[0] ?? '';
        const pending = inFlight.get(reference);
        const labeler = labelers[index];
        const deliverable = Boolean(pending) && Boolean(labeler);

        write(buildLabelReply({
            machineId: message.machineId,
            type: replyType,
            counter: message.counter,
            reference,
            delivered: deliverable,
            match: pending?.barcode ?? '',
        }));

        if (!deliverable) {
            report({
                barcode: pending?.barcode ?? '',
                phase: replyType,
                status: 'error',
                detail: { reason: pending ? 'no_labeler_configured' : 'unknown_reference', reference, index },
            });

            return;
        }

        deliverLabels(pending.entry).catch((error) => {
            logger.error(`❌ [cmc] delivery crashed for ${pending.barcode}: ${error.message}`);
        });
    };

    /**
     * IND, ACK, END and REM: acknowledged, recorded, and nothing else.
     *
     * The machine waits for each of these too. END closes the cycle, so the box
     * stops being held in memory there.
     */
    const handleAcknowledged = (message, replyType) => {
        const reference = message.fields[0] ?? '';

        write(buildAcknowledgement({
            machineId: message.machineId,
            type: replyType,
            counter: message.counter,
            reference,
        }));

        report({
            barcode: inFlight.get(reference)?.barcode ?? '',
            phase: replyType,
            status: 'reported',
            detail: { reference, fields: message.fields },
        });

        if (replyType === MESSAGE_TYPES.END_REPLY || replyType === MESSAGE_TYPES.REM_REPLY) {
            inFlight.delete(reference);
        }
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
            handleEnq(message);
            return;
        }

        // The labelling messages, in the order the labellers sit on the line:
        // the index picks which configured labeller the label is sent to.
        const labelled = {
            [MESSAGE_TYPES.LAB1]: [0, MESSAGE_TYPES.LAB1_REPLY],
            [MESSAGE_TYPES.LAB2]: [1, MESSAGE_TYPES.LAB2_REPLY],
            [MESSAGE_TYPES.LAB3]: [2, MESSAGE_TYPES.LAB3_REPLY],
        }[message.type];

        if (labelled) {
            handleLabel(message, labelled[0], labelled[1]);
            return;
        }

        const acknowledged = {
            [MESSAGE_TYPES.IND]: MESSAGE_TYPES.IND_REPLY,
            [MESSAGE_TYPES.ACK]: MESSAGE_TYPES.ACK_REPLY,
            [MESSAGE_TYPES.END]: MESSAGE_TYPES.END_REPLY,
            [MESSAGE_TYPES.REM]: MESSAGE_TYPES.REM_REPLY,
        }[message.type];

        if (acknowledged) {
            handleAcknowledged(message, acknowledged);
            return;
        }

        if (message.type === MESSAGE_TYPES.HBT) {
            // Alone among the replies it carries no counter: the machine's own
            // HBT arrives without one.
            write(buildHeartbeatReply({ machineId: message.machineId }));
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

            // A missing/invalid host or port would otherwise throw
            // synchronously inside this executor, bypassing onConnectError
            // entirely: the promise would reject but lastError would stay
            // null and scheduleReconnect() would never run, so a
            // misconfigured machine block looks identical to "never tried
            // yet" instead of a reported, retried failure.
            if (!host || !Number.isInteger(port)) {
                onConnectError(new Error(`invalid machine address: host=${host} port=${port}`));
                return;
            }

            next.once('error', onConnectError);

            // Bounds the handshake itself (see DEFAULT_CONNECT_TIMEOUT_MS above).
            next.setTimeout(connectTimeoutMs);
            const onConnectTimeout = () => {
                onConnectError(new Error(`connection to ${host}:${port} timed out after ${connectTimeoutMs}ms`));
            };
            next.once('timeout', onConnectTimeout);

            next.connect(port, host, () => {
                next.removeListener('error', onConnectError);
                next.removeListener('timeout', onConnectTimeout);
                // The timeout above only exists to bound the handshake. A
                // healthy, merely idle connection must not be killed by it,
                // so it is cleared the moment the handshake completes;
                // keepalive (below) takes over as the mechanism for
                // detecting a half-open link once adopted.
                next.setTimeout(0);
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
                // See KEEPALIVE_DELAY_MS above: without this, a machine that
                // goes dark (power off, cable pulled, NAT idle-timeout) never
                // produces a 'close' event on its own, so `connected` would
                // keep reading true and writes would vanish silently.
                next.setKeepAlive(true, KEEPALIVE_DELAY_MS);
                logger.info(`🔌 [cmc] connected to machine ${host}:${port}`);

                next.on('data', (chunk) => {
                    // Any data at all is proof the link is healthy right now,
                    // so a stale error from a previous hiccup (the socket
                    // recovered without ever going through 'close') must not
                    // keep haunting state() forever.
                    lastError = null;
                    for (const payload of read(chunk)) handlePayload(payload);
                });
                next.on('error', (error) => {
                    // Guard against a listener left over from a socket that
                    // has already been replaced (mirrors the same guard on
                    // 'close' below): without it, a straggling event from a
                    // superseded socket could overwrite the current
                    // lastError with a stale, unrelated message.
                    if (socket === next) lastError = error.message;
                });
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

module.exports = { createMachineClient, DEFAULT_RECONNECT_MS, DEFAULT_CONNECT_TIMEOUT_MS };
