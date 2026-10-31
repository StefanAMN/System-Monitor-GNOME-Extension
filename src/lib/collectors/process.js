import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { getSysconf, noteReadError, logOnce } from '../common/utils.js';

// Lenient decoder: process names are arbitrary bytes, not guaranteed UTF-8.
const decoder = new TextDecoder('utf-8', { fatal: false });

// Offsets into the fields that follow "pid (comm) " in /proc/[pid]/stat.
// proc(5) numbers fields from 1 with state as field 3.
const F_UTIME = 14 - 3;
const F_STIME = 15 - 3;
const F_NICE = 19 - 3;
const F_STARTTIME = 22 - 3;
const F_RSS = 24 - 3;
const MIN_FIELDS = F_RSS + 1;

/**
 * Parse the concatenation of many /proc/[pid]/stat files.
 * comm may contain spaces, parentheses and newlines, so each record is split
 * at its last ')' and a record is only complete once enough fields follow it.
 * @param {string} text
 * @returns {{pid: number, comm: string, state: string, ticks: number, start: number, rss: number}[]}
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
            state: fields[0],
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
 * member, so a group's memory here is an upper bound; for the memory list
 * readGroupMemory then replaces it.
 * @param {{comm: string, pid: number, cpu: number, rss: number, rssBytes: number, mem: number}[]} rows
 */
/**
 * The groups whose name contains `query` (case does not matter); every group
 * when the query is empty. Applied before the top rows are taken, so a search
 * looks at every process, not only the busiest five.
 * @param {{comm: string}[]} groups
 * @param {string} query
 */
export function filterGroups(groups, query) {
    const q = (query ?? '').trim().toLocaleLowerCase();
    return q ? groups.filter(g => g.comm.toLocaleLowerCase().includes(q)) : groups;
}

const isStopped = row => row.state === 'T' || row.state === 't';

