const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createRegistry, OPERATIONS, routePathFor,
} = require('../../src/scales/registry');
const { ScaleError } = require('../../src/scales/errors');

function toyDriver(overrides = {}) {
    return {
        id: 'toy',
        label: 'Juguete',
        defaultPort: 1234,
        framing: { terminator: '\r\n', encoding: 'latin1' },
        capabilities: ['weigh'],
        deviceDependent: [],
        models: {},
        async weigh() { return { net: { value: 0, unit: 'g' } }; },
        ...overrides,
    };
}

test('resolveDriver devuelve la base cuando no se pasa modelo', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', null);
    assert.equal(driver.id, 'toy');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('un modelo con override cambia solo lo declarado y hereda el resto', () => {
    const registry = createRegistry([toyDriver({
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    const driver = registry.resolveDriver('toy', 'rare');
    assert.equal(driver.framing.terminator, '\r');
    assert.equal(driver.framing.encoding, 'latin1', 'encoding deberia heredarse');
    assert.equal(driver.defaultPort, 1234);
    assert.equal(typeof driver.weigh, 'function');
});

test('un modelo sin override cae a la base sin fallar', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', 'ics425');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('una marca desconocida lanza ScaleError unknown_brand con la lista valida', () => {
    const registry = createRegistry([toyDriver()]);
    assert.throws(() => registry.resolveDriver('acme', null), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'unknown_brand');
        assert.deepEqual(err.detail.validBrands, ['toy']);
        return true;
    });
});

test('rechaza un driver que declara una capacidad sin implementarla', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'tare'] })]),
        /declara 'tare' pero no la implementa/,
    );
});

test('rechaza un driver que implementa una operacion sin declararla', () => {
    assert.throws(
        () => createRegistry([toyDriver({ async tare() {} })]),
        /implementa 'tare' pero no la declara/,
    );
});

test('rechaza una capacidad que no esta en OPERATIONS', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'inventada'], async inventada() {} })]),
        /operacion desconocida: inventada/,
    );
});

test('rechaza una operacion declarada a la vez como garantizada y dependiente', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh'], deviceDependent: ['weigh'] })]),
        /declarada dos veces: weigh/,
    );
});

test('deviceDependent tambien exige implementacion', () => {
    const registry = createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
    })]);
    const driver = registry.resolveDriver('toy', null);
    assert.deepEqual(registry.allOperations(driver).sort(), ['beep', 'weigh']);
});

test('listBrands expone el catalogo para el SGA', () => {
    const registry = createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    assert.deepEqual(registry.listBrands(), [{
        id: 'toy',
        label: 'Juguete',
        defaultPort: 1234,
        capabilities: ['weigh'],
        deviceDependent: ['beep'],
        models: ['rare'],
    }]);
});

test('routePathFor convierte camelCase a kebab-case', () => {
    assert.equal(routePathFor('weigh'), 'weigh');
    assert.equal(routePathFor('clearTare'), 'clear-tare');
    assert.equal(routePathFor('displayClear'), 'display-clear');
    assert.equal(routePathFor('selectPlatform'), 'select-platform');
    assert.equal(routePathFor('guidedWeigh'), 'guided-weigh');
});

test('OPERATIONS contiene las diez operaciones del spec', () => {
    assert.deepEqual([...OPERATIONS].sort(), [
        'beep', 'clearTare', 'display', 'displayClear', 'guidedWeigh',
        'info', 'selectPlatform', 'tare', 'weigh', 'zero',
    ]);
});
