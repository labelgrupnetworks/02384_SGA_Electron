const { ScaleError } = require('../errors');
const { KNOWN_UNITS } = require('../units');

// Fatal MT-SICS responses. ES literally means "I do not recognise this
// command", so it maps to not_supported and not to protocol: that is what
// makes a scale without a buzzer answer 501 on /scale/beep with no
// configuration needed.
const FATAL = Object.freeze({
    ES: ['not_supported', 'el equipo no reconoce este comando'],
    ET: ['protocol', 'error de transmision'],
    EL: ['protocol', 'error logico'],
});

const STATUS_LABEL = Object.freeze({
    A: 'ok',
    B: 'listado',
    S: 'estable',
    D: 'dinamico',
    I: 'ocupado o no ejecutable ahora',
    L: 'parametro no permitido',
    '+': 'sobrecarga',
    '-': 'bajo rango',
});

/** Splits a line respecting double quotes: `I2 A "ICS425 3 kg"`. */
function splitTokens(line) {
    const tokens = [];
    const re = /"([^"]*)"|(\S+)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
        tokens.push(match[1] !== undefined ? match[1] : match[2]);
    }
    return tokens;
}

/**
 * (value, unit) from a response like `S S 0.000 kg`, or null.
 *
 * Requires the last token to be a known unit and the one before it a number.
 * Commands like TIM, DAT or I51 return several loose numbers and must not be
 * mistaken for a weighing.
 */
function parseWeight(tokens) {
    if (tokens.length < 4) return null;
    const unit = tokens[tokens.length - 1];
    const raw = tokens[tokens.length - 2];
    if (!KNOWN_UNITS.has(String(unit).toLowerCase())) return null;
    if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return null;
    return { value: Number(raw), unit };
}

/**
 * Validates `command`'s response against `lines`, requiring that the line
 * used as the response actually belongs to that command.
 *
 * MT-SICS echoes the command name as the first token of its response
 * (`S S 1.234 kg`, `TA A 0.000 kg`...), except for the fatal `ES`/`ET`/`EL`,
 * which arrive as a bare token with no prefix. This function used to look
 * only at `lines[0]`: if a scale left in `SIR`/`SR` mode (or any response
 * that arrives late, after `quietMs` or after a previous command's
 * `totalMs` expires) left an unconsumed line in the buffer, that stray line
 * would slip in as the response to the next command with nothing to detect
 * it -- reproduced in the final review as an incorrect tare and gross weight
 * returned with HTTP 200. Now the lines are walked in order and any whose
 * first token is neither the expected command nor a fatal is discarded; if
 * none matches, it is protocol instead of silently accepting whichever line
 * happened to be first, wrongly.
 */
function assertOk(lines, command) {
    if (!lines || lines.length === 0) {
        throw new ScaleError('timeout', 'la bascula no contesto');
    }

    let tokens = null;
    let matchedLine = null;
    for (const line of lines) {
        const candidate = splitTokens(line);
        if (candidate[0] === command || FATAL[candidate[0]]) {
            tokens = candidate;
            matchedLine = line;
            break;
        }
    }

    if (!tokens) {
        throw new ScaleError(
            'protocol',
            `ninguna linea de la respuesta corresponde al comando ${command}`,
            { command, lines },
        );
    }

    const fatal = FATAL[tokens[0]];
    if (fatal) {
        throw new ScaleError(fatal[0], fatal[1], { response: matchedLine });
    }

    const status = tokens[1];
    if (status === '+' || status === '-') {
        throw new ScaleError('overload', STATUS_LABEL[status], { status, response: matchedLine });
    }
    if (status === 'I' || status === 'L') {
        throw new ScaleError('protocol', STATUS_LABEL[status], { status, response: matchedLine });
    }

    return tokens;
}

function isStable(tokens) {
    return tokens[1] === 'S';
}

module.exports = { splitTokens, parseWeight, assertOk, isStable, STATUS_LABEL };
