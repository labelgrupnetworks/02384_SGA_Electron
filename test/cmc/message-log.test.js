const test = require('node:test');
const assert = require('node:assert/strict');
const { createMessageLog } = require('../../src/cmc/message-log');

// Real frames. Both directions lead with the machine id and carry the type in
// field 1 - the machine's own messages included. An earlier version of this file
// asserted that inbound frames led with the type instead, which was wrong and
// green, because the module under test made the same mistake.
const ENQ = '0001|ENQ|7|2620-2595156|';
const ENQ_REPLY = '0001|enq|7|V00000002|1|2620-2595156|';
const LAB1 = '0001|LAB1|8|V00000002|';
const LAB1_REPLY = '0001|lab1|8|V00000002|1|';

test('a new log is empty', () => {
    assert.deepEqual(createMessageLog().entries(), []);
});

test('it records what arrived and what was answered, newest first', () => {
    // Newest first because the panel shows the top of this list, and the thing
    // worth seeing is what just happened.
    const log = createMessageLog();

    log.received(ENQ);
    log.sent(ENQ_REPLY);

    const [primera, segunda] = log.entries();
    assert.equal(primera.direction, 'out');
    assert.equal(primera.type, 'enq');
    assert.equal(segunda.direction, 'in');
    assert.equal(segunda.type, 'ENQ');
});

test('the type comes from field 1 in both directions', () => {
    const log = createMessageLog();

    log.received(LAB1);
    log.sent(LAB1_REPLY);

    assert.equal(log.entries()[1].type, 'LAB1', 'the machine id was read as the type');
    assert.equal(log.entries()[0].type, 'lab1');
});

test('it times a reply against the message it answers', () => {
    // The protocol gives 500 ms for an enq and 1000 for a lab1. A number on
    // screen is the only way to know how close a station runs to that.
    const log = createMessageLog();
    let now = 1000;

    log.received(ENQ, now);
    now += 42;
    log.sent(ENQ_REPLY, now);

    assert.equal(log.entries()[0].ms, 42);
});

test('an unprompted message is not given a bogus reply time', () => {
    const log = createMessageLog();

    log.sent('0001|hbt');

    assert.equal(log.entries()[0].ms, null);
});

test('a frame that does not parse is still shown', () => {
    // Whatever arrives is worth seeing, especially when it is malformed: that
    // is the case someone opens this panel to understand.
    const log = createMessageLog();

    log.received('basura');

    const entry = log.entries()[0];
    assert.equal(entry.direction, 'in');
    assert.match(entry.payload, /basura/);
});

test('it keeps only the most recent entries', () => {
    // It runs for a whole shift. Unbounded, this is a memory leak with a nice
    // name.
    const log = createMessageLog({ limit: 3 });

    for (let i = 0; i < 10; i++) {
        log.received(`0001|ENQ|${i}|caja-${i}|`);
    }

    const entries = log.entries();
    assert.equal(entries.length, 3);
    assert.match(entries[0].payload, /caja-9/);
});

test('it shortens a payload that would not fit on a line', () => {
    const log = createMessageLog();

    log.received(`0001|END|9|${'x'.repeat(400)}|`);

    const { payload } = log.entries()[0];
    assert.ok(payload.length < 200, `payload kept at ${payload.length} characters`);
    assert.ok(payload.endsWith('…'), 'a shortened payload should say that it was shortened');
});
