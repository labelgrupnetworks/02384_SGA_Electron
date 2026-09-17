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

function registerCmcRoutes(expressApp, logger, {
    cache, machineState, queuedReports = () => 0, enabled = false,
}) {
    // Route-level express.json({ limit: PRELOAD_BODY_LIMIT }) only takes effect if
    // registerCmcRoutes is called BEFORE the global express.json() middleware in
    // main.js. This is not a case of the route-level parser running first and the
    // later global parser then running harmlessly as a no-op: the handler below
    // calls res.json(...) and returns, ending the response, so the global parser
    // is never reached at all for this request.
    //
    // There is a second, independent reason the ordering matters: main.js also
    // installs a global request logger right after its express.json() that logs
    // req.body for every request. That logger only avoids writing tens of
    // megabytes of base64 ZPL into electron-log on every /cmc/preload because
    // this route's handler already ended the response before the logger's
    // middleware would run. Moving this registration after that global
    // middleware would both 413 on real manifests and, on top of that, flood
    // the log file with every preload's payload. Do not move this registration
    // after global middleware.
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
            enabled,
            manifest: cache.state(),
            machine: machineState(),
            // Same figure the socket.io 'cmc-status' event already reports
            // (see main.js's emitCmcStatus); HTTP polling had no way to see
            // it before, only the live socket connection did.
            queued_reports: queuedReports(),
        });
    });
}

module.exports = { registerCmcRoutes };
