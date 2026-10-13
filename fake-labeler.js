/**
 * A stand-in for a labeller, so the last stretch of the cycle can be walked.
 *
 * The bridge sends the label as raw ZPL down a plain TCP socket: connect,
 * write, close. That is all a Zebra expects, and all this does is accept it and
 * show what arrived.
 *
 * It exists because the real labeller's address is the one thing missing to
 * finish a cycle (question A1 for Palau), and without it every LAB1 is answered
 * with "the sending cycle did not start" - which is honest, but means the one
 * part of the flow nobody has ever seen work stays unseen.
 *
 *   node fake-labeler.js [port]
 *
 * Writes each payload to labels-received/ so the ZPL can be inspected, or
 * dropped into any ZPL viewer to see the actual label.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] ?? 9100);
const outputDir = path.join(__dirname, 'labels-received');

fs.mkdirSync(outputDir, { recursive: true });

let received = 0;

const server = net.createServer((socket) => {
    const from = `${socket.remoteAddress}:${socket.remotePort}`;
    const chunks = [];

    socket.on('data', (chunk) => chunks.push(chunk));

    // The bridge closes the socket once the payload is written, so "end" is
    // where a whole label has arrived.
    socket.on('end', () => {
        const content = Buffer.concat(chunks).toString('latin1');
        received++;

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(outputDir, `label-${stamp}.zpl`);
        fs.writeFileSync(file, content, 'latin1');

        const looksLikeZpl = content.trimStart().startsWith('^XA') && content.trimEnd().endsWith('^XZ');

        console.log(`\n--- etiqueta ${received} recibida de ${from} ---`);
        console.log(`  bytes   : ${content.length}`);
        console.log(`  es ZPL  : ${looksLikeZpl ? 'si (^XA...^XZ)' : 'NO'}`);
        console.log(`  guardada: ${path.relative(__dirname, file)}`);

        // The codes printed on the label are what the reader after the
        // labeller compares against MSG_MATCH_LAB1, so they are worth seeing.
        for (const match of content.matchAll(/\^B[A-Z0-9][^^]*\^FD([^^]*)/g)) {
            console.log(`  codigo  : ${match[1]}`);
        }
    });

    socket.on('error', (error) => console.log(`error con ${from}: ${error.message}`));
});

server.listen(port, '127.0.0.1', () => {
    console.log(`etiquetadora de pruebas escuchando en 127.0.0.1:${port}`);
    console.log(`las etiquetas se guardan en ${path.relative(process.cwd(), outputDir)}/`);
});
