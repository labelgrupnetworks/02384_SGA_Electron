const test = require('node:test');
const assert = require('node:assert/strict');
const { TcpLink } = require('../../src/scales/transport');
const { ScaleError } = require('../../src/scales/errors');
const { createLineScale, createRawScale } = require('../helpers/fake-scale');

const FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 120, totalMs: 1500 };

function linkTo(port, framing = FRAMING) {
    return new TcpLink({ host: '127.0.0.1', port, framing });
}

test('command returns the response line without the terminator', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('adds the terminator when sending', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.command('S');
        assert.deepEqual(scale.received, ['S']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('assembles a response that arrives split across several bursts', async () => {
    const scale = await createLineScale({ S: 'S S 1.234 kg' }, { chunkSize: 2 });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('returns several lines when the response is multiline', async () => {
    const scale = await createLineScale({ I0: ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A'] });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('I0'), ['I0 B 1 "S"', 'I0 B 2 "T"', 'I0 A']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('total silence returns an empty array, not an error', async () => {
    const scale = await createLineScale({ SI: null });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('SI'), []);
    } finally {
        link.close();
        await scale.close();
    }
});

test('several commands over a single connection do not mix', async () => {
    const scale = await createLineScale({ S: 'S S 1.000 kg', TA: 'TA A 0.050 kg', DW: 'DW A' });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
        assert.deepEqual(await link.command('TA'), ['TA A 0.050 kg']);
        assert.deepEqual(await link.command('DW'), ['DW A']);
        assert.deepEqual(scale.received, ['S', 'TA', 'DW']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('drains, on the JS side, what already arrived and was unconsumed from a previous command before sending the next one', async () => {
    // The scale answers SIR twice: the second line arrives and sits in
    // this.pending BEFORE S is sent; without draining it would be read as
    // S's response. This only tests that -- a line already received before
    // the send. It does not test (nor does _drain guarantee) that a line
    // arriving AFTER S is sent can't slip in as its response: that guarantee
    // belongs to assertOk (Critical 1), not to this draining.
    const scale = await createLineScale({
        SIR: ['S D 0.500 kg', 'S D 0.600 kg'],
        S: 'S S 1.234 kg',
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await link.send('SIR');
        await new Promise((r) => setTimeout(r, 150));
        assert.deepEqual(await link.command('S'), ['S S 1.234 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('totalMs cuts off a scale that never goes quiet', async () => {
    const scale = await createRawScale((chunk, socket) => {
        const pump = () => {
            if (socket.destroyed) return;
            socket.write('S D 0.100 kg\r\n');
            setTimeout(pump, 20);
        };
        pump();
    });
    const link = linkTo(scale.port, { ...FRAMING, quietMs: 50, totalMs: 300 });
    try {
        await link.connect();
        const started = Date.now();
        const lines = await link.command('SIR');
        const elapsed = Date.now() - started;
        assert.ok(lines.length > 1, 'should have read several lines');
        assert.ok(elapsed < 1000, `took ${elapsed}ms, should cut off near 300`);
    } finally {
        link.close();
        await scale.close();
    }
});

// --- C2: a non-numeric quietMs/totalMs must not hang the read forever ---
//
// `Date.now() + total` is string concatenation if `total` is `"10000"`, and
// `NaN`/`Infinity` never make `now >= deadline` come out true. Before the fix,
// any of these values left _readLines rescheduling itself with
// setTimeout(tick, 10) forever: the HTTP request never answered and the
// socket never closed. The test's ceiling is generous but finite, so that a
// regression fails fast instead of hanging the whole suite.
function describeBadValue(value) {
    if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    return JSON.stringify(value);
}

for (const bad of ['10000', NaN, Infinity, 0, -500, {}]) {
    test(`command with totalMs=${describeBadValue(bad)} responds and does not hang`, async () => {
        const scale = await createLineScale({ S: null }); // never answers -> forces the deadline to be exhausted
        const link = linkTo(scale.port);
        try {
            await link.connect();
            const started = Date.now();
            const lines = await Promise.race([
                link.command('S', { totalMs: bad }),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('command() did not respond in time: it hung')),
                    4000,
                )),
            ]);
            const elapsed = Date.now() - started;
            assert.deepEqual(lines, []);
            assert.ok(elapsed < 4000, `took ${elapsed}ms`);
        } finally {
            link.close();
            await scale.close();
        }
    });
}

for (const bad of ['80', NaN, Infinity, 0, -50, {}]) {
    test(`command with quietMs=${describeBadValue(bad)} responds and does not hang`, async () => {
        const scale = await createLineScale({ S: 'S S 1.000 kg' });
        const link = linkTo(scale.port);
        try {
            await link.connect();
            const lines = await Promise.race([
                link.command('S', { quietMs: bad, totalMs: 1500 }),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('command() did not respond in time: it hung')),
                    4000,
                )),
            ]);
            assert.deepEqual(lines, ['S S 1.000 kg']);
        } finally {
            link.close();
            await scale.close();
        }
    });
}

test('connect against a closed port throws ScaleError connect', async () => {
    const link = linkTo(1);
    await assert.rejects(() => link.connect(), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'connect');
        return true;
    });
});

test('if the scale closes mid-read it is a protocol error', async () => {
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.2');
        setTimeout(() => socket.destroy(), 30);
    });
    const link = linkTo(scale.port);
    try {
        await link.connect();
        await assert.rejects(() => link.command('S'), (err) => {
            assert.equal(err.code, 'protocol');
            return true;
        });
    } finally {
        link.close();
        await scale.close();
    }
});

test('close is idempotent and leaves connected as false', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    await link.connect();
    assert.equal(link.connected, true);
    link.close();
    link.close();
    assert.equal(link.connected, false);
    await scale.close();
});

test('command reconnects only if there is no socket', async () => {
    const scale = await createLineScale({ S: 'S S 0.000 kg' });
    const link = linkTo(scale.port);
    try {
        assert.equal(link.connected, false);
        assert.deepEqual(await link.command('S'), ['S S 0.000 kg']);
        assert.equal(link.connected, true);
    } finally {
        link.close();
        await scale.close();
    }
});

test('accepts \\r as a terminator for models that use it', async () => {
    const scale = await createRawScale((chunk, socket) => {
        if (chunk.toString('latin1') === 'S\r') socket.write('S S 1.000 kg\r');
    });
    const link = linkTo(scale.port, { ...FRAMING, terminator: '\r' });
    try {
        await link.connect();
        assert.deepEqual(await link.command('S'), ['S S 1.000 kg']);
    } finally {
        link.close();
        await scale.close();
    }
});

test('two simultaneous commands over the same link: exactly one gets the line, the other stays empty', async () => {
    // The scale only answers the first send that reaches it; any later send
    // gets no response. Design decision (in the absence of another signal to
    // break the tie): when two overlapping _readLines() calls compete for the
    // same line, exactly one of the two calls must keep it intact and the
    // other must resolve to [] -- the same as "the scale didn't answer this
    // one". What must NEVER happen is that both see it (duplicate), neither
    // sees it (lost), or it arrives split between the two.
    let replied = false;
    const scale = await createRawScale((chunk, socket) => {
        if (!replied) {
            replied = true;
            socket.write('S S 1.234 kg\r\n');
        }
    });
    const link = linkTo(scale.port, { ...FRAMING, quietMs: 30, totalMs: 200 });
    try {
        await link.connect();
        const [a, b] = await Promise.all([link.command('S'), link.command('S')]);
        const results = [a, b];
        const withLine = results.filter((r) => r.length > 0);
        const empty = results.filter((r) => r.length === 0);
        assert.equal(withLine.length, 1, 'exactly one of the two calls must get the line');
        assert.deepEqual(withLine[0], ['S S 1.234 kg']);
        assert.equal(empty.length, 1, 'the other must stay empty, not with a mix or a duplicate');
        assert.deepEqual(empty[0], []);
    } finally {
        link.close();
        await scale.close();
    }
});

test('close() mid-read resolves right away and keeps what was already received, without an unhandledRejection', async () => {
    // The scale answers once and then goes quiet. close() is called while the
    // command is still in its silence gap (quietMs=300, well below
    // totalMs=3000). It must resolve right away, with the line that had already
    // arrived (close() cancels the read, it doesn't discard it), and without
    // letting any unhandledRejection slip through (a cancellation must never
    // reject).
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.234 kg\r\n');
    });
    const framing = { terminator: '\r\n', encoding: 'latin1', quietMs: 300, totalMs: 3000 };
    const link = linkTo(scale.port, framing);

    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);

    try {
        await link.connect();
        const started = Date.now();
        const pending = link.command('S');
        await new Promise((r) => setTimeout(r, 40)); // let the line arrive and accumulate
        link.close();
        const lines = await pending;
        const elapsed = Date.now() - started;
        assert.deepEqual(lines, ['S S 1.234 kg'], 'close() should not throw away what was already received');
        assert.ok(elapsed < 200, `took ${elapsed}ms, should resolve on close (not exhaust totalMs=3000 nor quietMs=300)`);
        await new Promise((r) => setTimeout(r, 20)); // let a late unhandledRejection surface if there was one
        assert.equal(unhandled, null, 'a read cancelled by close() should never reject');
    } finally {
        process.off('unhandledRejection', onUnhandled);
        await scale.close();
    }
});

