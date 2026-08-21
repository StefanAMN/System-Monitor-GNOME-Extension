import GLib from 'gi://GLib';
import { readFileAsync, listDirAsync, noteReadError } from './utils.js';

/**
 * Display label for a hwmon temperature input, and whether it is the CPU
 * package / die sensor the top bar should show.
 */
export function sensorLabel(chipName, rawLabel) {
    const lower = rawLabel.toLowerCase();
    let label = rawLabel || chipName;
    if (chipName === 'acpitz') label = 'Motherboard';
    else if (chipName === 'nvme') label = rawLabel ? `NVMe ${rawLabel}` : 'NVMe Drive';
    else if (chipName === 'iwlwifi') label = 'Wi-Fi Adapter';
    else if (lower.includes('package id')) label = 'CPU Package';
    else if (lower === 'tctl') label = 'CPU Package (Tctl)';
    else if (lower === 'tdie') label = 'CPU Die (Tdie)';
    else if (lower.startsWith('tccd')) label = `CPU ${rawLabel}`;
    const isPackage = label === 'CPU Package' || label === 'CPU Package (Tctl)' || label === 'CPU Die (Tdie)';
    return { label, isPackage };
}

/**
 * hwmon / thermal_zone value (millidegrees C) to degrees, or null when it is
 * not a plausible reading (unplugged sensor, error code, garbage).
 */
export function parseMilliCelsius(text) {
    const v = parseFloat(String(text).trim()) / 1000;
    return v > 0 && v < 150 ? v : null;
}

/**
 * The one sensor that stands for "CPU temperature": the package / die
 * sensor, else the first core. Null when the machine has neither, in which
 * case the hottest reading is reported and every sensor has to be read.
 * @param {{label: string, isPackage?: boolean}[]} sensors
 */
export function primarySensor(sensors) {
    return sensors.find(s => s.isPackage) || sensors.find(s => s.label.startsWith('Core')) || null;
}

/**
 * Temperature for the top bar: the primary sensor, else the hottest
 * reading, else 0 (no sensor).
 * @param {{label: string, temp: number, isPackage?: boolean}[]} readings
 */
export function pickPackageTemp(readings) {
    const primary = primarySensor(readings);
    if (primary) return primary.temp;
    return readings.reduce((m, r) => Math.max(m, r.temp), 0);
}

export class ThermalSampler {
    constructor() {
        this._discoveredSensors = null; // Array of { path, label, isPackage }
        this._discoveredFans = null;    // Array of { path, label }
        this._lastDiscovery = 0;
    }

    async _discover() {
        const sensors = [];
        const fans = [];

        try {
            const hwmonDirs = await listDirAsync('/sys/class/hwmon');
            for (const hwmonDir of hwmonDirs) {
                const basePath = `/sys/class/hwmon/${hwmonDir}`;

                let chipName = '';
                try {
                    chipName = (await readFileAsync(`${basePath}/name`)).trim();
                } catch (e) { noteReadError(e); }

                const files = await listDirAsync(basePath);

                for (const file of files) {
                    if (file.endsWith('_input') && file.startsWith('temp')) {
                        const tempPath = `${basePath}/${file}`;
                        const labelFile = file.replace('_input', '_label');
                        let rawLabel = '';
                        if (files.includes(labelFile)) {
                            try {
                                rawLabel = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                            } catch (e) { noteReadError(e); }
                        }

                        const { label: finalLabel, isPackage } = sensorLabel(chipName, rawLabel);
                        sensors.push({ path: tempPath, label: finalLabel, isPackage });
                    }

                    if (file.endsWith('_input') && file.startsWith('fan')) {
                        const fanPath = `${basePath}/${file}`;
                        const labelFile = file.replace('_input', '_label');
                        let label = '';
                        if (files.includes(labelFile)) {
                            try {
                                label = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                            } catch (e) { noteReadError(e); }
                        } else {
                            label = `Fan ${file.replace('fan', '').replace('_input', '')}`;
                        }
                        fans.push({ path: fanPath, label });
                    }
                }
            }

            // Fallback to thermal zones if no temperatures found via hwmon
            if (sensors.length === 0) {
                const thermalDirs = await listDirAsync('/sys/class/thermal');
                for (const tDir of thermalDirs) {
                    if (tDir.startsWith('thermal_zone')) {
                        let type = `Thermal Zone ${tDir.replace('thermal_zone', '')}`;
                        try {
                            type = (await readFileAsync(`/sys/class/thermal/${tDir}/type`)).trim();
                        } catch (e) { noteReadError(e); }
                        sensors.push({
                            path: `/sys/class/thermal/${tDir}/temp`,
                            label: type,
                            isPackage: false
                        });
                    }
                }
            }

            // Sort sensors: CPU Package first, then Cores, then everything else
            sensors.sort((a, b) => {
                if (a.isPackage && !b.isPackage) return -1;
                if (!a.isPackage && b.isPackage) return 1;
                if (a.label.startsWith('Core') && !b.label.startsWith('Core')) return -1;
                if (!a.label.startsWith('Core') && b.label.startsWith('Core')) return 1;
                return a.label.localeCompare(b.label, undefined, { numeric: true });
            });

            this._discoveredSensors = sensors;
            this._discoveredFans = fans;
            this._lastDiscovery = GLib.get_monotonic_time();
        } catch (e) {
            console.error(`Thermal discovery error: ${e.message}`);
            this._discoveredSensors = [];
            this._discoveredFans = [];
        }
    }

