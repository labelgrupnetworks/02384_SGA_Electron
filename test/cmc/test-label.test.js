const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTestLabel } = require('../../src/cmc/test-label');

test('the test label is valid ZPL', () => {
    const zpl = buildTestLabel({ target: '10.200.230.11:515' });

    assert.ok(zpl.startsWith('^XA'), 'a ZPL label starts with ^XA');
    assert.ok(zpl.trimEnd().endsWith('^XZ'), 'a ZPL label ends with ^XZ');
});

test('it names the target it was sent to', () => {
    // Printed on the label on purpose: in a warehouse with more than one
    // printer, the only way to know which address produced the paper in your
    // hand is to read it off the paper.
    const zpl = buildTestLabel({ target: '10.200.230.11:515' });

    assert.ok(zpl.includes('10.200.230.11:515'), 'the label does not name its target');
});

test('it carries a timestamp, so an old label is not mistaken for a new one', () => {
    const zpl = buildTestLabel({ target: 'x:9100', at: new Date('2026-10-16T08:30:00Z') });

    assert.match(zpl, /2026-10-16/);
    assert.match(zpl, /08:30/);
});

test('it escapes nothing into ZPL control characters', () => {
    // ^ and ~ are ZPL's command prefixes. A target containing one would be read
    // as a command and could leave the printer in a strange state.
    const zpl = buildTestLabel({ target: 'ho^st~1:9100' });

    const payload = zpl.slice(zpl.indexOf('^FD'));
    assert.ok(!payload.includes('ho^st'), 'an unescaped ^ reached the label body');
});

test('a missing target still produces a printable label', () => {
    // Called from a dialog where the field can be empty; printing something
    // beats throwing while the operator is standing at the machine.
    const zpl = buildTestLabel({});

    assert.ok(zpl.startsWith('^XA'));
    assert.ok(zpl.trimEnd().endsWith('^XZ'));
});
