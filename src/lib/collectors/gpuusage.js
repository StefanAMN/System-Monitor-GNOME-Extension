// GPU busy time per process, from the DRM fdinfo the kernel keeps for every
// open GPU file (/proc/<pid>/fdinfo/<fd>: drm-engine-<name>: <ns> ns). The
// user's own processes are readable without privileges. Supported by i915,
// xe and amdgpu among others; the NVIDIA driver does not publish it.
//
// Empty fd caches expire after 5 s and active caches after 15 s; both
// are refreshed at every normal 30 s tracking sample. PID start times
// prevent a reused PID inheriting another's cache.
// A GPU client open in several fds or processes (dup, fork) is counted once.
// Directory entries and fdinfo reads share a bounded idle-callback budget,
// as appusage.js reads cgroups: /proc lives in memory, and an asynchronous
// GIO read per file cost several times the CPU (tests/bench/tracker_cost.js).
//
// HAL layer: reads and sums counters; deltas are the ledger's job.
import GLib from 'gi://GLib';
import { noteReadError, logOnce } from '../common/utils.js';

const RESCAN_US = 15e6;
const EMPTY_RESCAN_US = 5e6;
// Bounded cache: one entry per live process that was looked at.
const MAX_PIDS = 4096;
// Bound actual operations, including descriptor walks of one large process.
const SLICE_OPERATIONS = 64;
const SLICE_US = 2000;
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
function* gpuLinks(dir) {
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
            } catch (e) {
                if (e.matches?.(GLib.FileError, GLib.FileError.ACCES) || e.matches?.(GLib.FileError, GLib.FileError.PERM)) {
                    // ptrace restrictions apply to every link: do not throw once per fd.
                    logOnce('ResourcePulse: some processes\' open files cannot be read (permission denied); GPU time per app leaves those processes out');
                    return fds;
                }
                // Closed while listing: ENOENT is normal; other errors stay visible.
                noteReadError(e);
            }
            yield;
        }
    } finally {
        handle.close();
    }
    return fds;
}

export class GpuUsageSampler {
    /** @param {string} [proc] procfs root (a fixture in tests) */
    constructor(proc = '/proc') {
        this._proc = proc;
        // pid -> { fds: string[], scanned: µs, start: ?number }
        this._pids = new Map();
        // client key -> { ns, reading } when last seen.
        this._clients = new Map();
        // unit -> ns its clients have added up to, ended ones included.
        this._unitNs = new Map();
        this._reading = 0;
        this._idleId = 0;
        this._finish = null;
        this._work = null;
    }

    /** Stop a reading in progress (tracking stopped); its call resolves with nothing. */
    cancel() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._idleId = 0;
        // Returning closes a descriptor-directory iterator suspended at yield.
        this._work?.return();
        this._work = null;
        this._finish?.(new Map());
        this._finish = null;
    }

    /** Read identity separately from cached fds: a reused PID can keep the same fd numbers. */
    _startTime(pid) {
        try {
            const stat = decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/stat`)[1]);
            const value = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
            return Number.isFinite(value) ? value : null;
        } catch (e) {
            noteReadError(e);
            return null;
        }
    }

    /** Yield after every identity, link or fdinfo read, even within one process. */
    *_readPid(pid, unit, now, seen) {
        const start = this._startTime(pid);
        yield;
        let entry = this._pids.get(pid);
        const rescanUs = entry?.fds.length ? RESCAN_US : EMPTY_RESCAN_US;
        if (!entry || entry.start !== start || now - entry.scanned >= rescanUs) {
            const fds = yield* gpuLinks(`${this._proc}/${pid}/fd`);
            entry = { fds, scanned: now, start };
            if (!this._pids.has(pid) && this._pids.size >= MAX_PIDS) this._pids.delete(this._pids.keys().next().value);
            this._pids.set(pid, entry);
            yield;
        }
        for (const fd of entry.fds) {
            try {
                const text = decoder.decode(GLib.file_get_contents(`${this._proc}/${pid}/fdinfo/${fd}`)[1]);
                const client = parseDrmFdinfo(text);
                // A cached fd can be replaced by a non-DRM file without disappearing.
                if (!client) entry.scanned = -Infinity;
                else {
                    // Duplicated fds can expose slightly different cached values. Use
                    // the largest counter, retaining the first unit as its owner.
                    const owner = seen.get(client.key) ?? unit;
                    seen.set(client.key, owner);
                    const before = this._clients.get(client.key);
                    const ns = before ? Math.max(0, client.ns - before.ns) : client.ns;
                    this._clients.set(client.key, { ns: Math.max(client.ns, before?.ns ?? 0), reading: this._reading });
                    // Commit both counters together: cancellation cannot lose a consumed delta.
                    if (ns > 0) this._unitNs.set(owner, (this._unitNs.get(owner) ?? 0) + ns);
                }
            } catch (e) {
                entry.scanned = -Infinity;
                if (e.matches?.(GLib.FileError, GLib.FileError.ACCES) || e.matches?.(GLib.FileError, GLib.FileError.PERM)) {
                    logOnce('ResourcePulse: some processes\' GPU counters cannot be read (permission denied); GPU time per app leaves those processes out');
                    break;
                }
                noteReadError(e);
            }
            yield;
        }
    }

    *_collect(unitPids, now, reading, out) {
        const seen = new Map();
        const live = new Set();
        for (const [unit, pids] of unitPids) {
            for (const pid of pids) {
                live.add(pid);
                yield* this._readPid(pid, unit, now, seen);
            }
        }
        for (const pid of this._pids.keys()) {
            if (!live.has(pid)) this._pids.delete(pid);
            yield;
        }
        for (const [key, client] of this._clients) {
            if (reading - client.reading > CLIENT_KEPT_READINGS) this._clients.delete(key);
            yield;
        }
        for (const [unit, ns] of this._unitNs) {
            if (unitPids.has(unit)) out.set(unit, ns);
            else this._unitNs.delete(unit);
            yield;
        }
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
        const out = new Map();
        this._work = this._collect(unitPids, now, reading, out);
        return new Promise((resolve, reject) => {
            this._finish = resolve;
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                try {
                    const began = GLib.get_monotonic_time();
                    for (let operations = 0; operations < SLICE_OPERATIONS; operations++) {
                        if (this._work.next().done) {
                            this._work = null;
                            this._idleId = 0;
                            this._finish = null;
                            resolve(out);
                            return GLib.SOURCE_REMOVE;
                        }
                        if (GLib.get_monotonic_time() - began >= SLICE_US) break;
                    }
                    return GLib.SOURCE_CONTINUE;
                } catch (e) {
                    this._work = null;
                    this._idleId = 0;
                    this._finish = null;
                    reject(e);
                    return GLib.SOURCE_REMOVE;
                }
            });
        });
    }
}
