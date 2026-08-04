const net = require('node:net');
const { ScaleError } = require('./errors');

const DEFAULT_FRAMING = { terminator: '\r\n', encoding: 'latin1', quietMs: 250, totalMs: 3000 };

/**
 * TCP connection to a scale, with line-based framing of responses.
 *
 * Ported from the SicsLink class in mt.py. Compared to the pattern that used
 * to live in main.js (closing the socket 100 ms after the first burst), it
 * brings three things:
 *
 *  - it reads until `quietMs` passes with no new data, capped by `totalMs`, so
 *    a multi-line response arrives complete;
 *  - it drains whatever is left pending before each send, so the tail of one
 *    command isn't read as the response to the next;
 *  - it supports several commands over the same connection, which is what
 *    makes the text -> beep -> weigh -> restore display sequence possible.
 */
class TcpLink {
    constructor({ host, port, framing = {} }) {
        this.host = host;
        this.port = port;
        this.framing = { ...DEFAULT_FRAMING, ...framing };
        this.socket = null;
        this.buffer = '';
        this.pending = [];   // complete lines already received and not yet consumed by any _readLines
        this.fatal = null;   // ScaleError that killed the connection
        this.reads = new Set(); // in-flight _readLines() contexts, so they can be cancelled from close()
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
        // Before dropping the shared state, whatever is in this.pending is
        // synced out to every in-flight read (this.reads). A line may have
        // been absorbed from the socket (this._absorb already put it in
        // this.pending) without any _readLines() tick having drained it yet
        // into its local ctx.lines; if this.pending were cleared before this
        // step, that line would be silently lost on cancellation. Order
        // matters: sync first, wipe after. If several reads are in flight at
        // once, all of them get the copy (none is left without what it had
        // already received just for not being "the one that wins" a
        // cancellation).
        if (this.pending.length > 0) {
            for (const ctx of this.reads) {
                ctx.lines.push(...this.pending);
            }
        }
        this.buffer = '';
        this.pending = [];
        this.fatal = null;
        // Cancels any in-flight _readLines(): each one resolves with whatever
        // it had already accumulated (it never rejects), so a close() midway
        // through a read doesn't blow up as an error for whoever was waiting
        // on the response.
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

    /**
     * Discards, on the JS side, whatever had already arrived and been left
     * unconsumed from a previous command (`this.buffer`/`this.pending`) right
     * before sending the next one.
     *
     * This does NOT guarantee that the response read afterwards belongs to
     * the command that was just sent: a line that arrives over the wire
     * AFTER this drain (for example a late response to the previous command,
     * or an unsolicited notification) can still slip in as if it were the
     * response to the new command. That guarantee is provided by `assertOk`
     * comparing the first token of each line against the expected command
     * (Critical 1 from the final review), not by this drain.
     */
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
     * Waits for up to `quiet` ms of silence after the first line, or until
     * `total` expires. Returns the accumulated lines; empty array if nothing
     * arrived.
     *
     * Accumulates into an array local to this call (`ctx.lines`), draining
     * `this.pending` into it on every tick, instead of reading and
     * reassigning the instance's shared field directly. This way a line
     * consumed by one call isn't left visible to another overlapping call,
     * and close() can cancel this in-flight read (registered in
     * `this.reads`) by resolving it immediately with whatever it had
     * accumulated up to that point.
     */
    _readLines(quiet, total) {
        // Last-resort defence: quiet/total may arrive non-numeric or
        // non-positive from a higher layer (e.g. `timeoutMs` as a string from
        // an HTTP body: `Date.now() + "10000"` is concatenation, not
        // addition, and the comparison against that "deadline" never comes
        // due). A transport primitive must not be able to hang forever just
        // because its caller passed a weird value: if it isn't a finite,
        // positive number, it falls back to this framing's default instead of
        // propagating the bad value.
        const safeQuiet = (Number.isFinite(quiet) && quiet > 0) ? quiet : this.framing.quietMs;
        const safeTotal = (Number.isFinite(total) && total > 0) ? total : this.framing.totalMs;
        const deadline = Date.now() + safeTotal;
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
                    // Removed from this.reads before close() so close()'s
                    // cancellation loop doesn't try to resolve this very same
                    // read (which is going to reject, not resolve).
                    this.reads.delete(ctx);
                    this.close();
                    finishReject(err);
                    return;
                }
                const now = Date.now();
                if (ctx.lines.length > 0) {
                    // There's already something: wait for a gap of silence in case more comes.
                    const count = ctx.lines.length;
                    ctx.timer = setTimeout(() => {
                        drain();
                        if (ctx.lines.length === count || Date.now() >= deadline) {
                            finishResolve(ctx.lines);
                        } else {
                            tick();
                        }
                    }, safeQuiet);
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
