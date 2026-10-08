const test = require('node:test');
const assert = require('node:assert');

const {
    buildAcknowledgement, buildLabelReply, buildHeartbeatReply, MESSAGE_TYPES, parseMessage,
} = require('../../src/cmc/protocol');

/**
 * The replies the CIS owes the machine.
 *
 * Every expected string here is the document's own example (CMC-DataProtocol
 * 4.1), and the frames the requests are parsed from were captured off CMCDPsim
 * on 2026-10-08 — not written from the prose. The machine sends a full cycle
 * and the CIS answered exactly one of its six messages, so a box that got past
 * the ENQ was then rejected for want of a `lab1'.
 */
test('ind, ack, end and rem echo the counter and the reference', () => {
    const cases = [
        [MESSAGE_TYPES.IND, 'ind', '5555|ind|9|ref00ABCD|'],
        [MESSAGE_TYPES.ACK, 'ack', '5555|ack|12|ref00ABCD|'],
        [MESSAGE_TYPES.END, 'end', '5555|end|35|ref00ABCD|'],
        [MESSAGE_TYPES.REM, 'rem', '5555|rem|106|ref00ABCD|'],
    ];

    for (const [, replyType, expected] of cases) {
        const counter = expected.split('|')[2];

        assert.strictEqual(
            buildAcknowledgement({
                machineId: '5555', type: replyType, counter, reference: 'ref00ABCD',
            }),
            expected,
        );
    }
});

test('lab1 carries the match string the reader will compare against', () => {
    assert.strictEqual(
        buildLabelReply({
            machineId: '5555',
            type: 'lab1',
            counter: '25',
            reference: '00ABCD',
            delivered: true,
            match: 'MATCHLAB1',
            reject: false,
            sorter: '1',
        }),
        '5555|lab1|25|00ABCD|1|MATCHLAB1|0|1|',
    );
});

test('a label the bridge could not deliver reports the cycle as failed', () => {
    // MSG_RESULT 0 = "the label_1 sending cycle has failed". Saying it started
    // when it did not would have the machine apply nothing and verify nothing.
    const reply = buildLabelReply({
        machineId: '0001', type: 'lab1', counter: '4', reference: 'ref0001', delivered: false,
    });

    assert.strictEqual(reply.split('|')[4], '0');
});

test('hbt carries no counter and no trailing separator', () => {
    // The document's example is "<stx>5555|hbt<etx>", and the machine's own HBT
    // arrives the same way: "0001|HBT", with no counter and nothing after it.
    assert.strictEqual(buildHeartbeatReply({machineId: '5555'}), '5555|hbt');
});

test('the captured cycle parses, including its two irregular frames', () => {
    // Captured off CMCDPsim on 2026-10-08. LAB1 arrives WITHOUT the trailing
    // separator every other message carries, and HBT without a counter; both
    // used to be assumptions and are now observations.
    const captured = [
        ['0001|ENQ|1|IT0001|', MESSAGE_TYPES.ENQ, '1', ['IT0001']],
        ['0001|IND|2|ref0001|', MESSAGE_TYPES.IND, '2', ['ref0001']],
        ['0001|ACK|3|ref0001|1|0|80|200|250|2200|', MESSAGE_TYPES.ACK, '3',
            ['ref0001', '1', '0', '80', '200', '250', '2200']],
        ['0001|LAB1|4|ref0001|1|0|2200|150|680|1000000', MESSAGE_TYPES.LAB1, '4',
            ['ref0001', '1', '0', '2200', '150', '680', '1000000']],
        ['0001|END|5|ref0001|1|0|80|200|250|2200|150|680|0|', MESSAGE_TYPES.END, '5',
            ['ref0001', '1', '0', '80', '200', '250', '2200', '150', '680', '0']],
        ['0001|HBT', MESSAGE_TYPES.HBT, undefined, []],
    ];

    for (const [payload, type, counter, fields] of captured) {
        const message = parseMessage(payload);

        assert.strictEqual(message.type, type, payload);
        assert.strictEqual(message.machineId, '0001', payload);
        assert.strictEqual(message.counter, counter, payload);
        assert.deepStrictEqual(message.fields, fields, payload);
    }
});
