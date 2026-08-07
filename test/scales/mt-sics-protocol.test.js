const test = require('node:test');
const assert = require('node:assert/strict');
const {
    splitTokens, parseWeight, assertOk, isStable,
} = require('../../src/scales/drivers/mt-sics-protocol');
const { ScaleError } = require('../../src/scales/errors');

test('splitTokens splits on spaces', () => {
    assert.deepEqual(splitTokens('S S 1.234 kg'), ['S', 'S', '1.234', 'kg']);
});

test('splitTokens respects double quotes as a single token', () => {
    assert.deepEqual(
        splitTokens('I2 A "ICS425-BW 3.0045 kg"'),
        ['I2', 'A', 'ICS425-BW 3.0045 kg'],
    );
});

test('splitTokens tolerates empty quotes', () => {
    assert.deepEqual(splitTokens('I10 A ""'), ['I10', 'A', '']);
});

test('parseWeight reads value and unit from the last two tokens', () => {
    assert.deepEqual(parseWeight(['S', 'S', '1.234', 'kg']), { value: 1.234, unit: 'kg' });
});

test('parseWeight accepts negative weights', () => {
    assert.deepEqual(parseWeight(['S', 'S', '-0.500', 'kg']), { value: -0.5, unit: 'kg' });
});

test('parseWeight ignores a response whose last word is not a unit', () => {
    // Without this filter `TIM A 14 09 50` would be read as "14 units 09".
    assert.equal(parseWeight(['TIM', 'A', '14', '09', '50']), null);
});

test('parseWeight ignores a response whose last word is not a unit (even if it is short)', () => {
    assert.equal(parseWeight(['Z', 'A']), null);
});

test('parseWeight requires at least 4 tokens, even if the last two pass validation', () => {
    // Without this filter, parseWeight(['1.234', 'kg']) would pass as a
    // weight, when a well-formed MT-SICS response is <command> <status> <value> <unit>.
    assert.equal(parseWeight(['1.234', 'kg']), null);
});

test('parseWeight ignores a non-numeric value even if the unit is good', () => {
    assert.equal(parseWeight(['S', 'S', 'abc', 'kg']), null);
});

test('assertOk returns the tokens of a correct response', () => {
    assert.deepEqual(assertOk(['Z A'], 'Z'), ['Z', 'A']);
});

test('assertOk translates ES to not_supported, because the device does not know the command', () => {
    assert.throws(() => assertOk(['ES'], 'DS'), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'not_supported');
        return true;
    });
});

test('assertOk translates ET and EL to protocol', () => {
    for (const code of ['ET', 'EL']) {
        assert.throws(() => assertOk([code], 'S'), (err) => {
            assert.equal(err.code, 'protocol', `${code} should be protocol`);
            return true;
        });
    }
});

test('assertOk translates + and - to overload', () => {
    assert.throws(() => assertOk(['S +'], 'S'), (err) => {
        assert.equal(err.code, 'overload');
        assert.equal(err.detail.status, '+');
        return true;
    });
    assert.throws(() => assertOk(['S -'], 'S'), (err) => {
        assert.equal(err.code, 'overload');
        return true;
    });
});

test('assertOk translates I and L to protocol with the status in detail', () => {
    assert.throws(() => assertOk(['T I'], 'T'), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'I');
        return true;
    });
    assert.throws(() => assertOk(['SNS L'], 'SNS'), (err) => {
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.status, 'L');
        return true;
    });
});

test('assertOk with no lines is timeout', () => {
    assert.throws(() => assertOk([], 'S'), (err) => {
        assert.equal(err.code, 'timeout');
        return true;
    });
});

test('assertOk accepts the D status for a dynamic weight', () => {
    assert.deepEqual(assertOk(['S D 0.500 kg'], 'S'), ['S', 'D', '0.500', 'kg']);
});

// --- C1: matching the response to the command that was sent ---

test('assertOk ignores a line that does not belong to the command and uses the one that does', () => {
    // Reproduces the review scenario: a leftover "S ..." line from a previous
    // command arrives within the read window of "TA".
    assert.deepEqual(
        assertOk(['S S 1.234 kg', 'TA A 0.000 kg'], 'TA'),
        ['TA', 'A', '0.000', 'kg'],
    );
});

test('assertOk fails with protocol if no line corresponds to the expected command', () => {
    // It must never silently fall back to lines[0] when that line belongs to
    // another command: that is exactly what was causing the wrong tare.
    assert.throws(() => assertOk(['S S 1.234 kg'], 'TA'), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'protocol');
        assert.equal(err.detail.command, 'TA');
        return true;
    });
});

test('assertOk recognises a fatal (ES/ET/EL) even without the command prefix', () => {
    assert.throws(() => assertOk(['ES'], 'TA'), (err) => {
        assert.equal(err.code, 'not_supported');
        return true;
    });
});

test('assertOk discards several unrelated lines in a row until it finds the command\'s own', () => {
    assert.deepEqual(
        assertOk(['S S 1.234 kg', 'S S 1.235 kg', 'TA A 0.050 kg'], 'TA'),
        ['TA', 'A', '0.050', 'kg'],
    );
});

test('isStable distinguishes S from D', () => {
    assert.equal(isStable(['S', 'S', '1.234', 'kg']), true);
    assert.equal(isStable(['S', 'D', '1.234', 'kg']), false);
});
