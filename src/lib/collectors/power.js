import GLib from 'gi://GLib';
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
        this._raplBlocked = paths.length === 0 && domains > 0;
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

        let packagePower = 0;
        let uncorePower = null;
        let raplSupported = false;

        try {
            const now = GLib.get_monotonic_time();
            if (!this._raplPaths || (now - this._lastProbe) > 60000000) {
                await this._probeRapl();
            }

            if (this._raplPaths.length > 0) {
                raplSupported = true;
                for (const item of this._raplPaths) {
                    try {
                        const energyStr = await readFileAsync(item.energyPath);
                        const energy = parseFloat(energyStr.trim()) || 0;

                        if (this._prevEnergy[item.baseDir] !== undefined) {
                            const watts = raplWatts(this._prevEnergy[item.baseDir], energy, item.maxRange,
                                (now - this._prevTime[item.baseDir]) / 1000000);
                            if (watts !== null) packagePower += watts;
                        }

                        this._prevEnergy[item.baseDir] = energy;
                        this._prevTime[item.baseDir] = now;
                    } catch (e) { noteReadError(e); }
                }
                for (const item of this._uncorePaths) {
                    try {
                        const energy = parseFloat((await readFileAsync(item.energyPath)).trim()) || 0;
                        if (this._prevEnergy[item.baseDir] !== undefined) {
                            const watts = raplWatts(this._prevEnergy[item.baseDir], energy, item.maxRange,
                                (now - this._prevTime[item.baseDir]) / 1000000);
                            if (watts !== null) uncorePower = (uncorePower ?? 0) + watts;
                        }
                        this._prevEnergy[item.baseDir] = energy;
                        this._prevTime[item.baseDir] = now;
                    } catch (e) { noteReadError(e); }
                }
            }
        } catch (e) {
            logOnce(`RAPL power sample failed: ${e.message}`, 'error');
        }

        return {
            raplSupported: raplSupported,
            // Counters exist but this user may not read them (fixable).
            raplBlocked: this._raplBlocked,
            packagePower: raplSupported ? packagePower : null,
            // Part of packagePower: integrated graphics and the rest of the uncore (Intel).
            uncorePower,
            systemPower: systemPower
        };
    }
}
