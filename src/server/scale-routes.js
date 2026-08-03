const { registry, OPERATIONS, routePathFor } = require('../scales');
const { TcpLink } = require('../scales/transport');
const { ScaleError, httpStatusFor } = require('../scales/errors');

// Deriva un mensaje legible de cualquier valor, sin poder lanzar nunca. Un
// `.message` que sea un getter que lance, o un `toString()` que lance (o que
// no exista, como en un objeto con prototipo null), rompen `String(error)` o
// el propio acceso a `error.message`. Este es el camino de error: si el
// camino de error puede fallar, es peor que no tener camino de error.
function safeMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'error no representable';
    }
}

// Normaliza cualquier valor lanzado (no solo instancias de Error) a
// {code, message, detail}. Un driver o dependencia puede lanzar `null`, un
// string o un objeto plano, y el contrato {code, message, detail} de la
// respuesta no puede depender de que quien lanzo haya usado un Error.
function normalizeError(error) {
    if (error instanceof ScaleError) {
        return { code: error.code, message: error.message, detail: error.detail };
    }
    return { code: 'protocol', message: safeMessage(error), detail: null };
}

// `ip` llega del body HTTP: no hay garantia de que sea un string, y mucho
// menos uno no vacio. Un objeto/array pasa la comprobacion de verdad (`{}` y
// `[]` son truthy) y se cuela hasta `net.connect(port, options)`, que tiene
// una sobrecarga donde el segundo argumento son opciones: con `ip: {}` el
// socket ignora silenciosamente el host pedido y conecta a localhost en vez
// de fallar, lo que en un piso de produccion significa hablar con la bascula
// equivocada (o con ninguna) sin ningun error que lo delate.
function isValidIp(ip) {
    return typeof ip === 'string' && ip.trim().length > 0;
}

// El puerto puede llegar como number o como string numerico (el JSON del SGA
// no siempre tipa igual sus campos), pero en ambos casos tiene que ser un
// entero entre 1 y 65535: `Number("abc")` es NaN y antes se colaba hasta
// `new TcpLink({ port: NaN })`, y algo como 99999 o 0 no son puertos TCP
// validos aunque `Number(port)` no de NaN. Sin esto el fallo era un error
// crudo de Node (ECONNREFUSED contra un puerto sin sentido, o similar) que
// llegaba como 500 en vez del 400 que le corresponde a una peticion mal
// formada.
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

    // Estan presentes, pero eso no dice que tengan una forma usable: un `ip`
    // que no sea un string no vacio, o un `port` fuera de 1-65535, pasan la
    // comprobacion de arriba (son truthy) y llegarian sin mas control hasta
    // TcpLink/net.connect.
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
