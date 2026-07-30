const { ScaleError } = require('./errors');

// Nombres canonicos de operacion. Las rutas se derivan de aqui, asi que anadir
// una operacion es anadirla a esta lista y a los drivers que la sepan hacer.
const OPERATIONS = Object.freeze([
    'weigh', 'tare', 'clearTare', 'zero', 'info',
    'selectPlatform', 'display', 'displayClear', 'beep', 'guidedWeigh',
]);

function routePathFor(operation) {
    return operation.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function validate(driver) {
    const declared = [...(driver.capabilities || []), ...(driver.deviceDependent || [])];

    const seen = new Set();
    for (const op of declared) {
        if (!OPERATIONS.includes(op)) {
            throw new Error(`driver '${driver.id}': operacion desconocida: ${op}`);
        }
        if (seen.has(op)) {
            throw new Error(`driver '${driver.id}': operacion declarada dos veces: ${op}`);
        }
        seen.add(op);
        if (typeof driver[op] !== 'function') {
            throw new Error(`driver '${driver.id}': declara '${op}' pero no la implementa`);
        }
    }

    for (const op of OPERATIONS) {
        if (typeof driver[op] === 'function' && !seen.has(op)) {
            throw new Error(`driver '${driver.id}': implementa '${op}' pero no la declara`);
        }
    }
}

/** Fusion superficial de un nivel, suficiente para {framing, defaultPort, telegrams}. */
function mergeOverride(base, override) {
    if (!override) return base;
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const current = base[key];
        merged[key] = (value && typeof value === 'object' && !Array.isArray(value)
            && current && typeof current === 'object' && !Array.isArray(current))
            ? { ...current, ...value }
            : value;
    }
    return merged;
}

function createRegistry(drivers) {
    const byId = new Map();
    for (const driver of drivers) {
        validate(driver);
        byId.set(driver.id, driver);
    }

    function resolveDriver(brand, model = null) {
        const base = byId.get(brand);
        if (!base) {
            throw new ScaleError('unknown_brand', `marca no soportada: ${brand}`, {
                brand,
                validBrands: [...byId.keys()],
            });
        }
        if (!model) return base;
        const override = (base.models || {})[model];
        // Un modelo sin override es el caso normal: el catalogo del SGA es mas
        // amplio que esta tabla porque solo se da de alta lo que se desvia.
        return mergeOverride(base, override);
    }

    function allOperations(driver) {
        return [...(driver.capabilities || []), ...(driver.deviceDependent || [])];
    }

    function listBrands() {
        return [...byId.values()].map((driver) => ({
            id: driver.id,
            label: driver.label,
            defaultPort: driver.defaultPort,
            capabilities: [...(driver.capabilities || [])],
            deviceDependent: [...(driver.deviceDependent || [])],
            models: Object.keys(driver.models || {}),
        }));
    }

    return { resolveDriver, allOperations, listBrands };
}

module.exports = { createRegistry, OPERATIONS, routePathFor };
