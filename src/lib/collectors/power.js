import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readFileAsync, noteReadError, logOnce } from '../common/utils.js';

/**
 * Average power between two RAPL energy readings (microjoules).
 * The counter wraps at maxRange; a delta that is still implausible
 * (over 1000 W, or no elapsed time) yields null instead of a spike.
 */
export function raplWatts(prevUj, curUj, maxRange, dtSeconds) {
    if (!(dtSeconds > 0)) return null;
    let delta = curUj - prevUj;
    if (delta < 0) delta += maxRange;
    if (delta < 0 || delta > 1000 * dtSeconds * 1e6) return null;
    return delta / (dtSeconds * 1e6);
}

export class PowerSampler {
    /** @param {string} root the powercap directory (a fixture in tests) */
    constructor(root = '/sys/class/powercap') {
        this._root = root;
        this._prevEnergy = {};
        this._prevTime = {};
        this._raplPaths = null;
        this._uncorePaths = [];
        this._raplBlocked = false;
        this._packageCount = null;
        this._lastProbe = 0;
    }

    /** Probe again on the next sample (after permissions were changed). */
    forgetProbe() {
        this._raplPaths = null;
    }

    async _probeRapl() {
        const paths = [];
        // The package's 'uncore' subzone (Intel: integrated graphics, memory
        // controller, cache), reported separately for GPU attribution.
        const uncore = [];
        // Energy domains whose name could be read; if none of them yields a
        // counter the kernel is withholding energy_uj from this user.
        let domains = 0;
        const seenPackages = new Set();
        // Priority order: prefer standard MSR interface 'intel-rapl' / 'amd-rapl', then 'intel-rapl-mmio'
        const raplPrefixes = ['intel-rapl', 'amd-rapl', 'intel-rapl-mmio'];

        for (const prefix of raplPrefixes) {
            for (let i = 0; i < 8; i++) {
                const baseDir = `${this._root}/${prefix}:${i}`;
                try {
                    const name = (await readFileAsync(`${baseDir}/name`)).trim();
                    // Top-level package energy includes cores, uncore, and DRAM
                    if (name.startsWith('package')) {
                        if (!seenPackages.has(name)) {
                            seenPackages.add(name);
                            domains++;
                            await readFileAsync(`${baseDir}/energy_uj`);
                            let maxRange = 0;
                            try {
                                const maxRangeStr = await readFileAsync(`${baseDir}/max_energy_range_uj`);
                                maxRange = parseFloat(maxRangeStr.trim()) || 0;
                            } catch (_) { noteReadError(_); }
                            paths.push({
                                baseDir,
                                name,
                                energyPath: `${baseDir}/energy_uj`,
                                maxRange: maxRange > 0 ? maxRange : 4294967296
                            });
                            for (let j = 0; j < 8; j++) {
                                const subDir = `${baseDir}:${j}`;
                                try {
                                    if ((await readFileAsync(`${subDir}/name`)).trim() !== 'uncore') continue;
                                    await readFileAsync(`${subDir}/energy_uj`);
                                    let subRange = 0;
                                    try {
                                        subRange = parseFloat((await readFileAsync(`${subDir}/max_energy_range_uj`)).trim()) || 0;
                                    } catch (_) { noteReadError(_); }
                                    uncore.push({ baseDir: subDir, name: 'uncore', energyPath: `${subDir}/energy_uj`, maxRange: subRange > 0 ? subRange : 4294967296 });
                                } catch (e) { noteReadError(e); }
                            }
                        }
                    }
                } catch (e) { noteReadError(e); }
            }
        }

        // Fallback: If no 'package' zones were found, probe for 'core' zones
        if (paths.length === 0) {
            for (const prefix of raplPrefixes) {
                for (let i = 0; i < 8; i++) {
                    const baseDir = `${this._root}/${prefix}:${i}`;
                    try {
                        const name = (await readFileAsync(`${baseDir}/name`)).trim();
                        if (name.startsWith('core')) {
                            domains++;
                            await readFileAsync(`${baseDir}/energy_uj`);
                            let maxRange = 0;
                            try {
                                const maxRangeStr = await readFileAsync(`${baseDir}/max_energy_range_uj`);
                                maxRange = parseFloat(maxRangeStr.trim()) || 0;
                            } catch (_) { noteReadError(_); }
                            paths.push({
                                baseDir,
                                name,
                                energyPath: `${baseDir}/energy_uj`,
                                maxRange: maxRange > 0 ? maxRange : 4294967296
                            });
                        }
                    } catch (e) { noteReadError(e); }
                }
            }
        }

        this._raplPaths = paths;
        this._uncorePaths = uncore;
        this._packageCount = domains;
        this._raplBlocked = paths.length < domains;
        this._lastProbe = GLib.get_monotonic_time();
    }

