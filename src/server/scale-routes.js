const { registry, OPERATIONS, routePathFor } = require('../scales');
const { TcpLink } = require('../scales/transport');
const { ScaleError, httpStatusFor } = require('../scales/errors');

// Derives a readable message from any value, without ever being able to
// throw. A `.message` that is a getter that throws, or a `toString()` that
// throws (or doesn't exist, as with an object with a null prototype), break
// `String(error)` or the very access to `error.message`. This is the error
// path: if the error path can fail, it is worse than having no error path.
function safeMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'error no representable';
    }
}

// Normalises any thrown value (not just Error instances) to
// {code, message, detail}. A driver or dependency may throw `null`, a string
// or a plain object, and the response's {code, message, detail} contract
// cannot depend on whoever threw having used an Error.
function normalizeError(error) {
    if (error instanceof ScaleError) {
        return { code: error.code, message: error.message, detail: error.detail };
    }
    return { code: 'protocol', message: safeMessage(error), detail: null };
}

// `ip` arrives from the HTTP body: there is no guarantee it is a string, let
// alone a non-empty one. An object/array passes the truthiness check (`{}`
// and `[]` are truthy) and slips through to `net.connect(port, options)`,
// which has an overload where the second argument is an options object: with
// `ip: {}` the socket silently ignores the requested host and connects to
// localhost instead of failing, which on a production floor means talking to
// the wrong scale (or to none at all) with no error to give it away.
function isValidIp(ip) {
    return typeof ip === 'string' && ip.trim().length > 0;
}

// The port may arrive as a number or as a numeric string (the SGA's JSON
// doesn't always type its fields the same way), but either way it has to be
// an integer between 1 and 65535: `Number("abc")` is NaN and used to slip
// through to `new TcpLink({ port: NaN })`, and something like 99999 or 0
// isn't a valid TCP port even though `Number(port)` doesn't give NaN.
// Without this the failure was a raw Node error (ECONNREFUSED against a
// nonsensical port, or similar) that arrived as a 500 instead of the 400
// that a malformed request deserves.
function isValidPort(port) {
    if (typeof port === 'number') {
        return Number.isInteger(port) && port >= 1 && port <= 65535;
    }
    if (typeof port === 'string' && /^\d+$/.test(port)) {
        const n = Number(port);
        return n >= 1 && n <= 65535;
    }
    return false;
}

function fail(res, { brand = null, model = null, op, error }) {
    const { code, message, detail } = normalizeError(error);
    return res.status(httpStatusFor(code)).json({
        success: false,
        brand,
        model,
        op,
        error: { code, message, detail },
    });
}

async function runOperation(operation, req, res, logger) {
    const { ip, port, brand, model = null } = req.body || {};

    if (!ip || !port || !brand) {
        return fail(res, {
            brand: brand || null,
            model,
            op: operation,
            error: new ScaleError(
                'missing_params',
                'Faltan parámetros requeridos: ip, port, brand',
            ),
        });
    }

    // They are present, but that doesn't mean they have a usable shape: an
    // `ip` that isn't a non-empty string, or a `port` outside 1-65535, pass
    // the check above (they are truthy) and would arrive with no further
    // control all the way to TcpLink/net.connect.
    if (!isValidIp(ip) || !isValidPort(port)) {
        return fail(res, {
            brand,
            model,
            op: operation,
            error: new ScaleError(
                'missing_params',
                'ip debe ser un string no vacío y port un entero entre 1 y 65535',
                { ip, port },
            ),
        });
    }

    let driver;
    try {
        driver = registry.resolveDriver(brand, model, logger);
    } catch (error) {
        return fail(res, { brand, model, op: operation, error });
    }

    // Checked before touching the network: an operation the brand doesn't have
    // doesn't even deserve a socket being opened.
    if (!registry.allOperations(driver).includes(operation)) {
        return fail(res, {
            brand, model, op: operation,
            error: new ScaleError(
                'not_supported',
                `${brand} no soporta la operación ${operation}`,
                { brand, model, operation, supported: registry.allOperations(driver) },
            ),
        });
    }

    const link = new TcpLink({ host: ip, port: Number(port), framing: driver.framing });
    try {
        await link.connect();
        logger.info(`⚖️ [${operation}] ${brand}${model ? `/${model}` : ''} en ${ip}:${port}`);
        const result = await driver[operation](link, req.body);
        return res.json({
            success: true,
            brand,
            model,
            op: operation,
            data: result.data,
            raw: result.raw,
        });
    } catch (error) {
        const { code, message } = normalizeError(error);
        logger.warn(`⚠️ [${operation}] ${code}: ${message}`);
        return fail(res, { brand, model, op: operation, error });
    } finally {
        link.close();
    }
}

function registerScaleRoutes(expressApp, logger, { version }) {
    expressApp.get('/health', (req, res) => {
        res.json({
            version,
            apis: ['legacy', 'scale-v1', 'cmc-v1'],
            brands: registry.listBrands().map((b) => b.id),
        });
    });

    expressApp.get('/scale/brands', (req, res) => {
        res.json({ brands: registry.listBrands() });
    });

    // One route per operation, derived from the registry. There is no second
    // list of endpoints that could fall out of sync with OPERATIONS.
    for (const operation of OPERATIONS) {
        expressApp.post(`/scale/${routePathFor(operation)}`, (req, res) => {
            runOperation(operation, req, res, logger).catch((error) => {
                logger.error(`❌ [${operation}] excepción no controlada: ${error.message}`);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false, op: operation,
                        error: { code: 'protocol', message: error.message, detail: null },
                    });
                }
            });
        });
    }
}

module.exports = { registerScaleRoutes };
