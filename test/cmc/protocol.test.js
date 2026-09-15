const test = require('node:test');
const assert = require('node:assert/strict');
const {
    frame, createFrameReader, parseMessage, buildEnqReply, STX, ETX,
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

test('parseMessage splits type and fields', () => {
    assert.deepEqual(parseMessage('ENQ|00012345'), { type: 'ENQ', fields: ['00012345'] });
    assert.deepEqual(parseMessage('ACK|00012345|REJECTED_SIZE'), {
        type: 'ACK', fields: ['00012345', 'REJECTED_SIZE'],
    });
});

test('parseMessage rejects an empty payload', () => {
    assert.throws(() => parseMessage(''), /empty message/);
});

test('buildEnqReply distinguishes accept from reject', () => {
    assert.notEqual(buildEnqReply({ accepted: true }), buildEnqReply({ accepted: false }));
});
