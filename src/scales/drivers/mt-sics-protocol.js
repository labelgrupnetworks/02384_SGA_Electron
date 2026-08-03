const { ScaleError } = require('../errors');
const { KNOWN_UNITS } = require('../units');

// Respuestas fatales de MT-SICS. ES significa literalmente "no reconozco este
// comando", asi que se traduce a not_supported y no a protocol: es lo que hace
// que una bascula sin zumbador responda 501 en /scale/beep sin configurar nada.
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

/** Trocea una linea respetando las comillas dobles: `I2 A "ICS425 3 kg"`. */
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
 * (valor, unidad) de una respuesta tipo `S S 0.000 kg`, o null.
 *
 * Exige que el ultimo token sea una unidad conocida y el anterior un numero.
 * Comandos como TIM, DAT o I51 devuelven varios numeros sueltos y no deben
 * confundirse con una pesada.
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
 * Valida la respuesta de `command` contra `lines`, exigiendo que la linea
 * usada como respuesta sea realmente la de ese comando.
 *
 * MT-SICS echoa el nombre del comando como primer token de su respuesta
 * (`S S 1.234 kg`, `TA A 0.000 kg`...), salvo los fatales `ES`/`ET`/`EL`, que
 * llegan como token suelto sin prefijo. Antes esta funcion miraba solo
 * `lines[0]`: si una bascula dejada en modo `SIR`/`SR` (o cualquier respuesta
 * que llegue tarde, despues de `quietMs` o de que expire `totalMs` de un
 * comando previo) dejaba una linea sin consumir en el buffer, esa linea
 * ajena se colaba como respuesta del comando siguiente sin que nada lo
 * detectara -- reproducido en la revision final como un tara y un bruto
 * incorrectos devueltos con HTTP 200. Ahora se recorren las lineas en orden
 * y se descarta cualquiera cuyo primer token no sea ni el comando esperado
 * ni un fatal; si ninguna encaja, es protocol en vez de aceptar la primera
 * que hubiera, silenciosamente equivocada.
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
