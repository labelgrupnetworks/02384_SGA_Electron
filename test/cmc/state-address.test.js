const test = require('node:test');
const assert = require('node:assert/strict');
const { createMachineClient } = require('../../src/cmc/machine-client');

const silent = { info() {}, warn() {}, error() {} };

test('the client reports the address it is actually using', () => {
    // The status panel used to take the address from the saved settings while
    // taking the error from the running client, so a freshly saved address
    // appeared next to the previous address's timeout - which reads as "the new
    // machine is not answering" when nothing had tried it yet.
    const client = createMachineClient({
        host: '172.18.224.1',
        port: 12001,
        cache: { lookup: () => null, state: () => ({ batch_id: null }) },
        labelers: [],
        logger: silent,
        onResult: () => {},
    });

    assert.equal(client.state().address, '172.18.224.1:12001');
});
