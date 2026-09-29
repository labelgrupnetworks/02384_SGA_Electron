const STX = 0x02;
const ETX = 0x03;
const SEPARATOR = '|';
const ENCODING = 'latin1';

// CMC-DataProtocol_4.1.pdf, section "Be carefully": "Any message cannot be
// longer than 32Kb". If a frame opened with STX never closes with ETX, and its
// buffered run exceeds this limit, the buffer is discarded and scanning resumes
// for the next STX, treating the unterminated run as noise.
const MAX_FRAME_BYTES = 32768;

// The message catalogue of the protocol document. Capitalised names are
// requests (machine to CIS) and their lower-case twin is the reply the CIS must
// send back: every message is paired.
//
// One documented inconsistency: MESSAGE "ENQ" states MSG_TYPE is 3 chars fixed,
// while the labelling messages are defined as LAB1/LAB2/LAB3, which are four.
// The section names are taken as authoritative here; confirm against CMCDPsim.
const MESSAGE_TYPES = Object.freeze({
    ENQ: 'ENQ',    // barcode read at the start of the line
    IND: 'IND',    // induction
    ACK: 'ACK',    // induction outcome, after the 3D bars
    INV: 'INV',    // print the invoice on the laser printer
    LAB1: 'LAB1',  // box approaching labeller 1
    LAB2: 'LAB2',  // box approaching labeller 2
    LAB3: 'LAB3',  // box approaching labeller 3
    END: 'END',    // end of cycle
    REM: 'REM',    // remove
    HBT: 'HBT',    // heartbeat
    STS: 'STS',    // status
    ENQ_REPLY: 'enq',
});

// MSG_RESULT of the `enq' reply: "0 = Error/Not found  1 = Good Item".
const RESULT_GOOD = '1';
const RESULT_NOT_FOUND = '0';

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
                // If the unterminated frame exceeds MAX_FRAME_BYTES, discard it
                // and treat it as noise; resume scanning for the next STX.
                if (buffer.length - start > MAX_FRAME_BYTES) {
                    buffer = buffer.subarray(start + 1);
                    continue;
                }
                buffer = buffer.subarray(start);
                break;
            }

            payloads.push(buffer.subarray(start + 1, end).toString(ENCODING));
            buffer = buffer.subarray(end + 1);
        }

        return payloads;
    };
}

/**
 * Splits a frame payload into its documented head and the rest of its fields.
 *
 * The frame is `MACHINE_ID|TYPE|COUNTER|...`, so the type is the SECOND field,
 * not the first. `fields` holds what follows the counter, which is what each
 * message type defines for itself — for an ENQ, the barcode and its source.
 *
 * The machine id and the counter are returned because the reply has to echo
 * them back: the document defines them as "replicated by" the request.
 */
function parseMessage(payload) {
    if (typeof payload !== 'string' || payload.length === 0) {
        throw new Error('empty message');
    }

    const parts = payload.split(SEPARATOR);

    // Every field is closed by the separator, the last one included, so the
    // split leaves one empty element past the final field. That element is the
    // terminator, not a field: an empty value the message really carries is the
    // one before it.
    if (payload.endsWith(SEPARATOR)) {
        parts.pop();
    }

    const [machineId, type, counter, ...fields] = parts;

    return { machineId, type, counter, fields };
}

/**
 * Builds the `enq' reply: 21 fields, each followed by the separator.
 *
 * Only what this bridge knows is populated; the document requires every other
 * field to travel empty rather than be omitted, which is why the shape is fixed
 * here and not assembled by the caller.
 *
 * @param {object} reply
 * @param {string} reply.machineId  replicated from the ENQ
 * @param {string} reply.counter    replicated from the ENQ
 * @param {string} reply.barcode    replicated from the ENQ
 * @param {boolean} reply.found     MSG_RESULT: a known box, or not found
 */
function buildEnqReply({
    machineId = '',
    counter = '',
    reference = '',
    found = false,
    barcode = '',
    selective = '',
    invoicePages = '',
    printLabel1 = false,
    printLabel2 = false,
    printLabel3 = false,
    matchInvoice = '',
    matchLabel1 = '',
    matchLabel2 = '',
    matchLabel3 = '',
    description = '',
    boxLow = '',
    packject = '',
    cardboardChannel = '',
    sorter = '',
    hazmatLabel = '',
} = {}) {
    const flag = (on) => (on ? '1' : '');

    const fields = [
        machineId,
        MESSAGE_TYPES.ENQ_REPLY,
        counter,
        reference,
        found ? RESULT_GOOD : RESULT_NOT_FOUND,
        barcode,
        selective,
        invoicePages,
        flag(printLabel1),
        flag(printLabel2),
        flag(printLabel3),
        matchInvoice,
        matchLabel1,
        matchLabel2,
        matchLabel3,
        description,
        boxLow,
        packject,
        cardboardChannel,
        sorter,
        hazmatLabel,
    ];

    // Every field is closed by the separator, the trailing one included: the
    // document's own examples end with "|" immediately before ETX.
    return fields.join(SEPARATOR) + SEPARATOR;
}

module.exports = {
    STX, ETX, SEPARATOR, ENCODING, MESSAGE_TYPES, MAX_FRAME_BYTES,
    RESULT_GOOD, RESULT_NOT_FOUND,
    frame, createFrameReader, parseMessage, buildEnqReply,
};
