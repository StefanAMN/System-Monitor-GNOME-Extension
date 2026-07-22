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

function runSubprocess(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (obj, res) => {
                try {
                    const [, stdout, stderr] = obj.communicate_utf8_finish(res);
                    resolve({ success: true, stdout, stderr });
                } catch (e) {
                    resolve({ success: false, error: e.message });
                }
            });
        } catch (e) {
            resolve({ success: false, error: e.message });
        }
    });
}

export class GpuSampler {
    constructor() {
        this._hasNvidiaSmi = null; // cache availability
        this._nvidiaFailCount = 0;
    }

    async sample() {
        try {
            // 1. Try NVIDIA
            if (this._hasNvidiaSmi === null || this._hasNvidiaSmi === true) {
                const res = await runSubprocess([
                    'nvidia-smi',
                    '--query-gpu=utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw',
                    '--format=csv,noheader,nounits'
                ]);

                if (res.success && res.stdout) {
                    this._hasNvidiaSmi = true;
                    this._nvidiaFailCount = 0;
                    const parts = res.stdout.trim().split(',').map(s => parseFloat(s.trim()));
                    if (parts.length >= 5 && !parts.some(isNaN)) {
                        return {
                            present: true,
                            brand: 'NVIDIA',
                            percent: parts[0],
                            memPercent: parts[1],
                            temp: parts[2],
                            memUsed: parts[3] * 1024 * 1024, // MB to Bytes
                            memTotal: parts[4] * 1024 * 1024,
                            powerDraw: !isNaN(parts[5]) ? parts[5] : null
                        };
                    }
                } else {
                    this._nvidiaFailCount++;
                    // If failed 10 times consecutively, temporarily disable, but retry every 30 samples
                    if (this._nvidiaFailCount >= 10) {
                        this._hasNvidiaSmi = false;
                    }
                }
            } else if (this._hasNvidiaSmi === false) {
                // Soft retry every 30 polls (1 minute) in case dGPU woke up from sleep
                this._nvidiaFailCount++;
                if (this._nvidiaFailCount % 30 === 0) {
                    this._hasNvidiaSmi = null;
                }
            }

            const drmDirs = await listDirAsync('/sys/class/drm');

            // 2. Try AMD (via sysfs DRM interface)
            for (const dir of drmDirs) {
                if (dir.startsWith('card') && !dir.includes('-')) {
                    const basePath = `/sys/class/drm/${dir}/device`;
                    let busyExists = false;
                    try {
                        await readFileAsync(`${basePath}/gpu_busy_percent`);
                        busyExists = true;
                    } catch(e) {}
                    if (busyExists) {
                        const percentStr = await readFileAsync(`${basePath}/gpu_busy_percent`);
                        const percent = parseFloat(percentStr.trim()) || 0;

                        let memUsed = 0;
                        let memTotal = 0;
                        let memPercent = 0;

                        try {
                            const usedStr = await readFileAsync(`${basePath}/mem_info_vram_used`);
                            memUsed = parseFloat(usedStr.trim()) || 0;
                            const totalStr = await readFileAsync(`${basePath}/mem_info_vram_total`);
                            memTotal = parseFloat(totalStr.trim()) || 0;
                            if (memTotal > 0) {
                                memPercent = (memUsed / memTotal) * 100;
                            }
                        } catch (e) {}

                        // Read temperature and power from AMD device hwmon if present
                        let temp = 0;
                        let powerDraw = null;
                        try {
                            const hwmonDirs = await listDirAsync(`${basePath}/hwmon`);
                            if (hwmonDirs.length > 0) {
                                const hwPath = `${basePath}/hwmon/${hwmonDirs[0]}`;
                                try {
                                    const tempStr = await readFileAsync(`${hwPath}/temp1_input`);
                                    temp = parseFloat(tempStr.trim()) / 1000;
                                } catch (eT) {}
                                try {
                                    const pwrStr = await readFileAsync(`${hwPath}/power1_average`);
                                    powerDraw = parseFloat(pwrStr.trim()) / 1000000;
                                } catch (eP) {
                                    try {
                                        const pwrStr2 = await readFileAsync(`${hwPath}/power1_input`);
                                        powerDraw = parseFloat(pwrStr2.trim()) / 1000000;
                                    } catch (eP2) {}
                                }
                            }
                        } catch (e) {}

                        return {
                            present: true,
                            brand: 'AMD',
                            percent: percent,
                            memPercent: memPercent,
                            temp: temp,
                            memUsed: memUsed,
                            memTotal: memTotal,
                            powerDraw: powerDraw
                        };
                    }
                }
            }

            // 3. Try Intel (via sysfs DRM / i915 / Xe interface)
            for (const dir of drmDirs) {
                if (dir.startsWith('card') && !dir.includes('-')) {
                    const basePath = `/sys/class/drm/${dir}/device`;
                    let isIntel = false;
                    try {
                        const vendorStr = await readFileAsync(`${basePath}/vendor`);
                        if (vendorStr.trim() === '0x8086') isIntel = true;
                    } catch (e) {}

                    if (isIntel) {
                        let percent = 0;
                        let foundStats = false;

                        try {
                            const pStr = await readFileAsync(`${basePath}/gpu_busy_percent`);
                            percent = parseFloat(pStr.trim()) || 0;
                            foundStats = true;
                        } catch (e) {
                            try {
                                const actStr = await readFileAsync(`${basePath}/gt/gt0/rps_act_freq_mhz`);
                                const maxStr = await readFileAsync(`${basePath}/gt/gt0/rps_max_freq_mhz`);
                                const act = parseFloat(actStr.trim()) || 0;
                                const max = parseFloat(maxStr.trim()) || 1;
                                percent = Math.min(100, (act / max) * 100);
                                foundStats = true;
                            } catch (e2) {}
                        }

                        if (foundStats) {
                            return {
                                present: true,
                                brand: 'Intel',
                                percent: Math.round(percent),
                                memPercent: 0,
                                temp: 0,
                                memUsed: 0,
                                memTotal: 0
                            };
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`Error in GPU sample: ${e.message}`);
        }

        return {
            present: false,
            percent: 0,
            memPercent: 0,
            temp: 0,
            memUsed: 0,
            memTotal: 0
        };
    }
}
