const { createRegistry, OPERATIONS, routePathFor } = require('./registry');
const mettlerToledo = require('./drivers/mettler-toledo');
const bizerba = require('./drivers/bizerba');

// Adding a brand means adding its driver to this list. Routes are mounted by
// iterating over OPERATIONS, so there is nothing else to touch.
const registry = createRegistry([mettlerToledo, bizerba]);

module.exports = { registry, OPERATIONS, routePathFor };
