// src/config/store.js
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'settings.json';

/**
 * A tiny JSON settings file.
 *
 * The directory is injected rather than read from Electron's app.getPath, so this
 * module can be tested without Electron and main.js stays the only place that knows
 * where userData lives.
 */
function createStore(baseDir, logger = null) {
    const filePath = path.join(baseDir, FILE_NAME);

    // A corrupt settings file silently resetting the choice would leave an operator
    // watching the dialog reappear with no idea why, so it leaves a trace.
    const warn = (message) => {
        if (logger && typeof logger.warn === 'function') logger.warn(message);
    };

    const store = {
        path: filePath,

        /**
         * The stored settings, or {} when there are none to be had.
         *
         * A missing, unreadable, corrupt or non-object file all read as {}. Starting
         * up and asking again beats refusing to boot over a damaged settings file.
         */
        read() {
            let raw;
            try {
                raw = fs.readFileSync(filePath, 'utf8');
            } catch (error) {
                // A missing file is the normal first-run case and not worth a warning.
                if (error.code !== 'ENOENT') {
                    warn(`No se pudo leer ${filePath}: ${error.message}`);
                }
                return {};
            }

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                warn(`Configuracion corrupta en ${filePath}, se ignora: ${error.message}`);
                return {};
            }

            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                warn(`Configuracion inesperada en ${filePath}, se ignora`);
                return {};
            }

            return parsed;
        },

        write(config) {
            fs.mkdirSync(baseDir, { recursive: true });
            fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        },

        /**
         * Writes a single key without disturbing the rest of the file.
         *
         * `write()` overwrites the whole file, so a caller that only knows about
         * one key (like the interface picker) would silently wipe out any other
         * block already stored there (e.g. the `cmc` config). This reads the
         * current contents first and writes back the merge, so sibling keys
         * survive.
         */
        set(key, value) {
            const current = store.read();
            current[key] = value;
            store.write(current);
            return current;
        },
    };

    return store;
}

module.exports = { createStore };
