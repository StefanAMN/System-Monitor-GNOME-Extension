import GLib from 'gi://GLib';
import { readFileAsync, listDirAsync, runSubprocess, noteReadError, logOnce } from '../common/utils.js';
import { _ } from '../common/i18n.js';

/**
 * One GPU from a line of `nvidia-smi --query-gpu=name,driver_version,
 * utilization.gpu,utilization.memory,temperature.gpu,memory.used,
 * memory.total,power.draw,clocks.current.graphics,clocks.max.graphics,
 * fan.speed --format=csv,noheader,nounits`. Fields nvidia-smi reports as
 * "[N/A]" / "[Not Supported]" become null.
 * @returns {object|null} null when the line is not usable
 */
function parseNvidiaSmiLine(line) {
    const f = line.split(',').map(x => x.trim());
    if (f.length < 7) return null;
    const num = (i) => {
        const v = parseFloat(f[i]);
        return Number.isFinite(v) ? v : null;
    };
    const memUsed = (num(5) ?? 0) * 1024 * 1024;
    const memTotal = (num(6) ?? 0) * 1024 * 1024;
    return {
        present: true,
        brand: 'NVIDIA',
        model: f[0] || 'NVIDIA GPU',
        driver: `NVIDIA ${f[1] || ''}`.trim(),
        percent: num(2) ?? 0,
        memPercent: num(3) ?? 0,
        memUsed,
        memTotal,
        memFree: Math.max(0, memTotal - memUsed),
        temp: num(4) ?? 0,
        powerDraw: num(7),
        clock: num(8),
        maxClock: num(9),
        fanSpeed: num(10)
    };
}

/** Every GPU in nvidia-smi's output (one line each), in its order. */
export function parseNvidiaSmiAll(stdout) {
    return String(stdout || '').trim().split('\n').map(parseNvidiaSmiLine).filter(Boolean);
}

/** The first GPU in nvidia-smi's output, or null. */
export function parseNvidiaSmi(stdout) {
    return parseNvidiaSmiAll(stdout)[0] ?? null;
}

/**
 * The GPU the top bar and the page's main card show: the busiest one that
 * is awake. The one shown before stays until another is busier by `margin`
 * points, so two GPUs at similar load do not take turns.
 * @param {{key: string, percent: number, asleep?: boolean}[]} gpus
 * @param {?string} previous key of the GPU shown last time
 * @param {number} [margin]
 */
export function pickShownGpu(gpus, previous = null, margin = 10) {
    if (!gpus.length) return null;
    const awake = gpus.filter(g => !g.asleep);
    const pool = awake.length ? awake : gpus;
    let best = pool[0];
    for (const g of pool) {
        if (g.percent > best.percent) best = g;
    }
    const kept = pool.find(g => g.key === previous);
    return kept && best.percent - kept.percent < margin ? kept : best;
}

/** "00:02.0" from a PCI device link target such as "../../../0000:00:02.0". */
export function pciSlot(linkTarget) {
    const m = /([0-9a-f]{4}:)?([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])$/i.exec(String(linkTarget || '').trim());
    return m ? m[2].toLowerCase() : null;
}

