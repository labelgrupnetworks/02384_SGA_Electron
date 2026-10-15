/**
 * A label for proving a printer answers, printed from the settings dialog.
 *
 * It exists for the trip to the warehouse: the only way to know whether this
 * station can reach that printer, and whether what arrives is a label or
 * gibberish, is to make one come out. Everything else - a socket that connects,
 * bytes that flush - can succeed while the paper stays blank.
 *
 * It names its own target and carries the time, because the two questions
 * someone holding the paper actually asks are "which printer made this" and
 * "is this mine or did it come out an hour ago".
 */

/** ^ and ~ start a ZPL command; a value carrying one would be executed. */
function safe(text) {
    return String(text ?? '').replace(/[\^~]/g, '-');
}

/**
 * @param {{target?: string, at?: Date}} options
 * @return {string}
 */
function buildTestLabel({ target = 'sin destino', at = new Date() } = {}) {
    const stamp = at.toISOString().slice(0, 16).replace('T', ' ');

    return [
        '^XA',
        '^CI28',          // UTF-8, so accented text is not mangled
        '^PW600',
        '^LL400',
        '^LH0,0',
        // A border: proves the printer is not cropping, and that the media is
        // the size the printer thinks it is.
        '^FO20,20^GB560,360,3^FS',
        '^FO60,80^A0N,45,45^FDVERENTIA - PRUEBA^FS',
        '^FO60,150^A0N,30,30^FDDestino:^FS',
        `^FO60,190^A0N,34,34^FD${safe(target)}^FS`,
        '^FO60,260^A0N,30,30^FDFecha:^FS',
        `^FO60,300^A0N,34,34^FD${safe(stamp)}^FS`,
        '^XZ',
        '',
    ].join('\n');
}

module.exports = { buildTestLabel };
