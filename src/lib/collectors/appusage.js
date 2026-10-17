// CPU time per app, from the cgroups systemd keeps for the user session.
//
// GNOME starts every app in its own scope (app-gnome-<desktop id>-<pid>.scope,
// app-flatpak-…, snap.…) and the scope's cpu.stat counts the CPU time of
// every process the app ever ran, short-lived ones included, so nothing is
// lost between samples and no process list has to be walked. The files
// belong to the user: no privileges are needed.
//
// The files are read synchronously in batches, one batch of units per idle
// callback, as appio.js and the process list read /proc: cgroupfs lives in
// memory, and a few hundred asynchronous GIO reads cost the shell about 15
// times the CPU (30.8 against 2.0 ms per sample for 73 units, measured by
// tests/bench/tracker_cost.js).
//
// This module only reads and names counters (HAL). Deltas, energy and
// history are the ledger's job (lib/engine/batteryledger.js).
import GLib from 'gi://GLib';
import { readFileAsync, noteReadError } from '../common/utils.js';

// Units read per idle callback: about 0.03 ms each.
const BATCH = 24;
const decoder = new TextDecoder('utf-8', { fatal: false });

/** A cgroup file's text, or null when it is gone (the unit ended) or unreadable. */
function readCgroupFile(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch (e) {
        // ENOENT: the unit ended after it was listed, or a controller is not
        // enabled for it; a normal event, reported once like any other.
        noteReadError(e);
        return null;
    }
}

/** Unit directories under `root`, slices descended into: [dir, name] pairs. */
function listUnits(root) {
    const out = [];
    const pending = [root];
    while (pending.length > 0) {
        const dir = pending.pop();
        let handle;
        try {
            handle = GLib.Dir.open(dir, 0);
        } catch (e) {
            // A slice removed while being walked: normal.
            noteReadError(e);
            continue;
        }
        try {
            for (let name = handle.read_name(); name !== null; name = handle.read_name()) {
                if (name.endsWith('.slice')) pending.push(`${dir}/${name}`);
                else out.push([dir, name]);
            }
        } finally {
            handle.close();
        }
    }
    return out;
}

// Launchers that prefix the application id in app-<launcher>-<id>-<n>.scope.
// A launcher is one word; the id's own dashes are escaped as \x2d.
const UNIT_SUFFIX = /\.(scope|service)$/;

