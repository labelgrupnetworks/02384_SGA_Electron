// src/server/ip-route.js

/**
 * GET /ip — which address this workstation reports as its own.
 *
 * The SGA identifies the workstation by this value, so a wrong answer costs a scale
 * that never answers. When there is no answer to give, this returns 409 rather than
 * 200 with ip: null, so a caller that only checks the status code cannot mistake
 * "not configured" for success. The SGA's getLocalIpFromElectron() already degrades
 * a non-successful response to null, so that path needs no changes.
 *
 * `resolve` is injected so the five states can be tested without touching the
 * machine's network. `logger` is injected too, and optional, following the same
 * shape `createStore` already uses — this module must not import electron or a
 * logger singleton.
 */
function registerIpRoute(expressApp, { resolve, logger = null }) {
    expressApp.get('/ip', (req, res) => {
        let result;
        try {
            result = resolve();
        } catch (error) {
            // resolve() throwing means the app itself is broken (e.g. a corrupted
            // config file), not that the interface merely hasn't been chosen yet.
            // A 409 here would send the operator to the tray to pick an interface,
            // which would not fix anything; 500 is the honest signal, and it keeps
            // the SGA mapping this to "unreachable" exactly as an unhandled crash
            // would today.
            if (logger && typeof logger.error === 'function') {
                logger.error('GET /ip: resolve() threw', error);
            }
            return res.status(500).json({ ip: null, reason: 'internal_error' });
        }

        if (result.ip && (result.status === 'configured' || result.status === 'single')) {
            // Exactly the shape this endpoint has always returned.
            return res.json({ ip: result.ip });
        }

        return res.status(409).json({
            ip: null,
            reason: result.status,
            candidates: result.candidates || [],
            ...(result.savedInterface ? { savedInterface: result.savedInterface } : {}),
        });
    });
}

module.exports = { registerIpRoute };
