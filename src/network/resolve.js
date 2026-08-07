// src/network/resolve.js
const { listCandidateInterfaces } = require('./interfaces');

/**
 * Which address this workstation should report as its own.
 *
 * Returns an object rather than a string because "I do not know" is a legitimate
 * answer that has to be expressible: GET /ip is how the SGA identifies the
 * workstation, and a guess that happens to be wrong costs a scale that never
 * answers with no sign of why.
 *
 * The order of checks is part of the contract: the saved interface first, the
 * candidate count second. A saved, still-valid interface always wins, even once new
 * candidates appear — whoever chose it already decided.
 *
 * Statuses:
 *   configured      a saved interface that still has an address
 *   single          exactly one candidate; used without asking and without saving
 *   not_configured  two or more candidates and nothing saved
 *   stale           a saved interface that is gone, or no longer a candidate
 *   no_network      nothing that could be this workstation's address
 */
function resolveLocalIp({ interfaces, store }) {
    const candidates = listCandidateInterfaces(interfaces);
    const saved = store.read();
    const savedInterface = typeof saved.interface === 'string' ? saved.interface : null;

    if (savedInterface) {
        const match = candidates.find((c) => c.name === savedInterface);
        if (match) {
            return { ip: match.address, interface: match.name, status: 'configured' };
        }

        // Saved but gone, or still present and excluded by the filter — a settings
        // file naming lerd0 must not resolve to a documentation address.
        return { ip: null, candidates, status: 'stale', savedInterface };
    }

    if (candidates.length === 0) {
        return { ip: null, candidates, status: 'no_network' };
    }

    if (candidates.length === 1) {
        return { ip: candidates[0].address, interface: candidates[0].name, status: 'single' };
    }

    return { ip: null, candidates, status: 'not_configured' };
}

module.exports = { resolveLocalIp };
