const ERROR_CODES = Object.freeze([
    'connect',         // no se pudo abrir el socket
    'timeout',         // se abrio pero no contesto a tiempo
    'protocol',        // contesto algo que no encaja con el protocolo
    'not_supported',   // la operacion no existe en esta bascula
    'overload',        // sobrecarga o bajo rango
    'unknown_brand',   // marca no registrada
    'missing_params',  // faltan ip, port o brand en la peticion
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
