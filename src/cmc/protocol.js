const STX = 0x02;
const ETX = 0x03;
const SEPARATOR = '|';
const ENCODING = 'latin1';

// PENDING: the field separator, the reply tokens below and the exact set of
// message types are provisional. CMC-DataProtocol_4.1.pdf has not been read in
// full, and REQ-bsalamanca-023 mentions a "custom CMC message" that may differ
// from the manufacturer's generic protocol. Everything uncertain is kept in this
// file on purpose: when the real contract arrives, nothing outside it changes.
const MESSAGE_TYPES = Object.freeze({
    ENQ: 'ENQ',   // machine asks what to do with a barcode
    ENQ_REPLY: 'enq',
    LABEL: 'LAB',  // bridge pushes a label to the machine's labeler
    ACK: 'ACK',   // machine reports the induction outcome
});

// PENDING: confirm the accept/reject tokens against the protocol document.
const ENQ_ACCEPT = 'A';
const ENQ_REJECT = 'R';

function frame(payload) {
    return Buffer.concat([
        Buffer.from([STX]),
        Buffer.from(String(payload), ENCODING),
        Buffer.from([ETX]),
    ]);
}

/**
 * Stateful reader over a byte stream: feed it chunks, get back the payloads of
 * whatever complete frames those chunks closed.
 *
 * A frame can arrive split across chunks, several can arrive in one chunk, and
 * bytes outside STX..ETX are noise and dropped. The buffer only ever holds the
 * frame currently being assembled.
 */
function createFrameReader() {
    let buffer = Buffer.alloc(0);

    return function read(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const payloads = [];

        for (;;) {
            const start = buffer.indexOf(STX);
            if (start === -1) {
                buffer = Buffer.alloc(0);
                break;
            }

            const end = buffer.indexOf(ETX, start + 1);
            if (end === -1) {
                buffer = buffer.subarray(start);
                break;
            }

            payloads.push(buffer.subarray(start + 1, end).toString(ENCODING));
            buffer = buffer.subarray(end + 1);
        }

        return payloads;
    };
}

function parseMessage(payload) {
    if (typeof payload !== 'string' || payload.length === 0) {
        throw new Error('empty message');
    }

    const [type, ...fields] = payload.split(SEPARATOR);

    return { type, fields };
}

function buildEnqReply({ accepted }) {
    return [MESSAGE_TYPES.ENQ_REPLY, accepted ? ENQ_ACCEPT : ENQ_REJECT].join(SEPARATOR);
}

module.exports = {
    STX, ETX, SEPARATOR, ENCODING, MESSAGE_TYPES,
    frame, createFrameReader, parseMessage, buildEnqReply,
};
