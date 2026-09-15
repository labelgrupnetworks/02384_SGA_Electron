const { CmcError } = require('./errors');

function validate(manifest) {
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new CmcError('bad_manifest', 'bad_manifest: manifest must be an object');
    }

    if (typeof manifest.batch_id !== 'string' || manifest.batch_id.length === 0) {
        throw new CmcError('bad_manifest', 'bad_manifest: batch_id must be a non-empty string');
    }

    if (!Array.isArray(manifest.entries)) {
        throw new CmcError('bad_manifest', 'bad_manifest: entries must be an array');
    }

    const seen = new Set();

    for (const entry of manifest.entries) {
        if (entry === null || typeof entry !== 'object') {
            throw new CmcError('bad_manifest', 'bad_manifest: each entry must be an object');
        }
        if (typeof entry.barcode !== 'string' || entry.barcode.length === 0) {
            throw new CmcError('bad_manifest', 'bad_manifest: each entry needs a non-empty barcode');
        }
        if (!Array.isArray(entry.label_payloads) || entry.label_payloads.length === 0) {
            throw new CmcError('bad_manifest', `bad_manifest: entry ${entry.barcode} needs at least one label payload`);
        }
        if (seen.has(entry.barcode)) {
            throw new CmcError('bad_manifest', `bad_manifest: duplicate barcode ${entry.barcode}`);
        }
        seen.add(entry.barcode);
    }
}

/**
 * The active batch, in memory.
 *
 * `lookup` sits inside the 500 ms budget the machine gives us to answer an ENQ,
 * so it is a synchronous Map read: no I/O, no parsing, no validation. Everything
 * that can be checked is checked once, in `replace`.
 */
function createManifestCache() {
    let batchId = null;
    let loadedAt = null;
    let entries = new Map();
    const dispatched = new Set();

    return {
        replace(manifest) {
            // Validated before anything is dropped: a bad preload must not leave
            // the operator with no batch loaded at all.
            validate(manifest);

            batchId = manifest.batch_id;
            loadedAt = new Date().toISOString();
            entries = new Map(manifest.entries.map((entry) => [entry.barcode, entry]));
            dispatched.clear();

            return this.state();
        },

        lookup(barcode) {
            return entries.get(barcode) ?? null;
        },

        // Recording a dispatch never removes the entry: if the same box comes
        // round again the bridge must still resolve it rather than reject it.
        markDispatched(barcode) {
            if (entries.has(barcode)) {
                dispatched.add(barcode);
            }
        },

        state() {
            return {
                batch_id: batchId,
                loaded_at: loadedAt,
                total: entries.size,
                dispatched: dispatched.size,
                pending: entries.size - dispatched.size,
            };
        },
    };
}

module.exports = { createManifestCache };