    async sample(detailed = true) {
        try {
            const now = GLib.get_monotonic_time();
            // Discover on startup or refresh every 60 seconds
            if (!this._discoveredSensors || (now - this._lastDiscovery) > 60000000) {
                await this._discover();
            }

            if (!this._discoveredSensors || this._discoveredSensors.length === 0) {
                return { packageTemp: 0, sensors: [], fans: [], detailed: true };
            }

            // Fast path for the top bar: read only the primary sensor. Without
            // one the figure is the hottest reading, which needs them all;
            // taking "the first sensor" here made the top bar disagree with
            // the Thermal tab.
            if (!detailed) {
                const pkgSensor = primarySensor(this._discoveredSensors);
                if (pkgSensor) {
                    try {
                        const tempVal = parseMilliCelsius(await readFileAsync(pkgSensor.path));
                        if (tempVal !== null) {
                            // Not the full sensor list: the UI must not render it as one.
                            return {
                                packageTemp: tempVal,
                                sensors: [{ label: pkgSensor.label, temp: tempVal }],
                                fans: [],
                                detailed: false
                            };
                        }
                    } catch (e) { noteReadError(e); }
                }
            }

            const validSensors = [];
            const validFans = [];

            // Sample temperature sensors in parallel
            const tempPromises = this._discoveredSensors.map(async (s) => {
                try {
                    const tempVal = parseMilliCelsius(await readFileAsync(s.path));
                    if (tempVal !== null) {
                        return { label: s.label, temp: tempVal, isPackage: s.isPackage };
                    }
                } catch (e) { noteReadError(e); }
                return null;
            });

            // Sample fans in parallel
            const fanPromises = this._discoveredFans.map(async (f) => {
                try {
                    const fanStr = await readFileAsync(f.path);
                    const rpmVal = parseInt(fanStr.trim(), 10) || 0;
                    if (rpmVal >= 0) {
                        return { label: f.label, rpm: rpmVal };
                    }
                } catch (e) { noteReadError(e); }
                return null;
            });

            const [tempResults, fanResults] = await Promise.all([
                Promise.all(tempPromises),
                Promise.all(fanPromises)
            ]);

            const readings = tempResults.filter(r => r);
            for (const res of readings) validSensors.push({ label: res.label, temp: res.temp });
            for (const res of fanResults) {
                if (res) validFans.push(res);
            }
            const packageTemp = pickPackageTemp(readings);

            return {
                packageTemp: packageTemp,
                sensors: validSensors,
                fans: validFans,
                detailed: true
            };
        } catch (e) {
            console.error(`Error in Thermal sample: ${e.message}`);
            return {
                packageTemp: 0,
                sensors: [],
                fans: []
            };
        }
    }
}
