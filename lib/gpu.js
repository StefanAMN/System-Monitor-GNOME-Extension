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
        this._hasNvidiaSmi = null;
        this._nvidiaFailCount = 0;
        this._drmConfig = null; // Cached { type, ...paths }
        this._lastDrmCheck = 0;
    }

    async _detectDrm() {
        try {
            const drmDirs = await listDirAsync('/sys/class/drm');

            // 1. Check AMD (via sysfs DRM interface)
            for (const dir of drmDirs) {
                if (dir.startsWith('card') && !dir.includes('-')) {
                    const basePath = `/sys/class/drm/${dir}/device`;
                    let busyExists = false;
                    try {
                        await readFileAsync(`${basePath}/gpu_busy_percent`);
                        busyExists = true;
                    } catch (e) {}

                    if (busyExists) {
                        let hwmonPath = null;
                        let tempPath = null;
                        let pwrPath = null;
                        try {
                            const hwmonDirs = await listDirAsync(`${basePath}/hwmon`);
                            if (hwmonDirs.length > 0) {
                                hwmonPath = `${basePath}/hwmon/${hwmonDirs[0]}`;
                                tempPath = `${hwmonPath}/temp1_input`;
                                pwrPath = `${hwmonPath}/power1_average`;
                            }
                        } catch (e) {}

                        this._drmConfig = {
                            type: 'amd',
                            busyPath: `${basePath}/gpu_busy_percent`,
                            vramUsedPath: `${basePath}/mem_info_vram_used`,
                            vramTotalPath: `${basePath}/mem_info_vram_total`,
                            tempPath: tempPath,
                            pwrPath: pwrPath,
                            pwrFallbackPath: hwmonPath ? `${hwmonPath}/power1_input` : null
                        };
                        this._lastDrmCheck = GLib.get_monotonic_time();
                        return;
                    }
                }
            }

            // 2. Check Intel (via sysfs DRM / i915 / Xe interface)
            for (const dir of drmDirs) {
                if (dir.startsWith('card') && !dir.includes('-')) {
                    const basePath = `/sys/class/drm/${dir}/device`;
                    let isIntel = false;
                    try {
                        const vendorStr = await readFileAsync(`${basePath}/vendor`);
                        if (vendorStr.trim() === '0x8086') isIntel = true;
                    } catch (e) {}

                    if (isIntel) {
                        let busyPath = null;
                        try {
                            await readFileAsync(`${basePath}/gpu_busy_percent`);
                            busyPath = `${basePath}/gpu_busy_percent`;
                        } catch (e) {}

                        this._drmConfig = {
                            type: 'intel',
                            busyPath: busyPath,
                            actFreqPath: `${basePath}/gt/gt0/rps_act_freq_mhz`,
                            maxFreqPath: `${basePath}/gt/gt0/rps_max_freq_mhz`
                        };
                        this._lastDrmCheck = GLib.get_monotonic_time();
                        return;
                    }
                }
            }

            this._drmConfig = { type: 'none' };
            this._lastDrmCheck = GLib.get_monotonic_time();
        } catch (e) {
            this._drmConfig = { type: 'none' };
        }
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
                            memUsed: parts[3] * 1024 * 1024,
                            memTotal: parts[4] * 1024 * 1024,
                            powerDraw: !isNaN(parts[5]) ? parts[5] : null
                        };
                    }
                } else {
                    this._nvidiaFailCount++;
                    if (this._nvidiaFailCount >= 10) {
                        this._hasNvidiaSmi = false;
                    }
                }
            } else if (this._hasNvidiaSmi === false) {
                this._nvidiaFailCount++;
                if (this._nvidiaFailCount % 30 === 0) {
                    this._hasNvidiaSmi = null;
                }
            }

            // 2. Sample DRM (AMD or Intel)
            const now = GLib.get_monotonic_time();
            if (!this._drmConfig || (now - this._lastDrmCheck) > 60000000) {
                await this._detectDrm();
            }

            if (this._drmConfig.type === 'amd') {
                const conf = this._drmConfig;
                let percent = 0;
                try {
                    const percentStr = await readFileAsync(conf.busyPath);
                    percent = parseFloat(percentStr.trim()) || 0;
                } catch (e) {}

                let memUsed = 0;
                let memTotal = 0;
                let memPercent = 0;
                try {
                    const usedStr = await readFileAsync(conf.vramUsedPath);
                    memUsed = parseFloat(usedStr.trim()) || 0;
                    const totalStr = await readFileAsync(conf.vramTotalPath);
                    memTotal = parseFloat(totalStr.trim()) || 0;
                    if (memTotal > 0) memPercent = (memUsed / memTotal) * 100;
                } catch (e) {}

                let temp = 0;
                let powerDraw = null;
                if (conf.tempPath) {
                    try {
                        const tempStr = await readFileAsync(conf.tempPath);
                        temp = parseFloat(tempStr.trim()) / 1000;
                    } catch (e) {}
                }
                if (conf.pwrPath) {
                    try {
                        const pwrStr = await readFileAsync(conf.pwrPath);
                        powerDraw = parseFloat(pwrStr.trim()) / 1000000;
                    } catch (e) {
                        if (conf.pwrFallbackPath) {
                            try {
                                const pwrStr2 = await readFileAsync(conf.pwrFallbackPath);
                                powerDraw = parseFloat(pwrStr2.trim()) / 1000000;
                            } catch (e2) {}
                        }
                    }
                }

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

            if (this._drmConfig.type === 'intel') {
                const conf = this._drmConfig;
                let percent = 0;
                let foundStats = false;

                if (conf.busyPath) {
                    try {
                        const pStr = await readFileAsync(conf.busyPath);
                        percent = parseFloat(pStr.trim()) || 0;
                        foundStats = true;
                    } catch (e) {}
                }

                if (!foundStats) {
                    try {
                        const actStr = await readFileAsync(conf.actFreqPath);
                        const maxStr = await readFileAsync(conf.maxFreqPath);
                        const act = parseFloat(actStr.trim()) || 0;
                        const max = parseFloat(maxStr.trim()) || 1;
                        percent = Math.min(100, (act / max) * 100);
                        foundStats = true;
                    } catch (e) {}
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
