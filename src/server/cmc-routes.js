const express = require('express');
const { CmcError, httpStatusFor } = require('../cmc/errors');

// A whole batch of base64 ZPL does not fit in express's 100 KB default. This
// limit is mounted on the preload route alone, so the rest of the local API
// keeps the stricter default.
const PRELOAD_BODY_LIMIT = '50mb';

function safeMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'unrepresentable error';
    }
}

function normalizeError(error) {
    if (error instanceof CmcError) {
        return { code: error.code, message: error.message, detail: error.detail };
    }
    return { code: 'protocol', message: safeMessage(error), detail: null };
}

function fail(res, error) {
    const normalized = normalizeError(error);
    return res.status(httpStatusFor(normalized.code)).json({ success: false, error: normalized });
}

function registerCmcRoutes(expressApp, logger, { cache, machineState }) {
    // Replace the global express.json() middleware with one that applies different
    // limits based on path. This allows /cmc/preload to accept large payloads
    // while keeping the default limit for other endpoints.
    const stack = expressApp._router?.stack || [];
    const globalJsonIndex = stack.findIndex(
        layer => layer.name === 'jsonParser',
    );

    if (globalJsonIndex !== -1) {
        stack.splice(globalJsonIndex, 1);
    }

    expressApp.use((req, res, next) => {
        if (req.path === '/cmc/preload') {
            return express.json({ limit: PRELOAD_BODY_LIMIT })(req, res, next);
        }
        return express.json()(req, res, next);
    });

    expressApp.post(
        '/cmc/preload',
        (req, res) => {
            try {
                const state = cache.replace(req.body);
                logger.info(`📦 [cmc] manifiesto ${state.batch_id} cargado (${state.total} bultos)`);

                return res.json({ success: true, manifest: state });
            } catch (error) {
                logger.warn(`⚠️ [cmc] preload rechazado: ${safeMessage(error)}`);

                return fail(res, error);
            }
        },
    );

    expressApp.get('/cmc/status', (req, res) => {
        res.json({
            success: true,
            manifest: cache.state(),
            machine: machineState(),
        });
    });
}

module.exports = { registerCmcRoutes };
