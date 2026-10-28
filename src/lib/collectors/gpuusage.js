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
import { noteReadError, logOnce } from '../common/utils.js';

const RESCAN_US = 10 * 60 * 1e6;
// Bounded cache: one entry per live process that was looked at.
const MAX_PIDS = 4096;
// Processes looked at per idle callback.
const BATCH = 32;
// A client not seen for this many readings has ended (ids are not reused
// within a boot); until then a failed read does not count it as new.
const CLIENT_KEPT_READINGS = 20;
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
        // Not ours to read (a privileged helper in the session, another
        // user's process): normal, said once, not per process.
        if (e.matches?.(GLib.FileError, GLib.FileError.ACCES) || e.matches?.(GLib.FileError, GLib.FileError.PERM)) {
            logOnce('ResourcePulse: some processes\' open files cannot be read (permission denied); GPU time per app leaves those processes out');
            return fds;
        }
        // A process that exited meanwhile: normal (noteReadError keeps quiet on ENOENT).
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
        // client key -> { ns, reading } when last seen.
        this._clients = new Map();
        // unit -> ns its clients have added up to, ended ones included.
        this._unitNs = new Map();
        this._reading = 0;
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

    /**
     * What a process's GPU clients added since they were last read, each client
     * counted once across the reading (`seen`). Per client: a unit's sum falls
     * when one of its clients ends, and that must not look like a counter reset.
     */
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
            const before = this._clients.get(client.key);
            ns += before ? Math.max(0, client.ns - before.ns) : client.ns;
            this._clients.set(client.key, { ns: client.ns, reading: this._reading });
        }
        return ns;
    }

    /**
     * GPU busy time of each unit's processes.
     * @param {Map<string, number[]>} unitPids unit name -> pids (from cgroup.procs)
     * @returns {Promise<Map<string, number>>} unit -> cumulative ns of the GPU
     *   clients its processes hold or held; it never falls while the unit lives
     */
    sample(unitPids) {
        this.cancel();
        const now = GLib.get_monotonic_time();
        const reading = ++this._reading;
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
                    if (ns > 0) this._unitNs.set(unit, (this._unitNs.get(unit) ?? 0) + ns);
                }
                if (i < todo.length) return GLib.SOURCE_CONTINUE;
                this._idleId = 0;
                this._finish = null;
                for (const pid of this._pids.keys()) if (!live.has(pid)) this._pids.delete(pid);
                for (const [key, client] of this._clients) if (reading - client.reading > CLIENT_KEPT_READINGS) this._clients.delete(key);
                for (const [unit, ns] of this._unitNs) {
                    if (unitPids.has(unit)) out.set(unit, ns);
                    else this._unitNs.delete(unit);
                }
                resolve(out);
                return GLib.SOURCE_REMOVE;
            };
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
        });
    }
}
