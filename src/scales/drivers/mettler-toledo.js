const { ScaleError } = require('../errors');
const { toGrams } = require('../units');
const { assertOk, parseWeight, isStable } = require('./mt-sics-protocol');

/**
 * Runs a command and returns the already-validated tokens together with the
 * raw lines. `command` may carry an argument (`SNS 2`, `D "text"`); only the
 * first token (the command name) is what assertOk requires to see reflected
 * in the response.
 */
async function ask(link, command, options = {}) {
    const lines = await link.command(command, options);
    const commandName = command.split(/\s+/)[0];
    return { tokens: assertOk(lines, commandName), lines };
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

    // Guaranteed by MT-SICS on any device in the family.
    capabilities: ['weigh', 'tare', 'clearTare', 'zero', 'info', 'display', 'displayClear', 'guidedWeigh'],

    // These exist in the protocol but depend on the device: DS needs a buzzer
    // and SNS needs more than one platform. If the device doesn't have them
    // it answers ES, which mt-sics-protocol maps to not_supported.
    deviceDependent: ['beep', 'selectPlatform'],

    models: {},

    async weigh(link) {
        // MT-SICS doesn't give net, tare and gross in one telegram: it takes two
        // commands and the gross weight is computed. Bizerba does give it all at
        // once; /scale/weigh hides that difference, which is the reason for
        // normalising.
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
     * Display text, beep and weighing over a single connection.
     *
     * The display is ALWAYS restored in the finally. Without that, a scale is
     * left with the text showing and not displaying the weight when something
     * gets cut off midway, and the operator sees a frozen display with no idea
     * why.
     */
    async guidedWeigh(link, { text, beep = false, waitStable = true, timeoutMs = 10000 } = {}) {
        // timeoutMs arrives as-is from the SGA's HTTP body: a JSON payload may
        // carry it as a string, and `Date.now() + "10000"` in transport.js is
        // concatenation, not addition, so the read never expired and the socket
        // stayed open forever (final review, Critical 2). transport.js already
        // falls back to a default if this were to arrive equally bad, but an
        // invalid value set here, right at the boundary with the HTTP request,
        // deserves a clear error instead of a silent substitution with 10000.
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new ScaleError(
                'protocol',
                `timeoutMs debe ser un numero finito y positivo, recibido: ${JSON.stringify(timeoutMs)}`,
                { timeoutMs },
            );
        }
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
                    // A beep that doesn't sound isn't a reason to withhold the weighing.
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

        // Restoring the display goes here and not in a finally: finally runs
        // AFTER the return value is evaluated, so displayRestored would come
        // out true without the DW having happened yet. This order keeps it
        // honest.
        let displayRestored = false;
        try {
            const cleared = await this.displayClear(link);
            raw.push(...cleared.raw);
            displayRestored = true;
        } catch (err) {
            // Ignored on purpose: if the DW fails, the error that matters is the
            // weighing's, and rethrowing here would mask it. But the response (if
            // there was one) stays in raw, just like with the beep, so it doesn't
            // vanish without leaving a trace that it was attempted.
            if (err.detail?.response) raw.push(err.detail.response);
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

        // I2 returns "MODEL capacity unit" in a single quoted field.
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
        // Double quotes delimit the argument and \r\n delimits the telegram:
        // neither can survive inside the text, or the argument turns into a
        // vector for injecting additional MT-SICS commands (including
        // destructive ones like RST or C2). It is cleaned before validating,
        // so that a text containing only those characters counts as empty.
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
