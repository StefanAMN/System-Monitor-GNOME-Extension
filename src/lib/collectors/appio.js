// Disk bytes per session unit, from /proc/<pid>/io of each unit's processes.
//
// The cgroup io controller is not delegated to user sessions, so a unit's own
// counters (io.stat) do not exist; the user's own processes' counters can be
// read. They are per process: bytes of a process that started and ended
// between two readings are missed, and the figure is an estimate.
//
// Deltas are kept per pid. Reading or writing takes processor time, so a
// unit whose CPU time did not move since the previous call is not read: its
// processes keep their previous counters. Every other unit is read whole, so
// a pid not seen before started since then (with CPU time, in a unit that is
// read) and counts from zero; a counter lower than before is a new process
// with a reused pid. The first call reads every unit.
//
// HAL layer: bytes per unit, nothing formatted.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readFileAsync, logOnce } from '../common/utils.js';

/**
 * @param {string} text /proc/<pid>/io
 * @returns {?{read: number, write: number}} bytes that reached the storage layer
 */
export function parseProcIo(text) {
    let read = null;
    let write = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('read_bytes: ')) read = Number(line.slice(12));
        else if (line.startsWith('write_bytes: ')) write = Number(line.slice(13));
    }
    return Number.isFinite(read) && Number.isFinite(write) ? { read, write } : null;
}

function isMissing(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || e?.matches?.(GLib.FileError, GLib.FileError.NOENT) ||
        // A process that ended while its file was open reads as ESRCH.
        /No such process/.test(e?.message ?? '');
}

export class AppIoSampler {
    /** @param {string} [proc] /proc, or a fixture in tests */
    constructor(proc = '/proc') {
        this._proc = proc;
        // pid -> { read, write } at the previous call; only live processes.
        this._prev = new Map();
        this._primed = false;
        // unit -> its CPU µs at the previous call.
        this._prevUsec = new Map();
        // Processes whose counters could not be read at the last call.
        this.denied = 0;
    }

    /** Forget the previous reading (tracking restarted): the next call only sets the baseline. */
    reset() {
        this._prev = new Map();
        this._prevUsec = new Map();
        this._primed = false;
    }

    /**
     * @param {Array<{unit: string, usec: number, pids: number[]}>} units each unit's CPU time and processes
     * @returns {Promise<Map<string, {read: number, write: number}>>} bytes per
     *   unit since the previous call; empty on the first call
     */
    async sample(units) {
        const next = new Map();
        const out = new Map();
        const usec = new Map();
        let denied = 0;
        for (const { unit, usec: cpu, pids = [] } of units) {
            usec.set(unit, cpu);
            if (this._primed && this._prevUsec.get(unit) === cpu) {
                // Idle since the last call: nothing read or written.
                for (const pid of pids) if (this._prev.has(pid)) next.set(pid, this._prev.get(pid));
                continue;
            }
            for (const pid of pids) {
                let io;
                try {
                    io = parseProcIo(await readFileAsync(`${this._proc}/${pid}/io`));
                } catch (e) {
                    // The process ended since it was listed: a normal event.
                    if (!isMissing(e)) {
                        denied++;
                        // Once per reason, not per process (the message names the path).
                        logOnce(`ResourcePulse: per-process disk counters cannot be read (${e.message.replace(/^.*: /, '')}); disk use per app leaves those processes out`);
                    }
                    continue;
                }
                if (!io) continue;
                next.set(pid, io);
                if (!this._primed) continue;
                const before = this._prev.get(pid);
                const read = !before || io.read < before.read ? io.read : io.read - before.read;
                const write = !before || io.write < before.write ? io.write : io.write - before.write;
                if (read === 0 && write === 0) continue;
                const sum = out.get(unit) ?? { read: 0, write: 0 };
                sum.read += read;
                sum.write += write;
                out.set(unit, sum);
            }
        }
        this._prev = next;
        this._prevUsec = usec;
        this._primed = true;
        this.denied = denied;
        return out;
    }
}
