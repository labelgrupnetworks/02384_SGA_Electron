const test = require('node:test');
const assert = require('node:assert/strict');
const { describeMessage } = require('../../src/cmc/describe-message');

// The panel showed raw frames. `0001|enq|7|V00000001|1|2620-2595156|||1|` is
// exact and unreadable, and the person who needs it is standing at a machine
// with a box going past.

test('an ENQ says which box the machine is asking about', () => {
    assert.equal(
        describeMessage('0001|ENQ|7|2620-2595156|'),
        'pregunta por la caja 2620-2595156',
    );
});

test('an accepted enq says it is known and which reference it was given', () => {
    assert.equal(
        describeMessage('0001|enq|7|V00000001|1|2620-2595156|||1|'),
        'la conocemos · referencia V00000001 · se etiqueta',
    );
});

test('a refused enq says the box will pass unlabelled', () => {
    // The whole point of the panel: this is the line that explains a box
    // arriving at the end of the belt with nothing stuck to it.
    assert.equal(
        describeMessage('0001|enq|7|V00000002|0|2620-9999999|||'),
        'NO la conocemos · pasa sin etiquetar',
    );
});

test('a LAB1 says the machine is asking for the label', () => {
    assert.equal(describeMessage('0001|LAB1|9|V00000001|'), 'pide la etiqueta · V00000001');
});

test('a lab1 reply distinguishes sent from not sent', () => {
    assert.equal(
        describeMessage('0001|lab1|9|V00000001|1|2620-2595156|0||'),
        'etiqueta enviada · 2620-2595156',
    );
    assert.equal(
        describeMessage('0001|lab1|9|V00000001|0|2620-2595156|0||'),
        'NO se envió la etiqueta · la máquina rechazará la caja',
    );
});

test('the quiet acknowledgements are named', () => {
    assert.equal(describeMessage('0001|IND|8|V00000001|'), 'la caja ha entrado');
    assert.equal(describeMessage('0001|END|10|V00000001|1|0|'), 'fin del ciclo de la caja');
    assert.equal(describeMessage('0001|REM|11|V00000001|'), 'la caja se ha sacado a mano');
    assert.equal(describeMessage('0001|HBT'), 'latido');
});

test('an unknown type falls back to showing the type rather than inventing a meaning', () => {
    assert.equal(describeMessage('0001|XYZ|1|algo|'), 'XYZ');
});

test('a frame that does not parse does not throw', () => {
    assert.equal(describeMessage('basura'), '');
    assert.equal(describeMessage(''), '');
    assert.equal(describeMessage(null), '');
});