export function groupByName(rows) {
    const groups = new Map();
    for (const row of rows) {
        const g = groups.get(row.comm);
        if (g) {
            g.count++;
            g.stopped += isStopped(row) ? 1 : 0;
            g.paused = g.stopped === g.count;
            g.members.push({ pid: row.pid, start: row.start });
            g.ioRate += row.ioRate ?? 0;
            g.cpu += row.cpu;
            g.rss += row.rss;
            g.rssBytes += row.rssBytes;
            g.mem += row.mem;
        } else {
            groups.set(row.comm, {
                comm: row.comm, pid: row.pid, count: 1,
                cpu: row.cpu, rss: row.rss, rssBytes: row.rssBytes, mem: row.mem, ioRate: row.ioRate ?? 0,
                // Paused: every member stopped (by the panel, or Ctrl+Z in a terminal).
                stopped: isStopped(row) ? 1 : 0, paused: isStopped(row),
                // Start times guard against a PID reused by a later process.
                members: [{ pid: row.pid, start: row.start }]
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
// Groups read for their real memory, as a multiple of the rows wanted.
const GROUP_MEMORY_MARGIN = 3;

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
/**
 * Storage bytes from /proc/<pid>/io (read_bytes / write_bytes count what
 * reached the disk, not cache hits).
 * @returns {?{read: number, write: number}}
 */
export function parseProcIo(text) {
    const read = /^read_bytes:\s*(\d+)/m.exec(text);
    const write = /^write_bytes:\s*(\d+)/m.exec(text);
    return read && write ? { read: Number(read[1]), write: Number(write[1]) } : null;
}

/**
 * Pages from /proc/<pid>/statm: `shared` are those backed by a file or shared
 * memory, the part several processes can hold at once.
 * @returns {?{resident: number, shared: number}}
 */
export function parseStatm(text) {
    const fields = text.split(' ');
    const resident = Number(fields[1]);
    const shared = Number(fields[2]);
    return Number.isFinite(resident) && Number.isFinite(shared) ? { resident, shared } : null;
}

/**
 * Pages a group of processes holds: each one's private pages, and the largest
 * shared part once. Adding up RSS counts libraries and shared memory once per
 * member, which read about twice the proportional figure (PSS) on the Electron
 * apps and browsers measured (docs/PLAN.md); PSS itself (smaps_rollup) costs
 * far more per process and takes the process's memory lock.
 * @param {{resident: number, shared: number}[]} members
 */
export function groupMemoryPages(members) {
    let priv = 0;
    let shared = 0;
    for (const m of members) {
        priv += Math.max(0, m.resident - m.shared);
        shared = Math.max(shared, m.shared);
    }
    return priv + shared;
}

/**
 * Replace the summed RSS of `groups` of several processes by groupMemoryPages,
 * BATCH files per idle slice like the stat files. A member that has exited
 * counts for nothing; a group none of whose members could be read stays as it was.
 * @param {object[]} groups from groupByName (changed in place)
 * @param {{id: number}} handle receives the idle source id, for cancellation
 * @param {string} [proc] procfs root (a fixture in tests)
 * @returns {Promise<boolean>} false when cancelled
 */
export function readGroupMemory(groups, handle, proc = '/proc') {
    const todo = [];
    for (const group of groups) {
        if (group.count > 1) for (const { pid } of group.members) todo.push([group, pid]);
    }
    if (todo.length === 0) return Promise.resolve(true);
    const read = new Map();
    return new Promise(resolve => {
        let next = 0;
        handle.resolve = resolve;
        handle.id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (const end = Math.min(next + BATCH, todo.length); next < end; next++) {
                const [group, pid] = todo[next];
                try {
                    const pages = parseStatm(decoder.decode(GLib.file_get_contents(`${proc}/${pid}/statm`)[1]));
                    if (pages && read.has(group)) read.get(group).push(pages);
                    else if (pages) read.set(group, [pages]);
                } catch (e) {
                    // Exited since the list was read: normal, as in readAllStats.
                    if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT) && !e.matches?.(GLib.FileError, GLib.FileError.FAILED))
                        noteReadError(e);
                }
            }
            if (next < todo.length) return GLib.SOURCE_CONTINUE;
            handle.id = 0;
            for (const [group, members] of read) group.rss = groupMemoryPages(members);
            resolve(true);
            return GLib.SOURCE_REMOVE;
        });
    });
}

function readAllStats(handle, onChunk, withIo = false, ioDenied = null) {
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
                    logOnce(`Process sample failed: cannot list /proc: ${e.message}`, 'error');
                    handle.id = 0;
                    resolve(true);
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
            const end = Math.min(next + BATCH, pids.length);
            let text = '';
            const io = withIo ? new Map() : null;
            let denied = 0;
            for (; next < end; next++) {
                if (withIo && ioDenied?.has(pids[next])) {
                    // Refused before: it stays refused while the process lives,
                    // and each refusal costs an exception.
                    denied++;
                } else if (withIo) {
                    try {
                        const parsed = parseProcIo(decoder.decode(GLib.file_get_contents(`/proc/${pids[next]}/io`)[1]));
                        if (parsed) io.set(Number(pids[next]), parsed);
                    } catch (e) {
                        // Another user's process: its io file needs ptrace
                        // rights. Counted and shown on the Disk page; exits
                        // are normal as above.
                        if (e.matches?.(GLib.FileError, GLib.FileError.ACCES) || e.matches?.(GLib.FileError, GLib.FileError.PERM)) {
                            denied++;
                            ioDenied?.add(pids[next]);
                        } else if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT) && !e.matches?.(GLib.FileError, GLib.FileError.FAILED))
                            noteReadError(e);
                    }
                }
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
            onChunk(text, GLib.get_monotonic_time(), io, denied);
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
        this._ioDenied = new Set(); // pids (as listed) whose io file was refused
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
     * @param {object} [opts]
     * @param {boolean} [opts.io] also read disk I/O per process and sort by it
     */
    async sample(memTotal, byMemory = false, limit = 5, maxBaselineAgeS = Infinity, { io = false, filter = '' } = {}) {
        const { clkTck, pageSize } = await getSysconf();
        if (this._handle.id) return null; // a read is still in progress
        if (this._prevTime > 0 && (GLib.get_monotonic_time() - this._prevTime) / 1000000 > maxBaselineAgeS)
            this.reset();
        // Disk rates also need a previous sample that read the io counters
        // (the CPU or Memory page does not).
        const warmingUp = this._prevTime === 0 || (io && !this._prevIo);
        const seq = ++this._seq;
        const rows = [];
        let ioDenied = 0;
        const done = await readAllStats(this._handle, (text, time, ioMap, denied) => {
            ioDenied += denied;
            for (const row of parseStatBlob(text)) {
                const prev = this._prev.get(row.pid);
                const dt = prev ? (time - prev.time) / 1000000 : 0;
                const bytes = ioMap?.get(row.pid);
                row.ioTotal = bytes ? bytes.read + bytes.write : undefined;
                row.ioRate = 0;
                row.rssBytes = row.rss * pageSize;
                row.mem = memTotal > 0 ? (row.rssBytes / memTotal) * 100 : 0;
                if (prev && prev.start === row.start && dt < MIN_RATE_INTERVAL_S) {
                    row.cpu = prev.cpu;
                    row.ioRate = prev.ioRate ?? 0;
                    prev.seen = seq;
                } else if (prev) {
                    row.cpu = cpuPercent(prev, row, dt, clkTck);
                    // Same process, both counters read, not reset: a rate.
                    if (prev.start === row.start && prev.io !== undefined && row.ioTotal !== undefined && row.ioTotal >= prev.io)
                        row.ioRate = (row.ioTotal - prev.io) / dt;
                    prev.io = row.ioTotal;
                    prev.ioRate = row.ioRate;
                    prev.start = row.start;
                    prev.ticks = row.ticks;
                    prev.time = time;
                    prev.cpu = row.cpu;
                    prev.seen = seq;
                } else {
                    row.cpu = 0;
                    this._prev.set(row.pid, { start: row.start, ticks: row.ticks, time, cpu: 0, seen: seq, io: row.ioTotal });
                }
                rows.push(row);
            }
        }, io, this._ioDenied);
        if (!done || this._destroyed) return null;
        // Exited processes must not accumulate.
        for (const [pid, prev] of this._prev) {
            if (prev.seen !== seq) this._prev.delete(pid);
        }
        for (const pid of this._ioDenied) {
            if (!this._prev.has(Number(pid))) this._ioDenied.delete(pid);
        }
        this._prevTime = GLib.get_monotonic_time();
        this._prevIo = io;

        const groups = groupByName(rows);
        // A paused group uses no CPU: by CPU it would drop out of the list
        // it can be resumed from, so paused groups come first there.
        const byRss = (a, b) => b.rss - a.rss;
        groups.sort(io
            ? (a, b) => (b.ioRate - a.ioRate) || (b.cpu - a.cpu)
            : byMemory
                ? byRss
                : (a, b) => (b.paused - a.paused) || (b.cpu - a.cpu) || (b.rss - a.rss));
        let top = filterGroups(groups, filter);
        if (byMemory) {
            // Only the likely rows are read: a group's figure can only fall,
            // so those well past the limit by summed RSS stay out of the list.
            top = top.slice(0, limit * GROUP_MEMORY_MARGIN);
            if (!await readGroupMemory(top, this._handle) || this._destroyed) return null;
            for (const group of top) {
                group.rssBytes = group.rss * pageSize;
                group.mem = memTotal > 0 ? (group.rssBytes / memTotal) * 100 : 0;
            }
            top.sort(byRss);
        }
        return {
            warmingUp,
            count: rows.length,
            ioDenied,
            top: top.slice(0, limit)
        };
    }

    reset() {
        this._prev.clear();
        this._ioDenied.clear();
        this._prevTime = 0;
    }
}

