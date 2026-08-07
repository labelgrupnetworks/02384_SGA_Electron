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

test('resolveDriver returns the baseline when no model is passed', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', null);
    assert.equal(driver.id, 'toy');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('a model with an override changes only what is declared and inherits the rest', () => {
    const registry = createRegistry([toyDriver({
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    const driver = registry.resolveDriver('toy', 'rare');
    assert.equal(driver.framing.terminator, '\r');
    assert.equal(driver.framing.encoding, 'latin1', 'encoding should be inherited');
    assert.equal(driver.defaultPort, 1234);
    assert.equal(typeof driver.weigh, 'function');
});

test('a model without an override falls back to the baseline without failing', () => {
    const registry = createRegistry([toyDriver()]);
    const driver = registry.resolveDriver('toy', 'ics425');
    assert.equal(driver.framing.terminator, '\r\n');
});

test('resolveDriver without a logger does not throw (logger is optional)', () => {
    const registry = createRegistry([toyDriver()]);
    assert.doesNotThrow(() => registry.resolveDriver('toy', 'ics425'));
});

test('resolveDriver logs at debug when the model has no override', () => {
    const registry = createRegistry([toyDriver()]);
    const calls = [];
    const logger = { debug: (msg) => calls.push(msg) };
    registry.resolveDriver('toy', 'ics425', logger);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /ics425/);
    assert.match(calls[0], /toy/);
});

test('resolveDriver does NOT log at debug when the model does have an override', () => {
    const registry = createRegistry([toyDriver({
        models: { rare: { framing: { terminator: '\r' } } },
    })]);
    const calls = [];
    const logger = { debug: (msg) => calls.push(msg) };
    registry.resolveDriver('toy', 'rare', logger);
    assert.equal(calls.length, 0);
});

test('resolveDriver without a model logs nothing, with or without a logger', () => {
    const registry = createRegistry([toyDriver()]);
    const calls = [];
    const logger = { debug: (msg) => calls.push(msg) };
    registry.resolveDriver('toy', null, logger);
    assert.equal(calls.length, 0);
});

test('an unknown brand throws ScaleError unknown_brand with the list of valid ones', () => {
    const registry = createRegistry([toyDriver()]);
    assert.throws(() => registry.resolveDriver('acme', null), (err) => {
        assert.ok(err instanceof ScaleError);
        assert.equal(err.code, 'unknown_brand');
        assert.deepEqual(err.detail.validBrands, ['toy']);
        return true;
    });
});

test('rejects a driver that declares a capability without implementing it', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'tare'] })]),
        /declara 'tare' pero no la implementa/,
    );
});

test('rejects a driver that implements an operation without declaring it', () => {
    assert.throws(
        () => createRegistry([toyDriver({ async tare() {} })]),
        /implementa 'tare' pero no la declara/,
    );
});

test('rejects a capability that is not in OPERATIONS', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh', 'inventada'], async inventada() {} })]),
        /operacion desconocida: inventada/,
    );
});

test('rejects an operation declared as both guaranteed and device-dependent', () => {
    assert.throws(
        () => createRegistry([toyDriver({ capabilities: ['weigh'], deviceDependent: ['weigh'] })]),
        /declarada dos veces: weigh/,
    );
});

test('rejects building a model override that declares a capability without implementing it', () => {
    // mergeOverride by itself doesn't revalidate coherence: an override that
    // changed capabilities without the driver implementing the newly declared
    // one would go unnoticed until someone requested that model in
    // production. It must fail here, in createRegistry, not later in
    // resolveDriver nor as a live 500.
    assert.throws(
        () => createRegistry([toyDriver({
            models: { bogus: { capabilities: ['weigh', 'tare'] } },
        })]),
        /declara 'tare' pero no la implementa/,
    );
});

test('rejects building a model override that declares a made-up operation', () => {
    assert.throws(
        () => createRegistry([toyDriver({
            models: { bogus: { capabilities: ['weigh', 'inventada'] } },
        })]),
        /operacion desconocida: inventada/,
    );
});

test('a coherent model override still builds without problems', () => {
    assert.doesNotThrow(() => createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
        models: { rare: { framing: { terminator: '\r' } } },
    })]));
});

test('deviceDependent also requires an implementation', () => {
    const registry = createRegistry([toyDriver({
        deviceDependent: ['beep'],
        async beep() {},
    })]);
    const driver = registry.resolveDriver('toy', null);
    assert.deepEqual(registry.allOperations(driver).sort(), ['beep', 'weigh']);
});

test('listBrands exposes the catalog for the SGA', () => {
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

test('routePathFor converts camelCase to kebab-case', () => {
    assert.equal(routePathFor('weigh'), 'weigh');
    assert.equal(routePathFor('clearTare'), 'clear-tare');
    assert.equal(routePathFor('displayClear'), 'display-clear');
    assert.equal(routePathFor('selectPlatform'), 'select-platform');
    assert.equal(routePathFor('guidedWeigh'), 'guided-weigh');
});

test('OPERATIONS contains the ten operations from the spec', () => {
    assert.deepEqual([...OPERATIONS].sort(), [
        'beep', 'clearTare', 'display', 'displayClear', 'guidedWeigh',
        'info', 'selectPlatform', 'tare', 'weigh', 'zero',
    ]);
});