    async sample(batteryData = null) {
        // The battery's energy rate is whole-system draw only while it is the
        // power source. On AC it is the charge rate (or zero), not consumption.
        let systemPower = null;
        if (batteryData && batteryData.present && batteryData.state === 'discharging' &&
            batteryData.energyRate > 0) {
            systemPower = batteryData.energyRate;
        }

        let packagePower = null;
        let uncorePower = null;
        let raplSupported = false;
        let packageSamples = 0;
        let warmingUp = false;
        let blocked = false;

        // A failed reading breaks the rate interval. Recovery first establishes
        // a new baseline rather than treating a long average as current power.
        const wattsFor = async item => {
            try {
                const text = (await readFileAsync(item.energyPath)).trim();
                const energy = /^\d+$/.test(text) ? Number(text) : NaN;
                if (!Number.isFinite(energy)) throw new Error(`Invalid energy counter: ${item.energyPath}`);
                const time = GLib.get_monotonic_time();
                const before = this._prevEnergy[item.baseDir];
                const watts = before === undefined ? null : raplWatts(before, energy, item.maxRange,
                    (time - this._prevTime[item.baseDir]) / 1000000);
                this._prevEnergy[item.baseDir] = energy;
                this._prevTime[item.baseDir] = time;
                return { watts, warmingUp: before === undefined };
            } catch (e) {
                delete this._prevEnergy[item.baseDir];
                delete this._prevTime[item.baseDir];
                blocked ||= !!(e.matches?.(GLib.FileError, GLib.FileError.ACCES) ||
                    e.matches?.(GLib.FileError, GLib.FileError.PERM) ||
                    e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED));
                noteReadError(e);
                return { watts: null, warmingUp: false };
            }
        };

        try {
            const now = GLib.get_monotonic_time();
            if (!this._raplPaths || (now - this._lastProbe) > 60000000) await this._probeRapl();
            raplSupported = this._raplPaths.length > 0;
            let sum = 0;
            for (const item of this._raplPaths) {
                const result = await wattsFor(item);
                warmingUp ||= result.warmingUp;
                if (result.watts === null) continue;
                sum += result.watts;
                packageSamples++;
            }
            // Summing only the working packages under-reports the machine.
            if (raplSupported && packageSamples === (this._packageCount ?? this._raplPaths.length)) packagePower = sum;
            let uncoreSum = 0;
            let uncoreSamples = 0;
            for (const item of this._uncorePaths) {
                const { watts } = await wattsFor(item);
                if (watts === null) continue;
                uncoreSum += watts;
                uncoreSamples++;
            }
            if (uncoreSamples > 0 && uncoreSamples === this._uncorePaths.length) uncorePower = uncoreSum;
        } catch (e) {
            logOnce(`RAPL power sample failed: ${e.message}`, 'error');
        }

        return {
            raplSupported: raplSupported,
            // Counters exist but this user may not read them (fixable).
            raplBlocked: this._raplBlocked || blocked,
            packagePower,
            warmingUp,
            packagePartial: packageSamples > 0 && packageSamples < (this._packageCount ?? this._raplPaths?.length ?? 0),
            packageSamples,
            packageCount: this._packageCount ?? this._raplPaths?.length ?? 0,
            // Part of packagePower: integrated graphics and the rest of the uncore (Intel).
            uncorePower,
            systemPower: systemPower
        };
    }
}
