const net = require('node:net');
const { CmcError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 3000;
const ENCODING = 'latin1';

function isValidHost(host) {
    return typeof host === 'string' && host.trim().length > 0;
}

function isValidPort(port) {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Pushes a ZPL payload to a networked labeler and closes.
 *
 * A ZPL printer does not answer, so there is nothing to read: the operation is
 * done once the bytes are flushed. `TcpLink` from src/scales is deliberately not
 * reused — it is built around reading line-framed replies, which do not exist here.
 */
function sendZpl(options = {}) {
    const { host, port, content, timeoutMs = DEFAULT_TIMEOUT_MS } = options ?? {};
    return new Promise((resolve, reject) => {
        if (!isValidHost(host)) {
            reject(new CmcError('peripheral', 'host must be a non-empty string', { host }));
            return;
        }
        if (!isValidPort(port)) {
            reject(new CmcError('peripheral', 'port must be an integer between 1 and 65535', { port }));
            return;
        }
        if (typeof content !== 'string' || content.length === 0) {
            reject(new CmcError('peripheral', 'content must be a non-empty string', null));
            return;
        }

        const socket = new net.Socket();
        let settled = false;

        const finish = (error) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            if (error) reject(error); else resolve();
        };

        socket.setTimeout(timeoutMs);
        socket.once('timeout', () => finish(
            new CmcError('timeout', `labeler ${host}:${port} did not accept the payload in ${timeoutMs}ms`, { host, port }),
        ));
        socket.once('error', (error) => finish(
            new CmcError('peripheral', `labeler ${host}:${port} unreachable (${error.message})`, { host, port }),
        ));

        socket.connect(port, host, () => {
            socket.end(Buffer.from(content, ENCODING), () => finish(null));
        });
    });
}

module.exports = { sendZpl, DEFAULT_TIMEOUT_MS };
