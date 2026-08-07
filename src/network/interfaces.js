/**
 * Ranges that can never be a workstation's address on the shop floor.
 *
 * This is a list of exclusions and therefore incomplete by nature: a VPN or a new
 * virtual adapter would still show up as a candidate. That is acceptable, because
 * the consequence is one more question rather than a wrong IP.
 */
function isExcluded(address) {
    // Link-local: DHCP failed, so this is not an address anybody assigned.
    if (address.startsWith('169.254.')) return true;

    // RFC 5737 documentation range. The lerd development environment puts its dummy
    // interface here, which is what made getIPAddress() return 192.0.2.1.
    if (address.startsWith('192.0.2.')) return true;

    // Container bridges, 172.17.0.0/12. Note 172.16.x is NOT excluded: it is a
    // legitimate private range and some installations use it.
    const octets = address.split('.');
    if (octets[0] === '172') {
        const second = Number(octets[1]);
        if (second >= 17 && second <= 31) return true;
    }

    return false;
}

/**
 * The interfaces that could plausibly be this workstation's address.
 *
 * Takes the interface map as an argument rather than calling os.networkInterfaces()
 * itself, so it can be tested against fabricated interfaces without depending on
 * the machine's actual network.
 */
function listCandidateInterfaces(interfaces) {
    const candidates = [];

    for (const [name, addresses] of Object.entries(interfaces || {})) {
        for (const iface of addresses || []) {
            if (iface.family !== 'IPv4') continue;
            if (iface.internal) continue;
            if (isExcluded(iface.address)) continue;
            candidates.push({ name, address: iface.address });
        }
    }

    return candidates;
}

module.exports = { listCandidateInterfaces };
