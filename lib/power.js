import GLib from 'gi://GLib';
import { readFileAsync } from './utils.js';

export class PowerSampler {
    constructor() {
        this._prevEnergy = {};
        this._prevTime = {};
        this._raplPaths = null;
        this._lastProbe = 0;
    }

    async _probeRapl() {
        const paths = [];
        const seenPackages = new Set();
        // Priority order: prefer standard MSR interface 'intel-rapl' / 'amd-rapl', then 'intel-rapl-mmio'
        const raplPrefixes = ['intel-rapl', 'amd-rapl', 'intel-rapl-mmio'];

        for (const prefix of raplPrefixes) {
            for (let i = 0; i < 8; i++) {
                const baseDir = `/sys/class/powercap/${prefix}:${i}`;
                try {
                    const name = (await readFileAsync(`${baseDir}/name`)).trim();
                    // Top-level package energy includes cores, uncore, and DRAM
                    if (name.startsWith('package')) {
                        if (!seenPackages.has(name)) {
                            seenPackages.add(name);
                            await readFileAsync(`${baseDir}/energy_uj`);
                            let maxRange = 0;
                            try {
                                const maxRangeStr = await readFileAsync(`${baseDir}/max_energy_range_uj`);
                                maxRange = parseFloat(maxRangeStr.trim()) || 0;
                            } catch (_) {}
                            paths.push({
                                baseDir,
                                name,
                                energyPath: `${baseDir}/energy_uj`,
                                maxRange: maxRange > 0 ? maxRange : 4294967296
                            });
                        }
                    }
                } catch (e) {}
            }
        }

        // Fallback: If no 'package' zones were found, probe for 'core' zones
        if (paths.length === 0) {
            for (const prefix of raplPrefixes) {
                for (let i = 0; i < 8; i++) {
                    const baseDir = `/sys/class/powercap/${prefix}:${i}`;
                    try {
                        const name = (await readFileAsync(`${baseDir}/name`)).trim();
                        if (name.startsWith('core')) {
                            await readFileAsync(`${baseDir}/energy_uj`);
                            let maxRange = 0;
                            try {
                                const maxRangeStr = await readFileAsync(`${baseDir}/max_energy_range_uj`);
                                maxRange = parseFloat(maxRangeStr.trim()) || 0;
                            } catch (_) {}
                            paths.push({
                                baseDir,
                                name,
                                energyPath: `${baseDir}/energy_uj`,
                                maxRange: maxRange > 0 ? maxRange : 4294967296
                            });
                        }
                    } catch (e) {}
                }
            }
        }

        this._raplPaths = paths;
        this._lastProbe = GLib.get_monotonic_time();
    }

    async sample(batteryData = null) {
        let systemPower = null;
        if (batteryData && batteryData.present && batteryData.energyRate > 0) {
            systemPower = batteryData.energyRate;
        }

        let packagePower = 0;
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
                            let deltaEnergy = energy - this._prevEnergy[item.baseDir];
                            // Handle counter overflow using dynamically detected max_energy_range_uj
                            if (deltaEnergy < 0) {
                                deltaEnergy += item.maxRange;
                            }
                            const deltaTime = (now - this._prevTime[item.baseDir]) / 1000000;

                            // Sanity check: allow up to 1000W per package over elapsed interval
                            const maxPlausibleEnergyDelta = 1000 * deltaTime * 1000000;
                            if (deltaTime > 0 && deltaEnergy >= 0 && deltaEnergy <= maxPlausibleEnergyDelta) {
                                packagePower += deltaEnergy / (deltaTime * 1000000);
                            }
                        }

                        this._prevEnergy[item.baseDir] = energy;
                        this._prevTime[item.baseDir] = now;
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error(`RAPL power sample failed: ${e.message}`);
        }

        return {
            raplSupported: raplSupported,
            packagePower: raplSupported ? packagePower : null,
            systemPower: systemPower
        };
    }
}
