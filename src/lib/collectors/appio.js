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
// The files are read synchronously in batches, one batch per idle callback,
// as the process list does (process.js): /proc reads do not touch a disk, and
// a few hundred asynchronous reads cost the shell far more CPU.
//
// HAL layer: bytes per unit, nothing formatted.
import GLib from 'gi://GLib';

import { logOnce, noteReadError } from '../common/utils.js';
import { parseProcIo } from './process.js';

export { parseProcIo };

const BATCH = 32;
const decoder = new TextDecoder('utf-8', { fatal: false });

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
        this._denied = 0;
        this._idleId = 0;
        this._finish = null;
    }

    /** Forget the previous reading (tracking restarted): the next call only sets the baseline. */
    reset() {
        this.cancel();
        this._prev = new Map();
        this._prevUsec = new Map();
        this._primed = false;
    }

    /** Stop a reading in progress (tracking stopped); its call resolves with nothing. */
    cancel() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._finish?.(new Map());
        this._finish = null;
    }

    /** One process's counters, or null when it ended or cannot be read. */
    _read(pid) {
        try {
            return parseProcIo(decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/io`)[1]));
        } catch (e) {
            // ENOENT: ended before open(); ESRCH (FAILED to GLib): ended
            // while being read. Both are normal.
            if (e.matches?.(GLib.FileError, GLib.FileError.NOENT) || e.matches?.(GLib.FileError, GLib.FileError.FAILED)) return null;
            if (e.matches?.(GLib.FileError, GLib.FileError.ACCES) || e.matches?.(GLib.FileError, GLib.FileError.PERM)) {
                this._denied++;
                // Once, not per process (the message names the path).
                logOnce('ResourcePulse: some per-process disk counters cannot be read (permission denied); disk use per app leaves those processes out');
                return null;
            }
            noteReadError(e);
            return null;
        }
    }

    /**
     * @param {Array<{unit: string, usec: number, pids: number[]}>} units each unit's CPU time and processes
     * @returns {Promise<Map<string, {read: number, write: number}>>} bytes per
     *   unit since the previous call; empty on the first call
     */
    sample(units) {
        this.cancel();
        const next = new Map();
        const out = new Map();
        const usec = new Map();
        const todo = [];
        for (const { unit, usec: cpu, pids = [] } of units) {
            usec.set(unit, cpu);
            if (this._primed && this._prevUsec.get(unit) === cpu) {
                // Idle since the last call: nothing read or written.
                for (const pid of pids) if (this._prev.has(pid)) next.set(pid, this._prev.get(pid));
                continue;
            }
            for (const pid of pids) todo.push([unit, pid]);
        }
        this._denied = 0;
        return new Promise(resolve => {
            this._finish = resolve;
            let i = 0;
            const step = () => {
                for (const end = Math.min(i + BATCH, todo.length); i < end; i++) {
                    const [unit, pid] = todo[i];
                    const io = this._read(pid);
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
                if (i < todo.length) return GLib.SOURCE_CONTINUE;
                this._idleId = 0;
                this._finish = null;
                this._prev = next;
                this._prevUsec = usec;
                this._primed = true;
                this.denied = this._denied;
                resolve(out);
                return GLib.SOURCE_REMOVE;
            };
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
        });
    }
}
