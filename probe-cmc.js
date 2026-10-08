/**
 * Throwaway probe: connect to the CMC simulator as the CIS and show, byte for
 * byte, what it sends and what our own protocol.js makes of it.
 *
 * Uses the real parser and the real reply builder on purpose. The point is to
 * find out whether the wire format we implemented from CMC-DataProtocol 4.1
 * matches what the machine actually speaks — nothing here reimplements it.
 *
 *   node probe-cmc.js [host] [port]
 */
const net = require('net');
const {
    createFrameReader, parseMessage, buildEnqReply, frame, MESSAGE_TYPES,
} = require('./src/cmc/protocol');

const host = process.argv[2] ?? '172.18.224.1';
const port = Number(process.argv[3] ?? 12001);

const show = (label, buffer) => {
    const hex = buffer.toString('hex').replace(/(..)/g, '$1 ').trim();
    const ascii = buffer.toString('latin1').replace(/[\x00-\x1f]/g, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
    console.log(`${label} hex   : ${hex}`);
    console.log(`${label} texto : ${ascii}`);
};

const socket = net.connect({ host, port }, () => {
    console.log(`conectado a ${host}:${port} — esperando tramas, pulsa los botones del simulador`);
});

const reader = createFrameReader();

const handle = (payload) => {
    console.log('\n--- trama recibida ---');
    show('  rx', Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'latin1'));

    let message;
    try {
        message = parseMessage(payload);
    } catch (error) {
        console.log(`  PARSER: FALLA -> ${error.message}`);
        return;
    }

    console.log(`  PARSER: ok  type=${message.type}  machineId=${message.machineId}  counter=${message.counter}`);
    console.log(`  campos: ${JSON.stringify(message.fields)}`);

    if (message.type !== MESSAGE_TYPES.ENQ) {
        console.log('  (no es ENQ: no contestamos)');
        return;
    }

    const reply = buildEnqReply({
        machineId: message.machineId,
        counter: message.counter,
        barcode: message.fields[0] ?? '',
        found: true,
        printLabel1: true,
    });

    const out = frame(reply);
    show('  tx', out);
    socket.write(out);
    console.log('  respondido como "encontrado"');
};

socket.on('data', (chunk) => {
    show('RAW', chunk);
    for (const payload of reader(chunk) ?? []) {
        handle(payload);
    }
});

socket.on('error', (error) => console.log(`error: ${error.code} ${error.message}`));
socket.on('close', () => console.log('cerrado'));
