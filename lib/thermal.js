import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

async function readFileAsync(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
            try {
                const [, contents] = obj.load_contents_finish(res);
                const decoder = new TextDecoder('utf-8');
                resolve(decoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function listDirAsync(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => {
                try {
                    const enumerator = obj.enumerate_children_finish(res);
                    const files = [];
                    let info;
                    while ((info = enumerator.next_file(null))) {
                        files.push(info.get_name());
                    }
                    resolve(files);
                } catch (e) {
                    resolve([]);
                }
            }
        );
    });
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
                } catch (e) {}

                const files = await listDirAsync(basePath);

                for (const file of files) {
                    if (file.endsWith('_input') && file.startsWith('temp')) {
                        const tempPath = `${basePath}/${file}`;
                        const labelFile = file.replace('_input', '_label');
                        let rawLabel = '';
                        if (files.includes(labelFile)) {
                            try {
                                rawLabel = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                            } catch (e) {}
                        }

                        let finalLabel = rawLabel || chipName;
                        if (chipName === 'acpitz') finalLabel = 'Motherboard';
                        else if (chipName === 'nvme') finalLabel = rawLabel ? `NVMe ${rawLabel}` : 'NVMe Drive';
                        else if (chipName === 'iwlwifi') finalLabel = 'Wi-Fi Adapter';
                        else if (rawLabel.toLowerCase().includes('package id') || rawLabel.toLowerCase() === 'tctl' || rawLabel.toLowerCase() === 'tdie') finalLabel = 'CPU Package';
                        else if (rawLabel.toLowerCase().startsWith('tccd')) finalLabel = `CPU ${rawLabel}`;

                        const isPackage = finalLabel === 'CPU Package' || finalLabel.includes('CPU Tctl') || finalLabel.includes('CPU Tdie');
                        sensors.push({ path: tempPath, label: finalLabel, isPackage });
                    }

                    if (file.endsWith('_input') && file.startsWith('fan')) {
                        const fanPath = `${basePath}/${file}`;
                        const labelFile = file.replace('_input', '_label');
                        let label = '';
                        if (files.includes(labelFile)) {
                            try {
                                label = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                            } catch (e) {}
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
                        } catch (e) {}
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
                if (a.label === 'CPU Package') return -1;
                if (b.label === 'CPU Package') return 1;
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

    async sample() {
        try {
            const now = GLib.get_monotonic_time();
            // Discover on startup or refresh every 60 seconds
            if (!this._discoveredSensors || (now - this._lastDiscovery) > 60000000) {
                await this._discover();
            }

            let packageTemp = 0;
            let maxTemp = 0;
            const validSensors = [];
            const validFans = [];

            // Sample temperature sensors in parallel
            const tempPromises = this._discoveredSensors.map(async (s) => {
                try {
                    const tempStr = await readFileAsync(s.path);
                    const tempVal = parseFloat(tempStr.trim()) / 1000;
                    if (tempVal > 0 && tempVal < 150) {
                        return { label: s.label, temp: tempVal, isPackage: s.isPackage };
                    }
                } catch (e) {}
                return null;
            });

            // Sample fans in parallel
            const fanPromises = this._discoveredFans.map(async (f) => {
                try {
                    const rpmStr = await readFileAsync(f.path);
                    const rpmVal = parseInt(rpmStr.trim(), 10) || 0;
                    if (rpmVal >= 0) {
                        return { label: f.label, rpm: rpmVal };
                    }
                } catch (e) {}
                return null;
            });

            const [tempResults, fanResults] = await Promise.all([
                Promise.all(tempPromises),
                Promise.all(fanPromises)
            ]);

            for (const res of tempResults) {
                if (res) {
                    validSensors.push({ label: res.label, temp: res.temp });
                    if (res.isPackage && packageTemp === 0) {
                        packageTemp = res.temp;
                    }
                    if (res.temp > maxTemp) {
                        maxTemp = res.temp;
                    }
                }
            }

            for (const res of fanResults) {
                if (res) {
                    validFans.push(res);
                }
            }

            if (packageTemp === 0 && maxTemp > 0) {
                packageTemp = maxTemp;
            }

            return {
                packageTemp: packageTemp,
                sensors: validSensors,
                fans: validFans
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
