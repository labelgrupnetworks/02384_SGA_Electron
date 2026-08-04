const { ScaleError } = require('./errors');

// Canonical operation names. Routes are derived from here, so adding an
// operation means adding it to this list and to the drivers that know how to
// do it.
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

/** Shallow one-level merge, enough for {framing, defaultPort, telegrams}. */
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
        // A model override can touch `capabilities`/`deviceDependent` (or any
        // other key) via mergeOverride, and mergeOverride itself does not
        // re-validate coherence: an override that declared an unimplemented,
        // or duplicated, capability would go unnoticed until someone requested
        // exactly that model in production, and would then blow up as a 500
        // instead of failing here, at startup, which is where a badly written
        // catalogue should fail. Every model declared by the driver is
        // re-validated with the same baseline `validate`.
        for (const model of Object.keys(driver.models || {})) {
            validate(mergeOverride(driver, driver.models[model]));
        }
        byId.set(driver.id, driver);
    }

    function resolveDriver(brand, model = null, logger = null) {
        const base = byId.get(brand);
        if (!base) {
            throw new ScaleError('unknown_brand', `marca no soportada: ${brand}`, {
                brand,
                validBrands: [...byId.keys()],
            });
        }
        if (!model) return base;
        const override = (base.models || {})[model];
        if (override === undefined) {
            // A model without an override is the normal case: the SGA's
            // catalogue is wider than this table because only what deviates
            // gets registered here. It is logged at debug, not as a warning,
            // so as not to fill the log with noise in the common case;
            // `logger` is optional so this module isn't tied to any concrete
            // logging dependency.
            logger?.debug?.(`model '${model}' of '${brand}' has no override registered; using the baseline`);
        }
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
