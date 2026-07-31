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
        this._raplPaths = null;
        this._lastProbe = 0;
    }

    async _probeRapl() {
        const paths = [];
        const raplPrefixes = ['intel-rapl', 'amd-rapl', 'intel-rapl-mmio'];

        for (const prefix of raplPrefixes) {
            for (let i = 0; i < 4; i++) {
                const baseDir = `/sys/class/powercap/${prefix}:${i}`;
                try {
                    const name = (await readFileAsync(`${baseDir}/name`)).trim();
                    if (name.startsWith('package') || name.startsWith('core')) {
                        await readFileAsync(`${baseDir}/energy_uj`);
                        paths.push({ baseDir, energyPath: `${baseDir}/energy_uj` });
                    }
                } catch (e) {}
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
                            // Handle 32-bit counter overflow (~4.29 GJ / 4,294,967,296 uJ)
                            if (deltaEnergy < 0) {
                                deltaEnergy += 4294967296;
                            }
                            const deltaTime = (now - this._prevTime[item.baseDir]) / 1000000;

                            if (deltaTime > 0 && deltaEnergy >= 0 && deltaEnergy < 500000000) {
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
