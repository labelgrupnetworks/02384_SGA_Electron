const { registry, OPERATIONS, routePathFor } = require('../scales');
const { TcpLink } = require('../scales/transport');
const { ScaleError, httpStatusFor } = require('../scales/errors');

function fail(res, { brand = null, model = null, op, error }) {
    const code = error instanceof ScaleError ? error.code : 'protocol';
    return res.status(httpStatusFor(code)).json({
        success: false,
        brand,
        model,
        op,
        error: {
            code,
            message: error.message,
            detail: error instanceof ScaleError ? error.detail : null,
        },
    });
}

async function runOperation(operation, req, res, logger) {
    const { ip, port, brand, model = null } = req.body || {};

    if (!ip || !port || !brand) {
        return res.status(400).json({
            success: false,
            brand: brand || null,
            model,
            op: operation,
            error: {
                code: 'unknown_brand',
                message: 'Faltan parámetros requeridos: ip, port, brand',
                detail: null,
            },
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
        logger.warn(`⚠️ [${operation}] ${error.code || 'error'}: ${error.message}`);
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
