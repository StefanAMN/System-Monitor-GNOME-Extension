import GLib from 'gi://GLib';
import { getSysconf, noteReadError } from './utils.js';

// Lenient decoder: process names are arbitrary bytes, not guaranteed UTF-8.
const decoder = new TextDecoder('utf-8', { fatal: false });

// Offsets into the fields that follow "pid (comm) " in /proc/[pid]/stat.
// proc(5) numbers fields from 1 with state as field 3.
const F_UTIME = 14 - 3;
const F_STIME = 15 - 3;
const F_STARTTIME = 22 - 3;
const F_RSS = 24 - 3;
const MIN_FIELDS = F_RSS + 1;

/**
 * Parse the concatenation of many /proc/[pid]/stat files.
 * comm may contain spaces, parentheses and newlines, so each record is split
 * at its last ')' and a record is only complete once enough fields follow it.
 * @param {string} text
 * @returns {{pid: number, comm: string, ticks: number, start: number, rss: number}[]}
 */
export function parseStatBlob(text) {
    const out = [];
    const lines = text.split('\n');
    let pending = '';
    for (const line of lines) {
        const record = pending ? `${pending}\n${line}` : line;
        const close = record.lastIndexOf(')');
        const open = record.indexOf('(');
        if (open < 0 || close < open) {
            pending = open >= 0 ? record : '';
            continue;
        }
        const fields = record.slice(close + 2).split(' ');
        if (fields.length < MIN_FIELDS) {
            pending = record;
            continue;
        }
        pending = '';
        const pid = parseInt(record.slice(0, open), 10);
        if (!(pid > 0)) continue;
        out.push({
            pid,
            comm: record.slice(open + 1, close),
            ticks: Number(fields[F_UTIME]) + Number(fields[F_STIME]),
            start: Number(fields[F_STARTTIME]),
            rss: Number(fields[F_RSS])
        });
    }
    return out;
}

/**
 * CPU share of one process between two samples, top-style: 100 = one full core.
 * A reused PID (different start time) or a counter going backwards yields 0.
 */
export function cpuPercent(prev, cur, deltaSeconds, clkTck) {
    if (!prev || prev.start !== cur.start || !(deltaSeconds > 0)) return 0;
    const dTicks = cur.ticks - prev.ticks;
    if (!(dTicks > 0)) return 0;
    return (dTicks / clkTck / deltaSeconds) * 100;
}

/**
 * Merge rows that share a name into one row per application-ish group.
 * Costs nothing extra to collect; the kernel truncates comm to 15 bytes, so
 * helpers that rename themselves (e.g. browser content processes) form
 * their own group. Summed RSS counts pages shared between members once per
 * member, so a group's memory is an upper bound.
 * @param {{comm: string, pid: number, cpu: number, rss: number, rssBytes: number, mem: number}[]} rows
 */
export function groupByName(rows) {
    const groups = new Map();
    for (const row of rows) {
        const g = groups.get(row.comm);
        if (g) {
            g.count++;
            g.cpu += row.cpu;
            g.rss += row.rss;
            g.rssBytes += row.rssBytes;
            g.mem += row.mem;
        } else {
            groups.set(row.comm, {
                comm: row.comm, pid: row.pid, count: 1,
                cpu: row.cpu, rss: row.rss, rssBytes: row.rssBytes, mem: row.mem
            });
        }
    }
    return [...groups.values()];
}

// Below this, one 10 ms clock tick is a large share of the interval and the
// rate is noise (a single tick over 5 ms reads as 200%): keep the previous
// rate and the older baseline until the interval is long enough.
const MIN_RATE_INTERVAL_S = 0.25;

// Files read per main-loop slice: ~0.3 ms of work, far below a frame.
const BATCH = 32;

function listPids() {
    // GLib.Dir: ~0.8 ms for 500 entries, a third of a GFileEnumerator.
    const pids = [];
    const dir = GLib.Dir.open('/proc', 0);
    try {
        let name;
        while ((name = dir.read_name())) {
            const c = name.charCodeAt(0);
            if (c >= 48 && c <= 57) pids.push(name);
        }
    } finally {
        dir.close();
    }
    return pids;
}

/**
 * Read every /proc/<pid>/stat inside the shell, BATCH files per idle slice,
 * handing each batch to onChunk(text, time) in the same slice so parsing is
 * spread out as well. Measured on 508 processes: ~5 ms CPU per sample in
 * total, versus ~22 ms for spawning `sh` + `cat` and ~53 ms for one async
 * GIO request per file.
 *
 * These are synchronous reads on the main loop, the one exception (approved
 * by the owner, 2026-10-03) to "no synchronous I/O in the shell": procfs
 * files are generated in memory by the kernel and never wait on storage,
 * and each slice is bounded to BATCH files. It covers procfs only: never
 * /sys, never unbounded loops, never files on real filesystems.
 *
 * `time` is the monotonic time the batch was read, so every process's rate
 * uses its own interval. Resolves true when done, false when cancelled.
 * @param {{ id: number }} handle receives the idle source id, for cancellation
 */
