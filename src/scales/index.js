const { createRegistry, OPERATIONS, routePathFor } = require('./registry');
const mettlerToledo = require('./drivers/mettler-toledo');
const bizerba = require('./drivers/bizerba');

// Anadir una marca es anadir su driver a esta lista. Las rutas se montan
// recorriendo OPERATIONS, asi que no hay nada mas que tocar.
const registry = createRegistry([mettlerToledo, bizerba]);

module.exports = { registry, OPERATIONS, routePathFor };