// ── Ending processes ─────────────────────────────────────────────────────────

// Ending any of these takes the desktop session down with it. Names as the
// kernel reports them (comm, at most 15 bytes).
const SESSION_CRITICAL = new Set([
    'systemd', 'gnome-shell', 'gnome-session-b', 'gnome-session-c', 'gnome-session-i',
    'Xwayland', 'dbus-daemon', 'dbus-broker', 'dbus-broker-lau', 'gdm-wayland-ses',
    'gdm-x-session', 'pipewire', 'wireplumber',
]);

/**
 * Whether a process group may be offered for ending from the panel.
 * @param {{comm: string, members: {pid: number}[]}} group
 * @param {number} selfPid this shell's pid
 */
export function canEnd(group, selfPid) {
    return !SESSION_CRITICAL.has(group.comm) && !group.members.some(m => m.pid === selfPid || m.pid <= 1);
}

/**
 * Start time, state and owner of a live process, or null once it has exited
 * (a zombie counts as exited: it only waits for its parent to reap it).
 * @param {number} pid
 * @param {string} [proc] procfs root, for tests
 */
export function processIdentity(pid, proc = '/proc') {
    let text;
    let uid;
    try {
        // procfs only, one process: generated by the kernel, never blocks.
        text = decoder.decode(GLib.file_get_contents(`${proc}/${pid}/stat`)[1]);
        uid = Gio.File.new_for_path(`${proc}/${pid}`).query_info('unix::uid', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::uid');
    } catch (e) {
        // Exited: ENOENT, or ESRCH mid-read (reported by GLib as FAILED).
        if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT) && !e.matches?.(GLib.FileError, GLib.FileError.FAILED) &&
            !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            noteReadError(e);
        return null;
    }
    const close = text.lastIndexOf(')');
    const fields = text.slice(close + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return { start: Number(fields[F_STARTTIME]), state: fields[0], nice: Number(fields[F_NICE]), uid };
}

// Niceness a lowered process gets: half way to the lowest priority, so
// what it does still moves; an unprivileged user cannot raise it back.
export const LOWER_NICE = 10;

/**
 * How a group's own processes run now: stopped (all paused), and the
 * lowest priority among them.
 * @param {{pid: number, start: number}[]} members
 * @param {number} uid
 * @returns {{mine: number[], paused: boolean, nice: number}} paused is false with no member left
 */
export function groupState(members, uid, proc = '/proc') {
    const mine = [];
    let stopped = 0;
    let nice = -Infinity;
    for (const m of members) {
        const id = processIdentity(m.pid, proc);
        if (!id || id.start !== m.start || id.uid !== uid) continue;
        mine.push(m.pid);
        // T: stopped by a signal; t: stopped by a debugger.
        if (id.state === 'T' || id.state === 't') stopped++;
        nice = Math.max(nice, id.nice);
    }
    return { mine, paused: mine.length > 0 && stopped === mine.length, nice: mine.length ? nice : 0 };
}

/**
 * Lower the priority of processes with renice(1): an unprivileged user may
 * only raise niceness, never lower it again.
 * @param {number[]} pids
 * @param {number} [nice]
 * @returns {Promise<{ok: boolean, error: string}>}
 */
export function reniceProcesses(pids, nice = LOWER_NICE) {
    return runQuiet(['renice', '-n', String(nice), '-p', ...pids.map(String)], pids.length === 0);
}

function runQuiet(argv, nothing) {
    return new Promise(resolve => {
        if (nothing) {
            resolve({ ok: true, error: '' });
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ ok: false, error: e.message });
            return;
        }
        proc.communicate_utf8_async(null, null, (obj, res) => {
            try {
                const [, , stderr] = obj.communicate_utf8_finish(res);
                resolve({ ok: obj.get_successful(), error: (stderr || '').trim() });
            } catch (e) {
                resolve({ ok: false, error: e.message });
            }
        });
    });
}

/**
 * The members still running as the same process (same start time) and owned
 * by `uid`. Others' processes are reported separately, never signalled.
 * @param {{pid: number, start: number}[]} members
 * @param {number} uid
 * @returns {{mine: number[], others: number}}
 */
export function liveMembers(members, uid, proc = '/proc') {
    const mine = [];
    let others = 0;
    for (const m of members) {
        const id = processIdentity(m.pid, proc);
        if (!id || id.start !== m.start) continue;
        if (id.uid === uid) mine.push(m.pid);
        else others++;
    }
    return { mine, others };
}

/**
 * Send a signal with kill(1).
 * @param {number[]} pids
 * @param {'TERM'|'KILL'|'STOP'|'CONT'} signal
 * @returns {Promise<{ok: boolean, error: string}>} error is kill's own message
 *   (e.g. "Operation not permitted"); a process that exited in the meantime
 *   makes kill fail too, and the caller checks liveness afterwards anyway.
 */
export function signalProcesses(pids, signal) {
    return runQuiet(['kill', '-s', signal, '--', ...pids.map(String)], pids.length === 0);
}