/** Undo systemd unit-name escaping (\xNN). */
export function unescapeUnit(name) {
    return name.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * What a session unit stands for.
 * @param {string} unit directory name, e.g. 'app-gnome-org.gnome.Nautilus-4321.scope'
 * @returns {{id: string, kind: string, label: string}|null} kind is 'app'
 *   (id is a desktop id without '.desktop'), 'snap', 'terminal' or 'service'; null for a slice
 */
export function describeUnit(unit) {
    const match = UNIT_SUFFIX.exec(unit);
    if (!match) return null;
    const base = unit.slice(0, -match[0].length);

    // app[-<launcher>]-<id>-<random>.scope / app[-<launcher>]-<id>[@<random>].service
    if (base.startsWith('app-')) {
        let rest = base.slice(4);
        if (match[1] === 'scope') rest = rest.replace(/-[^-]+$/, '');
        else rest = rest.replace(/@.*$/, '');
        const parts = rest.split('-');
        const id = unescapeUnit(parts.length > 1 ? parts.slice(1).join('-') : parts[0]);
        if (id) return { id, kind: 'app', label: id };
    }

    // snap.<snap>.<app>-<uuid>.scope
    const snap = /^snap\.([^.]+)\./.exec(base);
    if (snap) return { id: `snap.${snap[1]}`, kind: 'snap', label: snap[1] };

    // Terminals give each window or tab a scope of its own.
    // not translated: an internal label; the name shown comes from appnames.js
    if (base.startsWith('vte-spawn-')) return { id: 'terminal', kind: 'terminal', label: 'Terminal' }; // not translated
    const sub = /^([a-z][\w.]*)-\d+(-\d+)?$/.exec(base);
    if (match[1] === 'scope' && sub) return { id: sub[1], kind: 'app', label: sub[1] };

    // Everything else is a session service (dbus, pipewire, the shell…).
    const name = unescapeUnit(base.replace(/@.*$/, ''));
    return { id: name, kind: 'service', label: name };
}

/** The user@<uid>.service directory this process lives under, from /proc/self/cgroup. */
export function sessionRootFrom(selfCgroup, mount = '/sys/fs/cgroup') {
    for (const line of selfCgroup.split('\n')) {
        // cgroup v2: "0::<path>"
        if (!line.startsWith('0::')) continue;
        const m = /^(.*\/user@\d+\.service)(\/|$)/.exec(line.slice(3));
        if (m) return `${mount}${m[1]}`;
    }
    return null;
}

function usageUsec(stat) {
    const m = /^usage_usec (\d+)$/m.exec(stat);
    return m ? Number(m[1]) : null;
}

// An idle unit's memory is read again after this many readings: the kernel
// can take memory back from an app that does not run.
export const IDLE_MEMORY_EVERY = 4;

export class AppUsageSampler {
    /**
     * @param {object} [paths] for tests: { mount, session }
     */
    constructor({ mount = '/sys/fs/cgroup', session = null } = {}) {
        this._mount = mount;
        this._session = session;
        this.available = null;
        // unit -> { usec, pids, memory, age } at the previous reading. A unit
        // whose CPU time did not move started and ended no process, so its
        // process list and (for a few readings) its memory are kept.
        this._cache = new Map();
        this._idleId = 0;
        this._finish = null;
    }

    /** Stop a reading in progress (tracking stopped); its call resolves with no units. */
    cancel() {
        if (this._idleId) GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._finish?.({ time: GLib.get_monotonic_time(), total: null, system: null, units: [] });
        this._finish = null;
    }

    async _sessionRoot() {
        if (this._session) return this._session;
        try {
            this._session = sessionRootFrom(await readFileAsync('/proc/self/cgroup'), this._mount);
        } catch (e) {
            noteReadError(e);
        }
        return this._session;
    }

    _readUsage(path) {
        const text = readCgroupFile(`${path}/cpu.stat`);
        return text === null ? null : usageUsec(text);
    }

    _readMemory(path) {
        const text = readCgroupFile(`${path}/memory.current`);
        const bytes = text === null ? NaN : Number(text.trim());
        return Number.isFinite(bytes) ? bytes : null;
    }

    _readPids(path) {
        return (readCgroupFile(`${path}/cgroup.procs`) ?? '').split('\n').filter(Boolean).map(Number);
    }

    /** One unit's reading, or null for a slice-less name or a counter that cannot be read. */
    _readUnit(dir, name, withPids, withMemory) {
        const what = describeUnit(name);
        if (!what) return null;
        const usec = this._readUsage(`${dir}/${name}`);
        if (usec === null) return null;
        const unit = { unit: name, usec, ...what };
        const before = this._cache.get(name);
        const idle = before?.usec === usec;
        if (withPids) unit.pids = idle && before.pids ? before.pids : this._readPids(`${dir}/${name}`);
        if (withMemory) {
            const fresh = !idle || before.memory === undefined || before.age + 1 >= IDLE_MEMORY_EVERY;
            unit.memory = fresh ? this._readMemory(`${dir}/${name}`) : before.memory;
            unit.memoryAge = fresh ? 0 : before.age + 1;
        }
        return unit;
    }

    /**
     * One reading of every session unit's CPU time.
     * @param {object} [opts]
     * @param {boolean} [opts.withPids] also list each unit's processes (unit.pids), for GPU time
     * @param {boolean} [opts.withMemory] also read each unit's memory in bytes
     *   (unit.memory, null when it cannot be read)
     * @returns {Promise<{time: number, total: ?number, system: ?number,
     *   units: Array<{unit: string, id: string, kind: string, label: string, usec: number}>}>}
     *   time is monotonic µs; total is all CPU time of the machine, system that of
     *   system services; a unit whose counter cannot be read is left out (and the
     *   error is reported once by noteReadError)
     */
    async sample({ withPids = false, withMemory = false } = {}) {
        this.cancel();
        const time = GLib.get_monotonic_time();
        const root = await this._sessionRoot();
        // Slices nest (app.slice/app-gnome\x2dsession\x2dmanager.slice/…);
        // units are the leaves that count.
        const todo = root ? listUnits(root) : [];
        const units = [];
        return new Promise(resolve => {
            this._finish = resolve;
            let i = 0;
            const step = () => {
                for (const end = Math.min(i + BATCH, todo.length); i < end; i++) {
                    const unit = this._readUnit(...todo[i], withPids, withMemory);
                    if (unit) units.push(unit);
                }
                if (i < todo.length) return GLib.SOURCE_CONTINUE;
                this._idleId = 0;
                this._finish = null;
                this._cache = new Map(units.map(u => [u.unit, { usec: u.usec, pids: u.pids, memory: u.memory, age: u.memoryAge ?? 0 }]));
                const total = this._readUsage(this._mount);
                const system = this._readUsage(`${this._mount}/system.slice`);
                this.available = root !== null && total !== null;
                resolve({ time, total, system, units });
                return GLib.SOURCE_REMOVE;
            };
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, step);
        });
    }
}
