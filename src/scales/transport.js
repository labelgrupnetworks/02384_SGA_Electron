const net = require('node:net');
const { ScaleError } = require('./errors');

const DEFAULT_FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 };

/**
 * Conexion TCP a una bascula, con enmarcado de respuestas por lineas.
 *
 * Portado de la clase SicsLink de mt.py. Frente al patron que habia en main.js
 * (cerrar el socket 100 ms despues de la primera rafaga) aporta tres cosas:
 *
 *  - lee hasta que pasan `quietMs` sin datos nuevos, con techo `totalMs`, asi que
 *    una respuesta multilinea llega completa;
 *  - drena lo que quede pendiente antes de cada envio, asi que la cola de un
 *    comando no se lee como respuesta del siguiente;
 *  - admite varios comandos sobre la misma conexion, que es lo que hace posible
 *    la secuencia texto -> pitido -> pesada -> restaurar display.
 */
class TcpLink {
    constructor({ host, port, framing = {} }) {
        this.host = host;
        this.port = port;
        this.framing = { ...DEFAULT_FRAMING, ...framing };
        this.socket = null;
        this.buffer = '';
        this.pending = [];   // lineas completas ya recibidas y sin consumir por ningun _readLines
        this.fatal = null;   // ScaleError que mato la conexion
        this.reads = new Set(); // contextos de _readLines() en curso, para poder cancelarlos desde close()
    }

    get connected() {
        return this.socket !== null;
    }

    connect() {
        this.close();
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const onError = (err) => {
                socket.destroy();
                reject(new ScaleError('connect', `no se puede conectar a ${this.host}:${this.port} (${err.message})`, { host: this.host, port: this.port }));
            };
            socket.once('error', onError);
            socket.connect(this.port, this.host, () => {
                socket.removeListener('error', onError);
                this.socket = socket;
                this.buffer = '';
                this.pending = [];
                this.fatal = null;
                socket.on('data', (chunk) => this._absorb(chunk));
                socket.on('error', (err) => {
                    this.fatal = new ScaleError('protocol', `error de lectura (${err.message})`);
                });
                socket.on('close', () => {
                    if (this.socket === socket) {
                        this.fatal = this.fatal || new ScaleError('protocol', 'la bascula cerro la conexion');
                        this.socket = null;
                    }
                });
                resolve();
            });
        });
    }

    close() {
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            socket.removeAllListeners();
            socket.destroy();
        }
        // Antes de tirar el estado compartido, se sincroniza lo que hubiera en
        // this.pending hacia cada lectura en curso (this.reads). Una linea
        // puede haber sido absorbida del socket (this._absorb ya la puso en
        // this.pending) sin que el tick de ninguna _readLines() la haya
        // drenado todavia hacia su ctx.lines local; si se vaciara this.pending
        // antes de este paso, esa linea se perderia en silencio al cancelar.
        // Orden importa: sync primero, wipe despues. Si hay varias lecturas
        // solapadas en curso, todas reciben la copia (ninguna se queda sin lo
        // ya recibido solo por no ser "la que gana" en una cancelacion).
        if (this.pending.length > 0) {
            for (const ctx of this.reads) {
                ctx.lines.push(...this.pending);
            }
        }
        this.buffer = '';
        this.pending = [];
        this.fatal = null;
        // Cancela cualquier _readLines() en curso: cada uno resuelve con lo que
        // ya llevara acumulado (nunca rechaza) para que un close() a media
        // lectura no explote como error en quien esperaba la respuesta.
        if (this.reads.size > 0) {
            const cancelled = [...this.reads];
            this.reads.clear();
            for (const ctx of cancelled) {
                clearTimeout(ctx.timer);
                ctx.cancel();
            }
        }
    }

    _absorb(chunk) {
        this.buffer += chunk.toString(this.framing.encoding);
        const term = this.framing.terminator;
        let index;
        while ((index = this.buffer.indexOf(term)) !== -1) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + term.length);
            if (line) this.pending.push(line);
        }
    }

    /** Descarta lo que quede del comando anterior. */
    _drain() {
        this.pending = [];
        this.buffer = '';
    }

    async send(raw) {
        if (!this.socket) await this.connect();
        this._drain();
        const payload = raw + this.framing.terminator;
        try {
            this.socket.write(Buffer.from(payload, this.framing.encoding));
        } catch (err) {
            this.close();
            throw new ScaleError('protocol', `error de escritura (${err.message})`);
        }
    }

    async command(raw, { quietMs, totalMs } = {}) {
        await this.send(raw);
        return this._readLines(
            quietMs ?? this.framing.quietMs,
            totalMs ?? this.framing.totalMs,
        );
    }

    /**
     * Espera hasta `quiet` ms de silencio tras la primera linea, o hasta que
     * venza `total`. Devuelve las lineas acumuladas; array vacio si no llego nada.
     *
     * Acumula en un array local a esta llamada (`ctx.lines`), drenando
     * `this.pending` hacia el en cada tick, en vez de leer y reasignar el
     * campo compartido de la instancia directamente. Asi una linea consumida
     * por una llamada no queda visible para otra llamada solapada, y close()
     * puede cancelar esta lectura en curso (registrada en `this.reads`)
     * resolviendola de inmediato con lo que llevara acumulado hasta ese punto.
     */
    _readLines(quiet, total) {
        const deadline = Date.now() + total;
        return new Promise((resolve, reject) => {
            const ctx = { lines: [], timer: null };
            ctx.cancel = () => resolve(ctx.lines);
            this.reads.add(ctx);

            const drain = () => {
                if (this.pending.length > 0) {
                    ctx.lines.push(...this.pending);
                    this.pending = [];
                }
            };
            const finishResolve = (lines) => {
                this.reads.delete(ctx);
                resolve(lines);
            };
            const finishReject = (err) => {
                this.reads.delete(ctx);
                reject(err);
            };

            const tick = () => {
                drain();
                if (this.fatal && ctx.lines.length === 0) {
                    const err = this.fatal;
                    // Se quita de this.reads antes de close() para que el bucle
                    // de cancelacion de close() no intente resolver esta misma
                    // lectura (que va a rechazar, no a resolver).
                    this.reads.delete(ctx);
                    this.close();
                    finishReject(err);
                    return;
                }
                const now = Date.now();
                if (ctx.lines.length > 0) {
                    // Ya hay algo: se espera un hueco de silencio por si viene mas.
                    const count = ctx.lines.length;
                    ctx.timer = setTimeout(() => {
                        drain();
                        if (ctx.lines.length === count || Date.now() >= deadline) {
                            finishResolve(ctx.lines);
                        } else {
                            tick();
                        }
                    }, quiet);
                    return;
                }
                if (now >= deadline) {
                    finishResolve([]);
                    return;
                }
                ctx.timer = setTimeout(tick, 10);
            };
            tick();
        });
    }
}

module.exports = { TcpLink, DEFAULT_FRAMING };
