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
    // Route-level express.json({ limit: PRELOAD_BODY_LIMIT }) only takes effect if
    // registerCmcRoutes is called BEFORE the global express.json() middleware.
    // Express parses in registration order: the route's 50mb parser runs first,
    // sets req._body, and the later global 100kb parser no-ops. This allows
    // /cmc/preload to accept large ZPL payloads while other endpoints keep the
    // strict default limit. Do not move this registration after global middleware.
    expressApp.post(
        '/cmc/preload',
        express.json({ limit: PRELOAD_BODY_LIMIT }),
        (req, res) => {
            try {
                const state = cache.replace(req.body);
                logger.info(`📦 [cmc] manifest ${state.batch_id} loaded (${state.total} parcels)`);

                return res.json({ success: true, manifest: state });
            } catch (error) {
                logger.warn(`⚠️ [cmc] preload rejected: ${safeMessage(error)}`);

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
