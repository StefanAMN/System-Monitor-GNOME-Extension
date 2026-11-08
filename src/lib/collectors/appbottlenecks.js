// Event-only snapshots of the user's cgroup v2 units. A small batch runs
// at idle priority, outside the system poll's critical path.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { noteReadError, readFileAsync } from '../common/utils.js';
import { AppIoSampler } from './appio.js';
import { describeUnit, listUnits, readCgroupFile, sessionRootFrom, usageUsec } from './appusage.js';
import { parsePressure } from './pressure.js';

const APP_PRESSURE_RESOURCES = ['cpu', 'memory', 'io'];
const BATCH = 8;
const SCOPE_LIMIT = 512;
const PID_LIMIT = 512;

function integer(text) {
    if (text == null || !/^\d+$/.test(text)) return null;
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : null;
}

/** Read plus write bytes across the block devices of a cgroup. */
export function cgroupIoBytes(text) {
    if (text === null) return null;
    let sum = 0;
    for (const line of text.trim().split('\n')) {
        if (!line) continue;
        const r = integer(/\brbytes=(\d+)\b/.exec(line)?.[1]);
        const w = integer(/\bwbytes=(\d+)\b/.exec(line)?.[1]);
        if (r === null || w === null) return null;
        sum += r + w;
    }
    return Number.isSafeInteger(sum) ? sum : null;
}

function identity(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('unix::inode,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            return info.get_attribute_uint64('unix::inode') || null;
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) noteReadError(e);
    }
    return null;
}

function readScope(path, id) {
    const inode = identity(path);
    if (inode === null) return null;
    const cpu = usageUsec(readCgroupFile(`${path}/cpu.stat`) ?? '');
    const memory = integer(readCgroupFile(`${path}/memory.current`)?.trim());
    const io = cgroupIoBytes(readCgroupFile(`${path}/io.stat`));
    const pressure = [];
    for (const key of APP_PRESSURE_RESOURCES) {
        const text = readCgroupFile(`${path}/${key}.pressure`);
        const totals = { some: null };
        pressure.push(text === null ? null : parsePressure(text, totals).some);
        pressure.push(totals.some);
    }
    if (identity(path) !== inode) return null;
    return { path, id, inode, at: GLib.get_monotonic_time(), cpu, memory, io, pressure };
}

export class AppBottleneckSampler {
    constructor({ mount = '/sys/fs/cgroup', session = null, proc = '/proc' } = {}) {
        this._mount = mount;
        this._session = session;
        this._generation = 0;
        this._source = 0;
        this._finish = null;
        this._io = new AppIoSampler(proc);
    }

    cancel() {
        this._generation++;
        this._io.reset();
        if (this._source) GLib.source_remove(this._source);
        this._source = 0;
        this._finish?.(null);
        this._finish = null;
    }

    _idle(work, generation) {
        return new Promise(resolve => {
            this._finish = resolve;
            this._source = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                let complete = false;
                try {
                    if (generation === this._generation) {
                        if (work()) return GLib.SOURCE_CONTINUE;
                        complete = true;
                    }
                } catch (e) {
                    noteReadError(e);
                }
                this._source = 0;
                this._finish = null;
                resolve(complete);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** Start a pair, retaining process I/O baselines only for this measurement. */
    async begin() {
        this.cancel();
        const generation = this._generation;
        if (!this._session) {
            try {
                this._session = sessionRootFrom(await readFileAsync('/proc/self/cgroup'), this._mount);
            } catch (e) {
                noteReadError(e);
            }
        }
        if (!this._session || generation !== this._generation) return null;
        return this._snapshot(generation, null);
    }

    async end(before) {
        if (before.generation !== this._generation) return null;
        return this._snapshot(before.generation, before);
    }

    async _snapshot(generation, before) {
        // Enumeration is also off the polling path when the root is cached.
        let all;
        const listed = await this._idle(() => {
            all = listUnits(this._session).flatMap(([dir, name]) => {
                const unit = describeUnit(name);
                return unit ? [{ path: `${dir}/${name}`, id: unit.id }] : [];
            });
            if (all.length > SCOPE_LIMIT) all.sort((a, b) => a.path.localeCompare(b.path));
            return false;
        }, generation);
        if (!listed || generation !== this._generation) return null;
        const count = Math.min(SCOPE_LIMIT, all.length);
        const units = [];
        const fallback = [];
        const time = GLib.get_monotonic_time();
        let i = 0;
        let remaining = PID_LIMIT;
        const previous = new Map(before?.units.map(unit => [unit.path, unit]));
        const complete = await this._idle(() => {
            for (const stop = Math.min(i + BATCH, count); i < stop; i++) {
                const { path, id } = all[i];
                const scope = readScope(path, id);
                if (!scope) continue;
                units.push(scope);
                if (scope.io !== null || remaining === 0) continue;
                const prior = previous.get(path);
                if (before && (prior?.inode !== scope.inode || !prior.pids)) continue;
                const membership = (readCgroupFile(`${path}/cgroup.procs`) ?? '').trim().split('\n');
                const earlierPids = before ? new Set(prior.pids) : null;
                const pids = [...new Set(membership.map(Number)
                    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && (!earlierPids || earlierPids.has(pid))))]
                    .slice(0, remaining);
                if (identity(path) !== scope.inode) continue;
                scope.pids = pids;
                remaining -= pids.length;
                fallback.push({ unit: path, pids });
            }
            return i < count;
        }, generation);
        if (!complete || generation !== this._generation) return null;
        const io = await this._io.sample(fallback, true);
        if (generation !== this._generation) return null;
        return { generation, total: all.length, time, units, io };
    }
}
