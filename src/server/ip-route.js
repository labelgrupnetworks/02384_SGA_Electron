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
 * machine's network.
 */
function registerIpRoute(expressApp, { resolve }) {
    expressApp.get('/ip', (req, res) => {
        const result = resolve();

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
