const { registry, OPERATIONS, routePathFor } = require('../scales');
const { TcpLink } = require('../scales/transport');
const { ScaleError, httpStatusFor } = require('../scales/errors');

// Normaliza cualquier valor lanzado (no solo instancias de Error) a
// {code, message, detail}. Un driver o dependencia puede lanzar `null`, un
// string o un objeto plano, y el contrato {code, message, detail} de la
// respuesta no puede depender de que quien lanzo haya usado un Error.
function normalizeError(error) {
    if (error instanceof ScaleError) {
        return { code: error.code, message: error.message, detail: error.detail };
    }
    return { code: 'protocol', message: String(error?.message ?? error), detail: null };
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

    let driver;
    try {
        driver = registry.resolveDriver(brand, model);
    } catch (error) {
        return fail(res, { brand, model, op: operation, error });
    }

    // Se comprueba antes de tocar la red: una operacion que la marca no tiene no
    // merece ni abrir un socket.
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
            apis: ['legacy', 'scale-v1'],
            brands: registry.listBrands().map((b) => b.id),
        });
    });

    expressApp.get('/scale/brands', (req, res) => {
        res.json({ brands: registry.listBrands() });
    });

    // Una ruta por operacion, derivada del registro. No hay una segunda lista de
    // endpoints que pueda desincronizarse de OPERATIONS.
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
