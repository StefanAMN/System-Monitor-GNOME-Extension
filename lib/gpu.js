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
        this._cachedModelName = null;
    }

    async _detectModelName() {
        if (this._cachedModelName) return this._cachedModelName;
        try {
            const res = await runSubprocess(['bash', '-c', 'lspci | grep -i -E "vga|3d|display" | head -n 1 | sed -E "s/.*: //"']);
            if (res.success && res.stdout) {
                let name = res.stdout.trim().replace(/\(rev [a-f0-9]+\)/gi, '').trim();
                name = name.replace(/^Intel Corporation\s+/i, 'Intel ')
                           .replace(/^Advanced Micro Devices, Inc.\s+\[AMD\/ATI\]\s+/i, 'AMD ')
                           .replace(/^NVIDIA Corporation\s+/i, 'NVIDIA ');
                this._cachedModelName = name;
                return name;
            }
        } catch (e) {}
        return null;
    }

    async _detectDrm() {
        try {
            const drmDirs = await listDirAsync('/sys/class/drm');
            const modelName = await this._detectModelName();

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
                        let fanPath = null;
                        try {
                            const hwmonDirs = await listDirAsync(`${basePath}/hwmon`);
                            if (hwmonDirs.length > 0) {
                                hwmonPath = `${basePath}/hwmon/${hwmonDirs[0]}`;
                                tempPath = `${hwmonPath}/temp1_input`;
                                pwrPath = `${hwmonPath}/power1_average`;
                                fanPath = `${hwmonPath}/fan1_input`;
                            }
                        } catch (e) {}

                        this._drmConfig = {
                            type: 'amd',
                            model: modelName || 'AMD Radeon Graphics',
                            driver: 'amdgpu',
                            busyPath: `${basePath}/gpu_busy_percent`,
                            vramUsedPath: `${basePath}/mem_info_vram_used`,
                            vramTotalPath: `${basePath}/mem_info_vram_total`,
                            sclkPath: `${basePath}/pp_dpm_sclk`,
                            mclkPath: `${basePath}/pp_dpm_mclk`,
                            tempPath: tempPath,
                            pwrPath: pwrPath,
                            fanPath: fanPath,
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

                        // Try finding gt frequency paths
                        let actFreq = null;
                        let curFreq = null;
                        let maxFreq = null;
                        const cardPath = `/sys/class/drm/${dir}`;
                        const tryPaths = [
                            { act: `${cardPath}/gt_act_freq_mhz`, cur: `${cardPath}/gt_cur_freq_mhz`, max: `${cardPath}/gt_max_freq_mhz` },
                            { act: `${basePath}/gt/gt0/rps_act_freq_mhz`, cur: `${basePath}/gt/gt0/rps_cur_freq_mhz`, max: `${basePath}/gt/gt0/rps_max_freq_mhz` }
                        ];

                        for (const p of tryPaths) {
                            try {
                                await readFileAsync(p.act);
                                actFreq = p.act;
                                curFreq = p.cur;
                                maxFreq = p.max;
                                break;
                            } catch (e) {}
                        }

                        // Try hwmon temp
                        let tempPath = null;
                        try {
                            const hwmonDirs = await listDirAsync(`${basePath}/hwmon`);
                            if (hwmonDirs.length > 0) {
                                tempPath = `${basePath}/hwmon/${hwmonDirs[0]}/temp1_input`;
                            }
                        } catch (e) {}

                        this._drmConfig = {
                            type: 'intel',
                            model: modelName || 'Intel Iris Xe / UHD Graphics',
                            driver: 'i915',
                            busyPath: busyPath,
                            actFreqPath: actFreq,
                            curFreqPath: curFreq,
                            maxFreqPath: maxFreq,
                            tempPath: tempPath
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
                    '--query-gpu=name,driver_version,utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw,clocks.current.graphics,clocks.max.graphics,fan.speed',
                    '--format=csv,noheader,nounits'
                ]);

                if (res.success && res.stdout) {
                    this._hasNvidiaSmi = true;
                    this._nvidiaFailCount = 0;
                    const rawParts = res.stdout.trim().split(',').map(s => s.trim());
                    if (rawParts.length >= 7) {
                        const name = rawParts[0] || 'NVIDIA GPU';
                        const driver = rawParts[1] || 'NVIDIA';
                        const gpuPct = parseFloat(rawParts[2]) || 0;
                        const memPct = parseFloat(rawParts[3]) || 0;
                        const temp = parseFloat(rawParts[4]) || 0;
                        const memUsedMB = parseFloat(rawParts[5]) || 0;
                        const memTotalMB = parseFloat(rawParts[6]) || 0;
                        const powerDraw = parseFloat(rawParts[7]) || null;
                        const clock = parseFloat(rawParts[8]) || null;
                        const maxClock = parseFloat(rawParts[9]) || null;
                        const fanSpeed = parseFloat(rawParts[10]) || null;

                        const memUsedBytes = memUsedMB * 1024 * 1024;
                        const memTotalBytes = memTotalMB * 1024 * 1024;
                        const memFreeBytes = Math.max(0, memTotalBytes - memUsedBytes);

                        return {
                            present: true,
                            brand: 'NVIDIA',
                            model: name,
                            driver: `NVIDIA ${driver}`,
                            percent: gpuPct,
                            memPercent: memPct,
                            memUsed: memUsedBytes,
                            memTotal: memTotalBytes,
                            memFree: memFreeBytes,
                            temp: temp,
                            powerDraw: !isNaN(powerDraw) ? powerDraw : null,
                            clock: clock,
                            maxClock: maxClock,
                            fanSpeed: fanSpeed
                        };
                    }
                } else {
                    this._nvidiaFailCount++;
                    if (this._nvidiaFailCount >= 5) {
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

            if (this._drmConfig && this._drmConfig.type === 'amd') {
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
                let fanSpeed = null;
                if (conf.tempPath) {
                    try {
                        const tempStr = await readFileAsync(conf.tempPath);
                        temp = parseFloat(tempStr.trim()) / 1000;
                    } catch (e) {}
                }
                if (conf.fanPath) {
                    try {
                        const fanStr = await readFileAsync(conf.fanPath);
                        fanSpeed = parseFloat(fanStr.trim()) || null;
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

                // Try reading clock frequency from pp_dpm_sclk
                let clock = null;
                if (conf.sclkPath) {
                    try {
                        const sclkStr = await readFileAsync(conf.sclkPath);
                        const match = sclkStr.match(/(\d+)Mhz\s*\*/i);
                        if (match) clock = parseFloat(match[1]);
                    } catch (e) {}
                }

                return {
                    present: true,
                    brand: 'AMD',
                    model: conf.model || 'AMD Radeon Graphics',
                    driver: conf.driver || 'amdgpu',
                    percent: percent,
                    memPercent: memPercent,
                    memUsed: memUsed,
                    memTotal: memTotal,
                    memFree: Math.max(0, memTotal - memUsed),
                    temp: temp,
                    powerDraw: powerDraw,
                    clock: clock,
                    maxClock: null,
                    fanSpeed: fanSpeed
                };
            }

            if (this._drmConfig && this._drmConfig.type === 'intel') {
                const conf = this._drmConfig;
                let percent = 0;
                let clock = null;
                let maxClock = null;
                let foundStats = false;

                if (conf.busyPath) {
                    try {
                        const pStr = await readFileAsync(conf.busyPath);
                        percent = parseFloat(pStr.trim()) || 0;
                        foundStats = true;
                    } catch (e) {}
                }

                if (conf.actFreqPath) {
                    try {
                        const actStr = await readFileAsync(conf.actFreqPath);
                        clock = parseFloat(actStr.trim()) || 0;
                        if (conf.maxFreqPath) {
                            const maxStr = await readFileAsync(conf.maxFreqPath);
                            maxClock = parseFloat(maxStr.trim()) || 0;
                        }
                        if (!foundStats && maxClock > 0) {
                            percent = Math.min(100, (clock / maxClock) * 100);
                            foundStats = true;
                        }
                    } catch (e) {}
                }

                let temp = 0;
                if (conf.tempPath) {
                    try {
                        const tempStr = await readFileAsync(conf.tempPath);
                        temp = parseFloat(tempStr.trim()) / 1000;
                    } catch (e) {}
                }

                if (foundStats || conf.model) {
                    return {
                        present: true,
                        brand: 'Intel',
                        model: conf.model || 'Intel Graphics',
                        driver: conf.driver || 'i915',
                        percent: Math.round(percent),
                        memPercent: 0,
                        memUsed: 0,
                        memTotal: 0,
                        memFree: 0,
                        temp: temp,
                        powerDraw: null,
                        clock: clock,
                        maxClock: maxClock,
                        fanSpeed: null
                    };
                }
            }
        } catch (e) {
            console.error(`Error in GPU sample: ${e.message}`);
        }

        return {
            present: false,
            brand: 'None',
            model: 'No Active GPU',
            driver: '--',
            percent: 0,
            memPercent: 0,
            temp: 0,
            memUsed: 0,
            memTotal: 0,
            memFree: 0,
            powerDraw: null,
            clock: null,
            maxClock: null,
            fanSpeed: null
        };
    }
}

