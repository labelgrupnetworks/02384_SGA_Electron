const ERROR_CODES = Object.freeze([
    'connect',         // the socket could not be opened
    'timeout',         // it opened but did not answer in time
    'protocol',        // it answered something that does not match the protocol
    'not_supported',   // the operation does not exist on this scale
    'overload',        // overload or under range
    'unknown_brand',   // brand not registered
    'missing_params',  // ip, port or brand missing from the request
]);

const HTTP_STATUS = Object.freeze({
    unknown_brand: 400,
    missing_params: 400,
    not_supported: 501,
    connect: 502,
    timeout: 504,
    protocol: 500,
    overload: 500,
});

class ScaleError extends Error {
    constructor(code, message, detail = null) {
        super(message);
        if (!ERROR_CODES.includes(code)) {
            throw new Error(`code desconocido: ${code}`);
        }
        this.name = 'ScaleError';
        this.code = code;
        this.detail = detail;
    }
}

function httpStatusFor(code) {
    return HTTP_STATUS[code] ?? 500;
}

module.exports = { ScaleError, httpStatusFor, ERROR_CODES };
