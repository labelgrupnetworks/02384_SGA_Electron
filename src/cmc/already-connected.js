/**
 * Whether the driver already holds a link to the address about to be probed.
 *
 * A probe opens a second socket. The CMC simulator accepts a single client, so
 * with the bridge connected that second socket is refused and the button
 * reports ECONNREFUSED about a machine that is working perfectly - the status
 * panel says "conectada" in green on the same screen. In a warehouse, "no
 * responde" about a live machine sends someone looking for a network fault
 * that does not exist.
 *
 * When the driver is already connected there is nothing to find out: the
 * address is reachable, and that is what the button should say.
 *
 * @param {{connected?: boolean, address?: string}|null|undefined} machineState
 * @param {{host?: string, port?: *}} target
 */
function isTargetAlreadyLinked(machineState, target) {
    if (!machineState || !machineState.connected) {
        return false;
    }

    const host = String(target?.host ?? '').trim();
    const port = Number(target?.port);

    return machineState.address === `${host}:${port}`;
}

module.exports = { isTargetAlreadyLinked };
