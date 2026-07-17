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
    async sample() {
        try {
            let packageTemp = 0;
            let maxTemp = 0;
            const sensors = [];
            const fans = [];

            const hwmonDirs = await listDirAsync('/sys/class/hwmon');
            for (const hwmonDir of hwmonDirs) {
                const basePath = `/sys/class/hwmon/${hwmonDir}`;

                let chipName = '';
                try {
                    chipName = (await readFileAsync(`${basePath}/name`)).trim();
                } catch (e) {}

                // List files in the specific hwmon folder
                const files = await listDirAsync(basePath);

                // Find temperatures
                for (const file of files) {
                    if (file.endsWith('_input') && file.startsWith('temp')) {
                        const tempPath = `${basePath}/${file}`;
                        try {
                            const tempStr = await readFileAsync(tempPath);
                            const tempVal = parseFloat(tempStr.trim()) / 1000; // millidegrees to C
                            
                            if (tempVal > 0 && tempVal < 150) {
                                // Try to read label
                                const labelFile = file.replace('_input', '_label');
                                let rawLabel = '';
                                if (files.includes(labelFile)) {
                                    rawLabel = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                                }

                                // Format the label
                                let finalLabel = rawLabel || chipName;
                                
                                if (chipName === 'acpitz') finalLabel = 'Motherboard';
                                else if (chipName === 'nvme') finalLabel = rawLabel ? `NVMe ${rawLabel}` : 'NVMe Drive';
                                else if (chipName === 'iwlwifi') finalLabel = 'Wi-Fi Adapter';
                                else if (rawLabel.toLowerCase().includes('package id')) finalLabel = 'CPU Package';
                                else if (rawLabel.toLowerCase() === 'tctl' || rawLabel.toLowerCase() === 'tdie') finalLabel = `CPU ${rawLabel}`;

                                // Catch the package temp specifically for the sparkline
                                if (finalLabel.includes('CPU Package') || finalLabel === 'CPU Tctl') {
                                    packageTemp = tempVal;
                                }

                                sensors.push({
                                    label: finalLabel,
                                    temp: tempVal
                                });

                                if (tempVal > maxTemp) {
                                    maxTemp = tempVal;
                                }
                            }
                        } catch (e) {}
                    }

                    // Find fans
                    if (file.endsWith('_input') && file.startsWith('fan')) {
                        const fanPath = `${basePath}/${file}`;
                        try {
                            const rpmStr = await readFileAsync(fanPath);
                            const rpmVal = parseInt(rpmStr.trim(), 10) || 0;
                            if (rpmVal >= 0) {
                                const labelFile = file.replace('_input', '_label');
                                let label = '';
                                if (files.includes(labelFile)) {
                                    label = (await readFileAsync(`${basePath}/${labelFile}`)).trim();
                                } else {
                                    label = `Fan ${file.replace('fan', '').replace('_input', '')}`;
                                }
                                fans.push({ label, rpm: rpmVal });
                            }
                        } catch (e) {}
                    }
                }
            }

            // Fallback to thermal zones if no temperatures found via hwmon
            if (sensors.length === 0) {
                const thermalDirs = await listDirAsync('/sys/class/thermal');
                for (const tDir of thermalDirs) {
                    if (tDir.startsWith('thermal_zone')) {
                        try {
                            const tempStr = await readFileAsync(`/sys/class/thermal/${tDir}/temp`);
                            const tempVal = parseFloat(tempStr.trim()) / 1000;
                            if (tempVal > 0 && tempVal < 150) {
                                let type = `Thermal Zone ${tDir.replace('thermal_zone', '')}`;
                                try {
                                    type = (await readFileAsync(`/sys/class/thermal/${tDir}/type`)).trim();
                                } catch (e) {}
                                
                                sensors.push({ label: type, temp: tempVal });
                                if (tempVal > maxTemp) maxTemp = tempVal;
                            }
                        } catch (e) {}
                    }
                }
            }
            
            // If we didn't find an explicit package temp, fallback to maxTemp for the sparkline
            if (packageTemp === 0 && maxTemp > 0) {
                packageTemp = maxTemp;
            }

            // Sort sensors: CPU Package first, then Cores, then everything else
            sensors.sort((a, b) => {
                if (a.label === 'CPU Package') return -1;
                if (b.label === 'CPU Package') return 1;
                if (a.label.startsWith('Core') && !b.label.startsWith('Core')) return -1;
                if (!a.label.startsWith('Core') && b.label.startsWith('Core')) return 1;
                // Alphanumeric for the rest
                return a.label.localeCompare(b.label, undefined, {numeric: true});
            });

            return {
                packageTemp: packageTemp,
                sensors: sensors,
                fans: fans
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
