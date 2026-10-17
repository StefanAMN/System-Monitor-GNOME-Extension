// GPU busy time per process, from the DRM fdinfo the kernel keeps for every
// open GPU file (/proc/<pid>/fdinfo/<fd>: drm-engine-<name>: <ns> ns). The
// user's own processes are readable without privileges. Supported by i915,
// xe and amdgpu among others; the NVIDIA driver does not publish it.
//
// Cost control: a process's fd table is listed once and then again only
// every RESCAN_US; in between only the fdinfo files of its GPU fds are read.
// A GPU client open in several fds or processes (dup, fork) is counted once.
// The files are read synchronously, a batch of processes per idle callback,
// as appusage.js reads cgroups: /proc lives in memory, and an asynchronous
// GIO read per file cost several times the CPU (tests/bench/tracker_cost.js).
//
// HAL layer: reads and sums counters; deltas are the ledger's job.
import GLib from 'gi://GLib';
import { noteReadError } from '../common/utils.js';

const RESCAN_US = 10 * 60 * 1e6;
// Bounded cache: one entry per live process that was looked at.
const MAX_PIDS = 4096;
// Processes looked at per idle callback.
const BATCH = 32;
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Busy time and identity of a GPU client from its fdinfo text.
 * @returns {?{key: string, ns: number}} null when the file is not a DRM client
 */
export function parseDrmFdinfo(text) {
    const client = /^drm-client-id:\s*(\d+)/m.exec(text);
    if (!client) return null;
    const pdev = /^drm-pdev:\s*(\S+)/m.exec(text)?.[1] ?? '';
    const driver = /^drm-driver:\s*(\S+)/m.exec(text)?.[1] ?? '';
    let ns = 0;
    // drm-engine-<name>: <n> ns; capacity lines (drm-engine-capacity-*) have no unit.
    for (const m of text.matchAll(/^drm-engine-(?!capacity-)[\w-]+:\s*(\d+)\s*ns/gm)) ns += Number(m[1]);
    return { key: `${driver}/${pdev}/${client[1]}`, ns };
}

/** The fds of `dir` (a /proc/<pid>/fd) that are open on a GPU device. */
function gpuLinks(dir) {
    const fds = [];
    let handle;
    try {
        handle = GLib.Dir.open(dir, 0);
    } catch (e) {
        // A process that exited meanwhile, or another user's: normal.
        noteReadError(e);
        return fds;
    }
    try {
        for (let fd = handle.read_name(); fd !== null; fd = handle.read_name()) {
            try {
                if (GLib.file_read_link(`${dir}/${fd}`).startsWith('/dev/dri/')) fds.push(fd);
            } catch {
                // Closed while listing: skipped.
            }
        }
    } finally {
        handle.close();
    }
    // In fd order, whatever the directory's: a client open in several fds
    // is then always read from the lowest one.
    return fds.sort((a, b) => Number(a) - Number(b));
}

export class GpuUsageSampler {
    /** @param {string} [proc] procfs root (a fixture in tests) */
    constructor(proc = '/proc') {
        this._proc = proc;
        // pid -> { fds: string[], scanned: µs }
        this._pids = new Map();
        this._idleId = 0;
        this._finish = null;
    }

    /** Stop a reading in progress (tracking stopped); its call resolves with nothing. */
    cancel() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._finish?.(new Map());
        this._finish = null;
    }

    _gpuFds(pid, now) {
        let entry = this._pids.get(pid);
        if (!entry || now - entry.scanned > RESCAN_US) {
            entry = { fds: gpuLinks(`${this._proc}/${pid}/fd`), scanned: now };
            if (this._pids.size >= MAX_PIDS) this._pids.clear();
            this._pids.set(pid, entry);
        }
        return entry.fds;
    }

    /** A process's GPU busy time, each client counted once across the reading (`seen`). */
    _readPid(pid, now, seen) {
        let ns = 0;
        for (const fd of this._gpuFds(pid, now)) {
            let text;
            try {
                text = decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/fdinfo/${fd}`)[1]);
            } catch (e) {
                // Closed since the scan, or the process exited: rescan next time.
                noteReadError(e);
                this._pids.delete(pid);
                continue;
            }
            const client = parseDrmFdinfo(text);
            if (!client || seen.has(client.key)) continue;
            seen.add(client.key);
            ns += client.ns;
        }
        return ns;
    }

    /**
     * GPU busy time of each unit's processes.
     * @param {Map<string, number[]>} unitPids unit name -> pids (from cgroup.procs)
     * @returns {Promise<Map<string, number>>} unit -> cumulative ns of the GPU clients its processes hold
     */
    sample(unitPids) {
        this.cancel();
        const now = GLib.get_monotonic_time();
        const seen = new Set();
        const live = new Set();
        const out = new Map();
        const todo = [];
        for (const [unit, pids] of unitPids) for (const pid of pids) todo.push([unit, pid]);
        return new Promise(resolve => {
            this._finish = resolve;
            let i = 0;
            const step = () => {
                for (const end = Math.min(i + BATCH, todo.length); i < end; i++) {
                    const [unit, pid] = todo[i];
                    live.add(pid);
                    const ns = this._readPid(pid, now, seen);
                    if (ns > 0) out.set(unit, (out.get(unit) ?? 0) + ns);
                }
                if (i < todo.length) return GLib.SOURCE_CONTINUE;
                this._idleId = 0;
                this._finish = null;
                for (const pid of this._pids.keys()) if (!live.has(pid)) this._pids.delete(pid);
                resolve(out);
                return GLib.SOURCE_REMOVE;
            };
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
        });
    }
}
