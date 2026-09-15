const ERROR_CODES = Object.freeze([
    'connect',          // the socket could not be opened
    'timeout',          // it opened but did not answer in time
    'protocol',         // it answered something that does not match the protocol
    'unknown_barcode',  // the code is not in the loaded manifest
    'empty_manifest',   // nothing has been preloaded yet
    'bad_manifest',     // the preload payload does not match the contract
    'peripheral',       // a labeler could not be reached or refused the payload
    'report',           // the result could not be reported to Verentia
]);

const HTTP_STATUS = Object.freeze({
    bad_manifest: 400,
    unknown_barcode: 404,
    empty_manifest: 409,
    connect: 502,
    peripheral: 502,
    report: 502,
    timeout: 504,
    protocol: 500,
});

class CmcError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        if (!ERROR_CODES.includes(code)) {
            throw new Error(`unknown code: ${code}`);
        }
        this.name = 'CmcError';
        this.code = code;
        this.detail = detail;
    }
}

function httpStatusFor(code) {
    return HTTP_STATUS[code] ?? 500;
}

module.exports = { CmcError, httpStatusFor, ERROR_CODES };
