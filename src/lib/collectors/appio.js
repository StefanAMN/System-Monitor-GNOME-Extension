// Disk bytes per session unit, from /proc/<pid>/io of each unit's processes.
//
// The cgroup io controller is not delegated to user sessions, so a unit's own
// counters (io.stat) do not exist; the user's own processes' counters can be
// read. They are per process: bytes of a process that started and ended
// between two readings are missed, and the figure is an estimate.
//
// Deltas are keyed by PID and start time. All listed processes are read:
// asynchronous writeback can advance their I/O counters without CPU time.
// A temporary failure retains the known baseline while that same process
// remains listed; a process identity change starts a fresh counter.
//
// The files are read synchronously in batches, one batch per idle callback,
// as the process list does (process.js): /proc reads do not touch a disk, and
// a few hundred asynchronous reads cost the shell far more CPU.
//
// HAL layer: bytes per unit, nothing formatted.
import GLib from 'gi://GLib';

import { logOnce, noteReadError } from '../common/utils.js';
import { parseProcIo, F_STARTTIME } from './process.js';

const BATCH = 32;
const decoder = new TextDecoder('utf-8', { fatal: false });

export class AppIoSampler {
    /** @param {string} [proc] /proc, or a fixture in tests */
    constructor(proc = '/proc') {
        this._proc = proc;
        // pid -> { start, read, write, unit }; bounded by the listed processes.
        this._prev = new Map();
        this._primed = false;
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
        this._primed = false;
    }

    /** Stop a reading in progress (tracking stopped); its call resolves with nothing. */
    cancel() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._finish?.(new Map());
        this._finish = null;
    }

    /** Start time is stable for a process and distinguishes a recycled PID. */
    _start(pid) {
        const stat = decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/stat`)[1]);
        const close = stat.lastIndexOf(')');
        const value = close < 0 ? NaN : Number(stat.slice(close + 2).split(' ')[F_STARTTIME]);
        return Number.isFinite(value) ? value : null;
    }

    /** One process's counters, or null when it ended or cannot be read. */
    _read(pid) {
        try {
            const start = this._start(pid);
            if (start === null) return null;
            const io = parseProcIo(decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/io`)[1]));
            // It can exit and its PID can be reused between either read.
            return io && this._start(pid) === start ? { ...io, start } : null;
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
        const todo = [];
        for (const { unit, pids = [] } of units) {
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
                    const before = this._prev.get(pid);
                    if (!io) {
                        // A failed counter read does not make the next successful
                        // reading the whole lifetime of a "new" process.
                        next.set(pid, before ?? { unit, start: null, read: null, write: null });
                        continue;
                    }
                    next.set(pid, { ...io, unit });
                    if (!this._primed || before?.start === null) continue;
                    const same = before?.start === io.start;
                    // Migration to another unit is a new attribution baseline:
                    // its old unit's lifetime must not be assigned to the new one.
                    if (same && before.unit !== unit) continue;
                    const read = same ? Math.max(0, io.read - before.read) : io.read;
                    const write = same ? Math.max(0, io.write - before.write) : io.write;
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
                this._primed = true;
                this.denied = this._denied;
                resolve(out);
                return GLib.SOURCE_REMOVE;
            };
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
        });
    }
}