/** Display controller names from `lspci` output, by PCI slot ("00:02.0"). */
export function parseLspciGpus(stdout) {
    const names = new Map();
    for (const line of String(stdout || '').split('\n')) {
        const m = /^([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\s+(?:VGA compatible controller|3D controller|Display controller):\s+(.*)$/i.exec(line.trim());
        if (!m) continue;
        const name = m[2].replace(/\(rev [a-f0-9]+\)/gi, '').trim()
            .replace(/^Intel Corporation\s+/i, 'Intel ')
            .replace(/^Advanced Micro Devices, Inc.\s+\[AMD\/ATI\]\s+/i, 'AMD ')
            .replace(/^NVIDIA Corporation\s+/i, 'NVIDIA ');
        if (name) names.set(m[1].toLowerCase(), name);
    }
    return names;
}

/** Current shader clock (MHz) from amdgpu pp_dpm_sclk: the line marked '*'. */
export function parseAmdSclk(text) {
    const m = String(text).match(/(\d+)Mhz\s*\*/i);
    return m ? parseFloat(m[1]) : null;
}

/**
 * Intel GPU busy % from RC6 (sleep) residency growth over elapsed time.
 * null when the interval is too short or the counter went backwards.
 */
export function intelBusyFromRc6(prevMs, curMs, elapsedMs) {
    if (!(elapsedMs > 100) || curMs < prevMs) return null;
    const idle = Math.min(1, Math.max(0, (curMs - prevMs) / elapsedMs));
    return (1 - idle) * 100;
}

// nvidia-smi normally answers in well under a second; it is known to hang
// when the card has dropped off the bus or the driver is mid-reload.
const NVIDIA_SMI_TIMEOUT_MS = 4000;
// The cards are looked for again this often (a dock, a driver loaded late).
const DETECT_EVERY_US = 60e6;

const PCI_VENDOR = { intel: '0x8086', amd: '0x1002', nvidia: '0x10de' };

const NONE = {
    present: false,
    brand: 'None',
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

/** What a GPU that is powered down reads as: nothing was read from it. */
function asleepReading(card) {
    return { ...NONE, present: true, asleep: true, key: card.key, brand: card.brand, model: card.model, driver: card.driver };
}

/**
 * Every GPU: NVIDIA cards through nvidia-smi, AMD and Intel ones through DRM
 * sysfs. A sample is the GPU to show (see pickShownGpu) with `gpus`, every
 * GPU's reading. A card that is runtime-suspended (a hybrid laptop's idle
 * dGPU) is reported asleep without reading it: reading its attributes, or
 * running nvidia-smi, would wake it and cost battery.
 */
export class GpuSampler {
    /** @param {string} [sysRoot] the sysfs root (a fixture in the unit tests) */
    constructor(sysRoot = '/sys') {
        this._sys = sysRoot;
        this._hasNvidiaSmi = null;
        this._nvidiaFailCount = 0;
        this._cards = null; // DRM cards: [{ key, type, brand, model, driver, runtimePath, ...paths }]
        this._nvidiaCards = []; // NVIDIA DRM cards: [{ runtimePath, model }]
        this._lastDetect = 0;
        this._shownKey = null;
        this._smi = {}; // cancel() while nvidia-smi is running
    }

    /** Kill a running nvidia-smi (called from the extension's disable()). */
    destroy() {
        this._smi.cancel?.();
    }

    async _modelNames() {
        if (this._names) return this._names;
        this._names = new Map();
        try {
            if (GLib.find_program_in_path('lspci')) {
                const res = await runSubprocess(['lspci'], { timeoutMs: 5000 });
                if (res.success) this._names = parseLspciGpus(res.stdout);
            }
        } catch (e) { noteReadError(e); }
        return this._names;
    }

    /** True when the device behind `path` (its power/runtime_status) is powered down. */
    async _asleep(path) {
        try {
            return /^suspend/.test((await readFileAsync(path)).trim());
        } catch (e) {
            // No runtime PM: the device is always on.
            noteReadError(e);
            return false;
        }
    }

    _exists(path) {
        return GLib.file_test(path, GLib.FileTest.EXISTS);
    }

    async _detect() {
        const cards = [];
        const nvidia = [];
        try {
            const names = await this._modelNames();
            const drm = `${this._sys}/class/drm`;
            const dirs = (await listDirAsync(drm)).filter(d => /^card\d+$/.test(d))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            for (const dir of dirs) {
                const basePath = `${drm}/${dir}/device`;
                const runtimePath = `${basePath}/power/runtime_status`;
                // Reading vendor (PCI configuration the kernel keeps) and
                // testing for files do not wake a sleeping card.
                let vendor = '';
                try {
                    vendor = (await readFileAsync(`${basePath}/vendor`)).trim();
                } catch (e) { noteReadError(e); }
                let slot = null;
                try {
                    slot = pciSlot(GLib.file_read_link(basePath));
                } catch (e) { noteReadError(e); }
                const name = slot ? names.get(slot) : null;
                let hwmon = null;
                try {
                    const hwmonDirs = await listDirAsync(`${basePath}/hwmon`);
                    if (hwmonDirs.length > 0) hwmon = `${basePath}/hwmon/${hwmonDirs[0]}`;
                } catch (e) { noteReadError(e); }

                if (vendor === PCI_VENDOR.nvidia) {
                    nvidia.push({ runtimePath, model: name || 'NVIDIA GPU' });
                } else if (vendor === PCI_VENDOR.amd || (vendor !== PCI_VENDOR.intel && this._exists(`${basePath}/gpu_busy_percent`))) {
                    cards.push({
                        key: dir, type: 'amd', brand: 'AMD', model: name || 'AMD Radeon Graphics', driver: 'amdgpu', runtimePath,
                        busyPath: `${basePath}/gpu_busy_percent`,
                        vramUsedPath: `${basePath}/mem_info_vram_used`,
                        vramTotalPath: `${basePath}/mem_info_vram_total`,
                        sclkPath: `${basePath}/pp_dpm_sclk`,
                        tempPath: hwmon ? `${hwmon}/temp1_input` : null,
                        pwrPath: hwmon ? `${hwmon}/power1_average` : null,
                        pwrFallbackPath: hwmon ? `${hwmon}/power1_input` : null,
                        fanPath: hwmon ? `${hwmon}/fan1_input` : null,
                    });
                } else if (vendor === PCI_VENDOR.intel) {
                    const cardPath = `${drm}/${dir}`;
                    const freq = [
                        { act: `${cardPath}/gt_act_freq_mhz`, max: `${cardPath}/gt_max_freq_mhz` },
                        { act: `${basePath}/gt/gt0/rps_act_freq_mhz`, max: `${basePath}/gt/gt0/rps_max_freq_mhz` },
                    ].find(p => this._exists(p.act));
                    const rc6Path = [
                        `${cardPath}/gt/gt0/rc6_residency_ms`,
                        `${cardPath}/power/rc6_residency_ms`,
                        `${basePath}/power/rc6_residency_ms`,
                    ].find(p => this._exists(p)) ?? null;
                    cards.push({
                        key: dir, type: 'intel', brand: 'Intel', model: name || 'Intel Graphics', driver: 'i915', runtimePath,
                        busyPath: this._exists(`${basePath}/gpu_busy_percent`) ? `${basePath}/gpu_busy_percent` : null,
                        rc6Path,
                        actFreqPath: freq?.act ?? null,
                        maxFreqPath: freq?.max ?? null,
                        tempPath: hwmon ? `${hwmon}/temp1_input` : null,
                    });
                }
            }
        } catch (e) {
            logOnce(`GPU detection failed: ${e.message}`, 'error');
        }
        this._cards = cards;
        this._nvidiaCards = nvidia;
        this._lastDetect = GLib.get_monotonic_time();
    }

    async _sampleNvidia() {
        if (this._hasNvidiaSmi === null)
            this._hasNvidiaSmi = GLib.find_program_in_path('nvidia-smi') !== null;
        if (this._hasNvidiaSmi === false) {
            // Looked for again now and then (a driver installed meanwhile).
            this._nvidiaFailCount++;
            if (this._nvidiaFailCount % 30 === 0) this._hasNvidiaSmi = null;
            return [];
        }
        // nvidia-smi wakes a powered-down card; while every NVIDIA card
        // sleeps, report them asleep instead of asking.
        const nv = this._nvidiaCards;
        if (nv.length > 0 && (await Promise.all(nv.map(c => this._asleep(c.runtimePath)))).every(Boolean))
            return nv.map((c, i) => asleepReading({ key: `nvidia${i}`, brand: 'NVIDIA', model: c.model, driver: 'nvidia' }));
        const res = await runSubprocess([
            'nvidia-smi',
            '--query-gpu=name,driver_version,utilization.gpu,utilization.memory,temperature.gpu,memory.used,memory.total,power.draw,clocks.current.graphics,clocks.max.graphics,fan.speed',
            '--format=csv,noheader,nounits'
        ], { timeoutMs: NVIDIA_SMI_TIMEOUT_MS, handle: this._smi });
        if (!res.success && res.stderr) logOnce(`GPU sample: ${res.stderr}`);
        const parsed = res.success ? parseNvidiaSmiAll(res.stdout) : [];
        if (parsed.length > 0) {
            this._nvidiaFailCount = 0;
            return parsed.map((gpu, i) => ({ ...gpu, key: `nvidia${i}` }));
        }
        this._nvidiaFailCount++;
        if (this._nvidiaFailCount >= 5) this._hasNvidiaSmi = false;
        return [];
    }

    async _readNumber(path, scale = 1) {
        if (!path) return null;
        try {
            const v = parseFloat((await readFileAsync(path)).trim());
            return Number.isFinite(v) ? v / scale : null;
        } catch (e) {
            noteReadError(e);
            return null;
        }
    }

    async _readAmd(conf) {
        const percent = (await this._readNumber(conf.busyPath)) ?? 0;
        const memUsed = (await this._readNumber(conf.vramUsedPath)) ?? 0;
        const memTotal = (await this._readNumber(conf.vramTotalPath)) ?? 0;
        let clock = null;
        if (conf.sclkPath) {
            try {
                clock = parseAmdSclk(await readFileAsync(conf.sclkPath));
            } catch (e) { noteReadError(e); }
        }
        return {
            present: true,
            key: conf.key,
            brand: conf.brand,
            model: conf.model,
            driver: conf.driver,
            percent,
            memPercent: memTotal > 0 ? (memUsed / memTotal) * 100 : 0,
            memUsed,
            memTotal,
            memFree: Math.max(0, memTotal - memUsed),
            temp: (await this._readNumber(conf.tempPath, 1000)) ?? 0,
            powerDraw: (await this._readNumber(conf.pwrPath, 1e6)) ?? (await this._readNumber(conf.pwrFallbackPath, 1e6)),
            clock,
            maxClock: null,
            fanSpeed: (await this._readNumber(conf.fanPath)) || null,
        };
    }

    async _readIntel(conf) {
        let percent = 0;
        let foundStats = false;
        if (conf.busyPath) {
            const busy = await this._readNumber(conf.busyPath);
            if (busy !== null) {
                percent = busy;
                foundStats = true;
            }
        } else if (conf.rc6Path) {
            const rc6Ms = await this._readNumber(conf.rc6Path);
            const rc6Time = GLib.get_monotonic_time();
            if (rc6Ms !== null) {
                if (conf.prevRc6Ms !== undefined) {
                    const busy = intelBusyFromRc6(conf.prevRc6Ms, rc6Ms, (rc6Time - conf.prevRc6Time) / 1000);
                    if (busy !== null) {
                        percent = busy;
                        foundStats = true;
                    }
                }
                conf.prevRc6Ms = rc6Ms;
                conf.prevRc6Time = rc6Time;
            }
        }
        if (!foundStats && !conf.model) return null;
        return {
            present: true,
            key: conf.key,
            brand: conf.brand,
            model: conf.model,
            driver: conf.driver,
            percent: Math.round(percent),
            memPercent: 0,
            memUsed: 0,
            memTotal: 0,
            memFree: 0,
            temp: (await this._readNumber(conf.tempPath, 1000)) ?? 0,
            powerDraw: null,
            clock: (await this._readNumber(conf.actFreqPath)) || null,
            maxClock: (await this._readNumber(conf.maxFreqPath)) || null,
            fanSpeed: null,
        };
    }

    async sample() {
        const gpus = [];
        try {
            if (!this._cards || GLib.get_monotonic_time() - this._lastDetect > DETECT_EVERY_US) await this._detect();
            gpus.push(...await this._sampleNvidia());
            for (const card of this._cards) {
                const reading = await this._asleep(card.runtimePath)
                    ? asleepReading(card)
                    : card.type === 'amd' ? await this._readAmd(card) : await this._readIntel(card);
                if (reading) gpus.push(reading);
            }
        } catch (e) {
            logOnce(`Error in GPU sample: ${e.message}`, 'error');
        }
        const shown = pickShownGpu(gpus, this._shownKey);
        if (!shown) return { ...NONE, model: _('No Active GPU'), gpus: [] };
        this._shownKey = shown.key;
        return { ...shown, gpus };
    }
}
