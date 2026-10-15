/**
 * One protocol frame, in words.
 *
 * `0001|enq|7|V00000001|1|2620-2595156|||1|` is exact and unreadable, and the
 * person who needs it is standing next to a machine with a box going past. The
 * raw frame stays available in the panel; this is what is read at a glance.
 *
 * The line that earns this module is the refused enq: a box the bridge does not
 * recognise passes through UNLABELLED, and that is the single fact someone
 * opens this panel to find out.
 */

const { parseMessage, RESULT_GOOD } = require('./protocol');

/**
 * @param {string|null|undefined} payload
 * @return {string} empty when the frame cannot be parsed
 */
function describeMessage(payload) {
    let message;

    try {
        message = parseMessage(String(payload ?? ''));
    } catch {
        return '';
    }

    const { type, fields } = message;
    const [first, second, third] = fields;

    switch (type) {
        // --- from the machine ---
        case 'ENQ':
            return `pregunta por la caja ${first ?? ''}`.trim();
        case 'IND':
            return 'la caja ha entrado';
        case 'ACK':
            return 'medidas y peso de la caja';
        case 'LAB1':
        case 'LAB2':
        case 'LAB3':
            return `pide la etiqueta · ${first ?? ''}`.trim();
        case 'INV':
            return 'pide la factura';
        case 'END':
            return 'fin del ciclo de la caja';
        case 'REM':
            return 'la caja se ha sacado a mano';
        case 'HBT':
            return 'latido';
        case 'STS':
            return 'estado de la máquina';

        // --- our replies ---
        case 'enq':
            return second === RESULT_GOOD
                ? `la conocemos · referencia ${first} · se etiqueta`
                : 'NO la conocemos · pasa sin etiquetar';
        case 'lab1':
        case 'lab2':
        case 'lab3':
            return second === RESULT_GOOD
                ? `etiqueta enviada · ${third ?? ''}`.trim()
                : 'NO se envió la etiqueta · la máquina rechazará la caja';
        case 'ind':
            return 'enterado';
        case 'ack':
            return 'enterado de las medidas';
        case 'inv':
            return 'factura enviada';
        case 'end':
            return 'ciclo cerrado';
        case 'rem':
            return 'enterado de la retirada';
        case 'hbt':
            return 'latido devuelto';

        default:
            // Naming the type beats inventing a meaning for a message this
            // bridge does not know.
            return type ?? '';
    }
}

module.exports = { describeMessage };
