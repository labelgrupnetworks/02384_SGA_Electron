const test = require('node:test');
const assert = require('node:assert/strict');
const { listCandidateInterfaces } = require('../../src/network/interfaces');

function ipv4(address, internal = false) {
    return { address, family: 'IPv4', internal, netmask: '255.255.255.0' };
}

test('drops loopback and other internal addresses', () => {
    const result = listCandidateInterfaces({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [ipv4('192.168.0.47')],
    });

    assert.deepEqual(result, [{ name: 'eth0', address: '192.168.0.47' }]);
});

test('drops anything that is not IPv4', () => {
    const result = listCandidateInterfaces({
        eth0: [
            { address: 'fe80::1', family: 'IPv6', internal: false },
            ipv4('192.168.0.47'),
        ],
    });

    assert.deepEqual(result, [{ name: 'eth0', address: '192.168.0.47' }]);
});

test('drops link-local, which means DHCP failed', () => {
    const result = listCandidateInterfaces({ eth0: [ipv4('169.254.13.7')] });

    assert.deepEqual(result, []);
});

test('drops the RFC 5737 documentation range, where the lerd dummy lives', () => {
    const result = listCandidateInterfaces({ lerd0: [ipv4('192.0.2.1')] });

    assert.deepEqual(result, []);
});

test('drops container bridges in 172.17.0.0/12', () => {
    const result = listCandidateInterfaces({
        docker0: [ipv4('172.17.0.1')],
        br1: [ipv4('172.31.255.254')],
    });

    assert.deepEqual(result, []);
});

test('keeps legitimate private ranges', () => {
    const result = listCandidateInterfaces({
        a: [ipv4('10.1.2.3')],
        b: [ipv4('192.168.1.10')],
        c: [ipv4('172.16.0.5')],
    });

    assert.deepEqual(result, [
        { name: 'a', address: '10.1.2.3' },
        { name: 'b', address: '192.168.1.10' },
        { name: 'c', address: '172.16.0.5' },
    ]);
});

test('172.16.0.0/12 outside the container span is kept', () => {
    // 172.16.x is a legitimate private range; only 172.17-172.31 are excluded as
    // container bridges. This pins the boundary so the check cannot widen by accident.
    assert.deepEqual(
        listCandidateInterfaces({ eth0: [ipv4('172.16.99.1')] }),
        [{ name: 'eth0', address: '172.16.99.1' }],
    );
    assert.deepEqual(listCandidateInterfaces({ eth0: [ipv4('172.17.0.1')] }), []);
});

test('a public address is kept: it is unusual but not impossible', () => {
    assert.deepEqual(
        listCandidateInterfaces({ eth0: [ipv4('81.45.20.3')] }),
        [{ name: 'eth0', address: '81.45.20.3' }],
    );
});

test('an interface with several addresses yields one entry per address', () => {
    const result = listCandidateInterfaces({
        eth0: [ipv4('192.168.0.47'), ipv4('10.0.0.9')],
    });

    assert.deepEqual(result, [
        { name: 'eth0', address: '192.168.0.47' },
        { name: 'eth0', address: '10.0.0.9' },
    ]);
});

test('no interfaces at all yields an empty list', () => {
    assert.deepEqual(listCandidateInterfaces({}), []);
});

test('the real development machine yields exactly the two good interfaces', () => {
    // This is the regression for the bug: getIPAddress() used to return 192.0.2.1
    // from lerd0 because it kept the last non-internal address it iterated.
    const result = listCandidateInterfaces({
        lo: [ipv4('127.0.0.1', true)],
        enp0s31f6: [ipv4('192.168.0.47')],
        wlp0s20f3: [ipv4('192.168.0.225')],
        lerd0: [ipv4('192.0.2.1')],
    });

    assert.deepEqual(result, [
        { name: 'enp0s31f6', address: '192.168.0.47' },
        { name: 'wlp0s20f3', address: '192.168.0.225' },
    ]);
});