function readAllStats(handle, onChunk) {
    return new Promise((resolve) => {
        let pids = null;
        let next = 0;
        handle.resolve = resolve;
        handle.id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (pids === null) {
                // Listing gets a slice of its own.
                try {
                    pids = listPids();
                } catch (e) {
                    console.error(`Process sample failed: cannot list /proc: ${e.message}`);
                    handle.id = 0;
                    resolve(true);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
            const end = Math.min(next + BATCH, pids.length);
            let text = '';
            for (; next < end; next++) {
                try {
                    const [, bytes] = GLib.file_get_contents(`/proc/${pids[next]}/stat`);
                    text += decoder.decode(bytes);
                } catch (e) {
                    // The process exited after listing: normal. ENOENT when
                    // it was gone before open(); ESRCH when it died between
                    // open() and read(), which GLib has no code for and
                    // reports as FAILED. Anything else (EACCES, EIO) is real.
                    if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT) &&
                        !e.matches?.(GLib.FileError, GLib.FileError.FAILED))
                        noteReadError(e);
                }
            }
            onChunk(text, GLib.get_monotonic_time());
            if (next < pids.length) return GLib.SOURCE_CONTINUE;
            handle.id = 0;
            resolve(true);
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class ProcessSampler {
    constructor() {
        this._prev = new Map(); // pid -> { start, ticks, time, seen }
        this._prevTime = 0;
        this._seq = 0;
        this._handle = { id: 0 };
        this._destroyed = false;
    }

    /** Stop an in-progress read (called from the extension's disable()). */
    destroy() {
        this._destroyed = true;
        if (this._handle.id) {
            GLib.source_remove(this._handle.id);
            this._handle.id = 0;
            this._handle.resolve?.(false);
        }
        this._prev.clear();
    }

    /**
     * @param {number} memTotal total RAM in bytes (for mem %)
     * @param {boolean} byMemory sort by resident memory instead of CPU
     * @param {number} limit rows to return
     * @param {number} maxBaselineAgeS a previous sample older than this is
     *   dropped: a rate over a long gap is an average of the past, not the
     *   current load. The result is then `warmingUp` with every rate at 0.
     */
    async sample(memTotal, byMemory = false, limit = 5, maxBaselineAgeS = Infinity) {
        const { clkTck, pageSize } = await getSysconf();
        if (this._handle.id) return null; // a read is still in progress
        if (this._prevTime > 0 && (GLib.get_monotonic_time() - this._prevTime) / 1000000 > maxBaselineAgeS)
            this.reset();
        const warmingUp = this._prevTime === 0;
        const seq = ++this._seq;
        const rows = [];
        const done = await readAllStats(this._handle, (text, time) => {
            for (const row of parseStatBlob(text)) {
                const prev = this._prev.get(row.pid);
                const dt = prev ? (time - prev.time) / 1000000 : 0;
                row.rssBytes = row.rss * pageSize;
                row.mem = memTotal > 0 ? (row.rssBytes / memTotal) * 100 : 0;
                if (prev && prev.start === row.start && dt < MIN_RATE_INTERVAL_S) {
                    row.cpu = prev.cpu;
                    prev.seen = seq;
                } else if (prev) {
                    row.cpu = cpuPercent(prev, row, dt, clkTck);
                    prev.start = row.start;
                    prev.ticks = row.ticks;
                    prev.time = time;
                    prev.cpu = row.cpu;
                    prev.seen = seq;
                } else {
                    row.cpu = 0;
                    this._prev.set(row.pid, { start: row.start, ticks: row.ticks, time, cpu: 0, seen: seq });
                }
                rows.push(row);
            }
        });
        if (!done || this._destroyed) return null;
        // Exited processes must not accumulate.
        for (const [pid, prev] of this._prev) {
            if (prev.seen !== seq) this._prev.delete(pid);
        }
        this._prevTime = GLib.get_monotonic_time();

        const groups = groupByName(rows);
        groups.sort(byMemory
            ? (a, b) => b.rss - a.rss
            : (a, b) => (b.cpu - a.cpu) || (b.rss - a.rss));
        return {
            warmingUp,
            count: rows.length,
            top: groups.slice(0, limit)
        };
    }

    reset() {
        this._prev.clear();
        this._prevTime = 0;
    }
}
