// CPU time per app, from the cgroups systemd keeps for the user session.
//
// GNOME starts every app in its own scope (app-gnome-<desktop id>-<pid>.scope,
// app-flatpak-…, snap.…) and the scope's cpu.stat counts the CPU time of
// every process the app ever ran, short-lived ones included, so nothing is
// lost between samples and no process list has to be walked. The files
// belong to the user: no privileges are needed.
//
// This module only reads and names counters (HAL). Deltas, energy and
// history are the ledger's job (lib/batteryledger.js).
import GLib from 'gi://GLib';
import { readFileAsync, listDirAsync, noteReadError } from './utils.js';

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
    if (base.startsWith('vte-spawn-')) return { id: 'terminal', kind: 'terminal', label: 'Terminal' };
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

export class AppUsageSampler {
    /**
     * @param {object} [paths] for tests: { mount, session }
     */
    constructor({ mount = '/sys/fs/cgroup', session = null } = {}) {
        this._mount = mount;
        this._session = session;
        this.available = null;
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

    async _readUsage(path) {
        try {
            return usageUsec(await readFileAsync(`${path}/cpu.stat`));
        } catch (e) {
            noteReadError(e);
            return null;
        }
    }

    async _readPids(path) {
        try {
            return (await readFileAsync(`${path}/cgroup.procs`)).split('\n').filter(Boolean).map(Number);
        } catch (e) {
            noteReadError(e);
            return [];
        }
    }

    /**
     * One reading of every session unit's CPU time.
     * @param {object} [opts]
     * @param {boolean} [opts.withPids] also list each unit's processes (unit.pids), for GPU time
     * @returns {Promise<{time: number, total: ?number, system: ?number,
     *   units: Array<{unit: string, id: string, kind: string, label: string, usec: number}>}>}
     *   time is monotonic µs; total is all CPU time of the machine, system that of
     *   system services; a unit whose counter cannot be read is left out (and the
     *   error is reported once by noteReadError)
     */
    async sample({ withPids = false } = {}) {
        const time = GLib.get_monotonic_time();
        const root = await this._sessionRoot();
        const units = [];
        if (root) {
            // Slices nest (app.slice/app-gnome\x2dsession\x2dmanager.slice/…);
            // units are the leaves that count.
            const pending = [root];
            while (pending.length > 0) {
                const dir = pending.pop();
                for (const name of await listDirAsync(dir)) {
                    if (name.endsWith('.slice')) {
                        pending.push(`${dir}/${name}`);
                        continue;
                    }
                    const what = describeUnit(name);
                    if (!what) continue;
                    const usec = await this._readUsage(`${dir}/${name}`);
                    if (usec === null) continue;
                    const unit = { unit: name, usec, ...what };
                    if (withPids) unit.pids = await this._readPids(`${dir}/${name}`);
                    units.push(unit);
                }
            }
        }
        const [total, system] = await Promise.all([
            this._readUsage(this._mount),
            this._readUsage(`${this._mount}/system.slice`),
        ]);
        this.available = root !== null && total !== null;
        return { time, total, system, units };
    }
}
