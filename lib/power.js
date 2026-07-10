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

export class PowerSampler {
    constructor() {
        this._prevEnergy = {};
        this._prevTime = {};
    }

    async sample(batteryData = null) {
        let systemPower = null;
        if (batteryData && batteryData.present && batteryData.energyRate > 0) {
            systemPower = batteryData.energyRate;
        }

        let packagePower = 0;
        let raplSupported = false;

        try {
            // Check up to 4 RAPL package domains
            for (let i = 0; i < 4; i++) {
                const baseDir = `/sys/class/powercap/intel-rapl:${i}`;
                const nameFile = Gio.File.new_for_path(`${baseDir}/name`);
                const energyFile = Gio.File.new_for_path(`${baseDir}/energy_uj`);

                if (nameFile.query_exists(null) && energyFile.query_exists(null)) {
                    const name = (await readFileAsync(`${baseDir}/name`)).trim();
                    if (name.startsWith('package')) {
                        raplSupported = true;
                        const energyStr = await readFileAsync(`${baseDir}/energy_uj`);
                        const energy = parseFloat(energyStr.trim()) || 0;
                        const now = GLib.get_monotonic_time();

                        if (this._prevEnergy[baseDir] !== undefined) {
                            const deltaEnergy = energy - this._prevEnergy[baseDir];
                            const deltaTime = (now - this._prevTime[baseDir]) / 1000000;

                            if (deltaEnergy >= 0 && deltaTime > 0) {
                                packagePower += deltaEnergy / (deltaTime * 1000000);
                            }
                        }

                        this._prevEnergy[baseDir] = energy;
                        this._prevTime[baseDir] = now;
                    }
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
