const test = require('node:test');
const assert = require('node:assert/strict');
const {
    frame, createFrameReader, parseMessage, buildEnqReply, STX, ETX, MAX_FRAME_BYTES,
    RESULT_GOOD, RESULT_NOT_FOUND,
} = require('../../src/cmc/protocol');

test('frame wraps the payload in STX and ETX', () => {
    const framed = frame('ENQ|123');
    assert.equal(framed[0], STX);
    assert.equal(framed[framed.length - 1], ETX);
    assert.equal(framed.toString('latin1').slice(1, -1), 'ENQ|123');
});

test('the reader returns one payload per complete frame', () => {
    const read = createFrameReader();
    assert.deepEqual(read(frame('ENQ|1')), ['ENQ|1']);
    assert.deepEqual(read(frame('ACK|1|OK')), ['ACK|1|OK']);
});

test('the reader reassembles a frame split across chunks', () => {
    const read = createFrameReader();
    const framed = frame('ENQ|123456');
    assert.deepEqual(read(framed.subarray(0, 4)), []);
    assert.deepEqual(read(framed.subarray(4)), ['ENQ|123456']);
});

test('the reader returns several payloads arriving in one chunk', () => {
    const read = createFrameReader();
    const chunk = Buffer.concat([frame('ENQ|1'), frame('ENQ|2')]);
    assert.deepEqual(read(chunk), ['ENQ|1', 'ENQ|2']);
});

test('the reader drops bytes sitting outside a frame', () => {
    const read = createFrameReader();
    assert.deepEqual(read(Buffer.concat([Buffer.from('noise'), frame('ENQ|1')])), ['ENQ|1']);
});

test('parseMessage splits the documented head from the fields of any message', () => {
    assert.deepEqual(parseMessage('5555|ACK|8|00012345|REJECTED_SIZE|'), {
        machineId: '5555',
        type: 'ACK',
        counter: '8',
        fields: ['00012345', 'REJECTED_SIZE'],
    });
});

test('parseMessage rejects an empty payload', () => {
    assert.throws(() => parseMessage(''), /empty message/);
});

test('buildEnqReply reports a known box as Good Item and an unknown one as not found', () => {
    const head = { machineId: '5555', counter: '7', barcode: '200001234' };
    assert.equal(buildEnqReply({ ...head, found: true }).split('|')[4], RESULT_GOOD);
    assert.equal(buildEnqReply({ ...head, found: false }).split('|')[4], RESULT_NOT_FOUND);
});

test('the reader discards unterminated frames exceeding MAX_FRAME_BYTES and recovers', () => {
    const read = createFrameReader();
    // Create an unterminated frame (STX but no ETX) that exceeds MAX_FRAME_BYTES
    const oversizeChunk = Buffer.concat([
        Buffer.from([STX]),
        Buffer.alloc(MAX_FRAME_BYTES + 1000, 'x'),
    ]);
    // Feed the oversized unterminated frame
    assert.deepEqual(read(oversizeChunk), []);
    // Feed a well-formed frame and verify the reader recovers
    assert.deepEqual(read(frame('ENQ|recovery')), ['ENQ|recovery']);
});

// --- CMC-DataProtocol 4.1 conformance -------------------------------------
// Frame layout, field order and the reply example below are taken verbatim
// from CMC-DataProtocol_4.1.pdf, sections FRAME / MESSAGE "ENQ" / MESSAGE "enq".

test('parseMessage reads the machine id, the type and the counter of a documented ENQ', () => {
    // <stx>5555|ENQ|7|200001234|0|<etx> — the example in section MESSAGE "ENQ".
    assert.deepEqual(parseMessage('5555|ENQ|7|200001234|0|'), {
        machineId: '5555',
        type: 'ENQ',
        counter: '7',
        fields: ['200001234', '0'],
    });
});

test('buildEnqReply reproduces the reply example of the protocol document', () => {
    assert.equal(
        buildEnqReply({
            machineId: '5555',
            counter: '7',
            reference: 'ref000ABCD',
            found: true,
            barcode: '200001234',
            selective: '11000000',
            printLabel1: true,
            matchLabel1: 'refLAB1',
            description: 'Book',
        }),
        '5555|enq|7|ref000ABCD|1|200001234|11000000||1||||refLAB1|||Book||||||'
    );
});

test('MAX_FRAME_BYTES honours the documented 32Kb ceiling', () => {
    // "Any message cannot be longer than 32Kb" — section Be carefully.
    assert.equal(MAX_FRAME_BYTES, 32768);
});
