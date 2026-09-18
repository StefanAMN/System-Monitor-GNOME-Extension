// GPU busy time per process, from the DRM fdinfo the kernel keeps for every
// open GPU file (/proc/<pid>/fdinfo/<fd>: drm-engine-<name>: <ns> ns). The
// user's own processes are readable without privileges. Supported by i915,
// xe and amdgpu among others; the NVIDIA driver does not publish it.
//
// Cost control: a process's fd table is listed once (one asynchronous
// enumeration with link targets) and then again only every RESCAN_US; in
// between only the fdinfo files of its GPU fds are read. A GPU client open
// in several fds or processes (dup, fork) is counted once.
//
// HAL layer: reads and sums counters; deltas are the ledger's job.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readFileAsync, noteReadError } from '../common/utils.js';

const RESCAN_US = 10 * 60 * 1e6;
// Bounded cache: one entry per live process that was looked at.
const MAX_PIDS = 4096;

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

function listLinks(dir) {
    return new Promise(resolve => {
        Gio.File.new_for_path(dir).enumerate_children_async('standard::name,standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null, (obj, res) => {
                const links = [];
                try {
                    const en = obj.enumerate_children_finish(res);
                    try {
                        // Entries without a target (an fd closed while listing) are skipped.
                        for (let info = en.next_file(null); info; info = en.next_file(null)) {
                            if (info.has_attribute('standard::symlink-target'))
                                links.push([info.get_name(), info.get_symlink_target()]);
                        }
                    } finally {
                        en.close(null);
                    }
                } catch (e) {
                    // A process that exited meanwhile, or another user's: normal.
                    noteReadError(e);
                }
                resolve(links);
            });
    });
}

export class GpuUsageSampler {
    /** @param {string} [proc] procfs root (a fixture in tests) */
    constructor(proc = '/proc') {
        this._proc = proc;
        // pid -> { fds: string[], scanned: µs }
        this._pids = new Map();
    }

    async _gpuFds(pid, now) {
        let entry = this._pids.get(pid);
        if (!entry || now - entry.scanned > RESCAN_US) {
            const links = await listLinks(`${this._proc}/${pid}/fd`);
            entry = { fds: links.filter(([, target]) => target?.startsWith('/dev/dri/')).map(([fd]) => fd), scanned: now };
            if (this._pids.size >= MAX_PIDS) this._pids.clear();
            this._pids.set(pid, entry);
        }
        return entry.fds;
    }

    /**
     * GPU busy time of each unit's processes.
     * @param {Map<string, number[]>} unitPids unit name -> pids (from cgroup.procs)
     * @returns {Promise<Map<string, number>>} unit -> cumulative ns of the GPU clients its processes hold
     */
    async sample(unitPids) {
        const now = GLib.get_monotonic_time();
        const seen = new Set();
        const live = new Set();
        const out = new Map();
        for (const [unit, pids] of unitPids) {
            let ns = 0;
            for (const pid of pids) {
                live.add(pid);
                for (const fd of await this._gpuFds(pid, now)) {
                    let text;
                    try {
                        text = await readFileAsync(`${this._proc}/${pid}/fdinfo/${fd}`);
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
            }
            if (ns > 0) out.set(unit, ns);
        }
        for (const pid of this._pids.keys()) if (!live.has(pid)) this._pids.delete(pid);
        return out;
    }
}