test('close() mid-read with a multiline response keeps ALL the lines already received', async () => {
    // Reproduces the review scenario: the first line arrives immediately
    // and a second line arrives while the silence window (quietMs) is still
    // open. At that instant this._absorb has already put the second line in
    // this.pending, but the _readLines tick has not yet drained it into its
    // local ctx.lines (it is waiting on the silence gap). close() is called
    // right there. If close() emptied this.pending before syncing it with the
    // read in progress, this second line would be lost silently -- the bug
    // this test reproduces.
    //
    // Timing margins (deliberately generous: these are real timers, not a
    // simulated clock):
    //  - the second line arrives at 150ms;
    //  - close() is called at 300ms, 150ms after the second line is already
    //    in this.pending (plenty of margin to rule out close() arriving "too
    //    soon" before the line has even been absorbed);
    //  - the silence window's natural expiry (quietMs=500 after the second
    //    line) would not fire on its own until 150+500=650ms, well past the
    //    300ms of close() (plenty of margin to rule out the test passing "by
    //    coincidence" because the window expired on its own instead of
    //    because of the cancellation).
    const scale = await createRawScale((chunk, socket) => {
        socket.write('S S 1.234 kg\r\n');
        setTimeout(() => socket.write('S S 1.235 kg\r\n'), 150);
    });
    const framing = { terminator: '\r\n', encoding: 'latin1', quietMs: 500, totalMs: 3000 };
    const link = linkTo(scale.port, framing);
    try {
        await link.connect();
        const started = Date.now();
        const pending = link.command('S');
        await new Promise((r) => setTimeout(r, 300));
        link.close();
        const lines = await pending;
        const elapsed = Date.now() - started;
        assert.deepEqual(
            lines,
            ['S S 1.234 kg', 'S S 1.235 kg'],
            'close() should not throw away the second line, already absorbed when it was called',
        );
        assert.ok(
            elapsed < 450,
            `took ${elapsed}ms, should resolve on close (~300ms) and not wait for the natural window (~650ms)`,
        );
    } finally {
        await scale.close();
    }
});
