const { ScaleError } = require('../errors');
const { toGrams } = require('../units');
const { assertOk, parseWeight, isStable } = require('./mt-sics-protocol');

/** Ejecuta un comando y devuelve los tokens ya validados junto a las lineas crudas. */
async function ask(link, command, options = {}) {
    const lines = await link.command(command, options);
    return { tokens: assertOk(lines), lines };
}

function weightOrFail(tokens, command) {
    const weight = parseWeight(tokens);
    if (!weight) {
        throw new ScaleError('protocol', `${command} no devolvio un peso`, { tokens });
    }
    return toGrams(weight.value, weight.unit);
}

const driver = {
    id: 'mettler_toledo',
    label: 'Mettler Toledo (MT-SICS)',
    defaultPort: 4305,
    framing: { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 },

    // Garantizadas por MT-SICS en cualquier equipo de la familia.
    capabilities: ['weigh', 'tare', 'clearTare', 'zero', 'info', 'display', 'displayClear', 'guidedWeigh'],

    // Existen en el protocolo pero dependen del equipo: DS necesita zumbador y
    // SNS mas de una plataforma. Si el equipo no las tiene contesta ES, que
    // mt-sics-protocol traduce a not_supported.
    deviceDependent: ['beep', 'selectPlatform'],

    models: {},

    async weigh(link) {
        // MT-SICS no da neto, tara y bruto en una trama: hacen falta dos comandos
        // y el bruto se calcula. Bizerba si lo da de golpe; /scale/weigh esconde
        // esa diferencia, que es el motivo de normalizar.
        const net = await ask(link, 'S');
        const netGrams = weightOrFail(net.tokens, 'S');

        const tare = await ask(link, 'TA');
        const tareGrams = weightOrFail(tare.tokens, 'TA');

        return {
            data: {
                net: netGrams,
                tare: tareGrams,
                gross: { value: Number((netGrams.value + tareGrams.value).toFixed(4)), unit: 'g' },
                stable: isStable(net.tokens),
            },
            raw: [...net.lines, ...tare.lines],
        };
    },

    /**
     * Texto en el display, pitido y pesada sobre una sola conexion.
     *
     * El display se restaura SIEMPRE en el finally. Sin eso, una bascula se queda
     * con el texto puesto y sin mostrar el peso cuando algo se corta a mitad, y el
     * operario ve un display congelado sin saber por que.
     */
    async guidedWeigh(link, { text, beep = false, waitStable = true, timeoutMs = 10000 } = {}) {
        const raw = [];
        let weighed = null;
        let failure = null;

        try {
            if (text) {
                const shown = await this.display(link, { text });
                raw.push(...shown.raw);
            }

            if (beep) {
                try {
                    const beeped = await this.beep(link);
                    raw.push(...beeped.raw);
                } catch (err) {
                    // Un pitido que no suena no es razon para no dar la pesada.
                    if (err.code !== 'not_supported') throw err;
                    if (err.detail?.response) raw.push(err.detail.response);
                }
            }

            const command = waitStable ? 'S' : 'SI';
            const net = await ask(link, command, { totalMs: timeoutMs });
            const tare = await ask(link, 'TA');

            const netGrams = weightOrFail(net.tokens, command);
            const tareGrams = weightOrFail(tare.tokens, 'TA');
            raw.push(...net.lines, ...tare.lines);

            weighed = {
                net: netGrams,
                tare: tareGrams,
                gross: { value: Number((netGrams.value + tareGrams.value).toFixed(4)), unit: 'g' },
                stable: isStable(net.tokens),
            };
        } catch (err) {
            failure = err;
        }

        // Restaurar el display va aqui y no en un finally: finally corre DESPUES de
        // evaluar el return, asi que displayRestored saldria a true sin que el DW
        // hubiese ocurrido todavia. Este orden lo hace honesto.
        let displayRestored = false;
        try {
            const cleared = await this.displayClear(link);
            raw.push(...cleared.raw);
            displayRestored = true;
        } catch {
            // Se ignora a proposito: si el DW falla, el error que importa es el de
            // la pesada, y relanzar aqui lo enmascararia.
        }

        if (failure) throw failure;

        return { data: { ...weighed, displayRestored }, raw };
    },

    async tare(link) {
        const { tokens, lines } = await ask(link, 'T');
        return { data: { tare: weightOrFail(tokens, 'T') }, raw: lines };
    },

    async clearTare(link) {
        const { lines } = await ask(link, 'TAC');
        return { data: {}, raw: lines };
    },

    async zero(link) {
        const { lines } = await ask(link, 'Z');
        return { data: {}, raw: lines };
    },

    async info(link) {
        const model = await ask(link, 'I2');
        const serial = await ask(link, 'I4');

        // I2 devuelve "MODELO capacidad unidad" en un solo campo entrecomillado.
        const raw = model.tokens[2] || '';
        const split = raw.split(/\s+/);
        return {
            data: {
                model: split[0] || null,
                capacity: split.slice(1).join(' ') || null,
                serial: serial.tokens[2] || null,
            },
            raw: [...model.lines, ...serial.lines],
        };
    },

    async selectPlatform(link, { platform } = {}) {
        const number = Number(platform);
        if (number !== 1 && number !== 2) {
            throw new ScaleError('protocol', 'platform debe ser 1 o 2', { platform });
        }
        const { lines } = await ask(link, `SNS ${number}`);
        return { data: { platform: number }, raw: lines };
    },

    async display(link, { text } = {}) {
        // Las comillas dobles delimitan el argumento y \r\n delimita la trama:
        // ninguno de los dos puede sobrevivir dentro del texto, o el argumento
        // se convierte en un vector para inyectar comandos MT-SICS adicionales
        // (incluidos destructivos como RST o C2). Se limpia antes de validar,
        // para que un texto que solo contenia esos caracteres cuente como vacio.
        // eslint-disable-next-line no-control-regex
        const clean = String(text ?? '').replace(/["\x00-\x1F\x7F]/g, '');
        if (!clean.trim()) {
            throw new ScaleError('protocol', 'text es obligatorio para display');
        }
        const { lines } = await ask(link, `D "${clean}"`);
        return { data: {}, raw: lines };
    },

    async displayClear(link) {
        const { lines } = await ask(link, 'DW');
        return { data: {}, raw: lines };
    },

    async beep(link) {
        const { lines } = await ask(link, 'DS');
        return { data: {}, raw: lines };
    },
};

module.exports = driver;
