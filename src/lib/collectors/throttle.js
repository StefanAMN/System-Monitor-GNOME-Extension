// Thermal throttling: how much of the time the processor was slowed down to
// cool, from the kernel's per-package counter of throttled milliseconds
// (/sys/devices/system/cpu/cpu*/thermal_throttle/package_throttle_total_time_ms,
// Intel processors, Linux 5.18 and later). Readable without privileges.
//
// HAL layer: a percentage of the time between two readings; the alert
// engine decides what is too much. Processors that do not report it (AMD)
// read as null, never as 0.
import GLib from 'gi://GLib';
import { readFileAsync, listDirAsync, noteReadError } from '../common/utils.js';

export class ThrottleSampler {
    /** @param {string} [root] /sys/devices/system/cpu, or a fixture in tests */
    constructor(root = '/sys/devices/system/cpu') {
        this._root = root;
        // One counter file per physical package, found once; null: none here.
        this._files = undefined;
        this._prev = null;
    }

    /** One CPU per physical package that has the counter. */
    async _findFiles() {
        const byPackage = new Map();
        for (const name of await listDirAsync(this._root)) {
            if (!/^cpu\d+$/.test(name)) continue;
            const file = `${this._root}/${name}/thermal_throttle/package_throttle_total_time_ms`;
            if (!GLib.file_test(file, GLib.FileTest.EXISTS)) continue;
            let pkg = '0';
            try {
                pkg = (await readFileAsync(`${this._root}/${name}/topology/physical_package_id`)).trim();
            } catch (e) {
                noteReadError(e);
            }
            if (!byPackage.has(pkg)) byPackage.set(pkg, file);
        }
        return byPackage.size ? [...byPackage.values()] : null;
    }

    /**
     * @returns {Promise<?{percent: number}>} the share of the time since the
     *   previous call the busiest package spent throttled (0-100); null on
     *   the first call and where the processor does not report it
     */
    async sample() {
        if (this._files === undefined) this._files = await this._findFiles();
        if (!this._files) return null;
        const time = GLib.get_monotonic_time();
        const ms = [];
        for (const file of this._files) {
            try {
                ms.push(Number((await readFileAsync(file)).trim()));
            } catch (e) {
                noteReadError(e);
                return null;
            }
        }
        const prev = this._prev;
        this._prev = { time, ms };
        if (!prev) return null;
        const elapsedMs = (time - prev.time) / 1000;
        if (!(elapsedMs > 0)) return null;
        // A counter that went backwards (a CPU taken offline and back) counts 0.
        const shares = ms.map((v, i) => Math.max(0, v - (prev.ms[i] ?? v)) / elapsedMs);
        return { percent: Math.min(100, Math.max(...shares) * 100) };
    }
}
