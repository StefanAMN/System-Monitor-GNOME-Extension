import { readFileAsync } from './utils.js';

/**
 * Derive display identity from /proc/cpuinfo. Nothing is guessed: unknown
 * fields come back empty / 0 and the UI omits them.
 * @param {string} cpuinfo
 */
export function parseCpuIdentity(cpuinfo) {
    const field = (name) => {
        const m = cpuinfo.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'm'));
        return m ? m[1].trim() : '';
    };
    const raw = field('model name') || field('Model') || field('Hardware');
    const vendorId = field('vendor_id');
    const vendor = /intel/i.test(vendorId) ? 'intel'
        : /amd/i.test(vendorId) ? 'amd' : 'other';

    let model = raw
        .replace(/\((R|TM)\)/gi, '')
        .replace(/\b(Intel|AMD|CPU|Processor)\b/g, '')
        .replace(/@.*$/, '')
        .replace(/\bCore\b\s*(?=i\d|Ultra)/, '')
        .replace(/\s+/g, ' ')
        .trim();

    let gen = '';
    const explicit = model.match(/^(\d+(?:st|nd|rd|th)\s+Gen)\s+(.+)$/i);
    if (explicit) {
        gen = explicit[1];
        model = explicit[2];
    } else {
        // i7-8550U -> 8th, i7-10510U / i5-1135G7 / i7-12700H -> two digits
        const m = model.match(/\bi[3579]-(\d{4,5})/);
        if (m) {
            const n = m[1].length === 5 || m[1][0] === '1' ? parseInt(m[1].slice(0, 2), 10) : parseInt(m[1][0], 10);
            gen = `${n}${ordinalSuffix(n)} Gen`;
        }
    }

    let tier = '';
    const intelTier = raw.match(/\b(i[3579])-\d/) || raw.match(/\bUltra\s+([3579])\b/);
    const ryzenTier = raw.match(/\bRyzen\s+(?:AI\s+)?([3579])\b/i);
    if (ryzenTier) tier = ryzenTier[1];
    else if (intelTier) tier = intelTier[1];

    return {
        model: model || 'Unknown CPU',
        gen,
        vendor,
        tier,
        isRyzen: /ryzen/i.test(raw),
        cores: parseInt(field('cpu cores'), 10) || 0,
        threads: parseInt(field('siblings'), 10) || 0
    };
}

function ordinalSuffix(n) {
    const t = n % 100;
    if (t >= 11 && t <= 13) return 'th';
    return ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
}

export class CpuSampler {
    constructor() {
        this._prevTotal = 0;
        this._prevActive = 0;
        this._prevCores = [];
        this._hardwareModel = '';
        this._cpuGen = '';
        this._coresCount = 0;
        this._threadsCount = 0;
        this._osName = '';
        this._vendor = 'other';
        this._tier = '';
    }

    async _detectHardware() {
        if (this._hardwareModel) return;
        try {
            const cpuinfo = await readFileAsync('/proc/cpuinfo');
            const id = parseCpuIdentity(cpuinfo);
            this._hardwareModel = id.model;
            this._cpuGen = id.gen;
            this._vendor = id.vendor;
            this._tier = id.tier;
            this._coresCount = id.cores;
            this._threadsCount = id.threads;
        } catch (e) {
            console.error(`CPU identity unavailable: ${e.message}`);
            this._hardwareModel = 'Unknown CPU';
        }

        try {
            const osRelease = await readFileAsync('/etc/os-release');
            const lines = osRelease.split('\n');
            for (const line of lines) {
                if (line.startsWith('PRETTY_NAME=')) {
                    this._osName = line.split('=')[1].replace(/\"/g, '').trim();
                    break;
                }
            }
        } catch (e) {
            this._osName = 'Linux OS';
        }
    }

    /**
     * @param {boolean} detailed also return per-core frequencies
     * @param {boolean} wantFreq read the current clock speed. /proc/cpuinfo is
     *   the most expensive file in the sampler (the kernel IPIs every core to
     *   produce it), so it is skipped when nothing displays the result.
     */
    async sample(detailed = false, wantFreq = true) {
        await this._detectHardware();
        try {
            const content = await readFileAsync('/proc/stat');
            const lines = content.split('\n');

            let totalCpu = 0;
            const cores = [];

            for (const line of lines) {
                if (line.startsWith('cpu ')) {
                    const parts = line.trim().split(/\s+/).slice(1).map(Number);
                    const stats = this._calcCpu(parts, this._prevTotal, this._prevActive);
                    this._prevTotal = stats.total;
                    this._prevActive = stats.active;
                    totalCpu = stats.percent;
                } else if (line.startsWith('cpu') && !line.startsWith('cpu ')) {
                    const match = line.match(/^cpu(\d+)\s+(.+)$/);
                    if (match) {
                        const coreId = parseInt(match[1], 10);
                        const parts = match[2].trim().split(/\s+/).map(Number);
                        
                        if (!this._prevCores[coreId]) {
                            this._prevCores[coreId] = { total: 0, active: 0 };
                        }
                        const prev = this._prevCores[coreId];
                        const stats = this._calcCpu(parts, prev.total, prev.active);
                        this._prevCores[coreId] = { total: stats.total, active: stats.active };
                        cores[coreId] = stats.percent;
                    }
                }
            }

            const denseCores = [];
            for (let i = 0; i < cores.length; i++) {
                denseCores.push(cores[i] ?? 0);
            }

            // Load average
            let loadavg = [0, 0, 0];
            try {
                const loadContent = await readFileAsync('/proc/loadavg');
                const loadParts = loadContent.trim().split(/\s+/).slice(0, 3).map(Number);
                if (loadParts.length === 3 && !loadParts.some(isNaN)) {
                    loadavg = loadParts;
                }
            } catch (e) {}

            // Uptime
            let uptime = 0;
            try {
                const uptimeContent = await readFileAsync('/proc/uptime');
                uptime = parseFloat(uptimeContent.trim().split(/\s+/)[0]) || 0;
            } catch (e) {}

            // Average & Per-core Frequency (accurate across all online cores)
            let freqStr = '0.00 GHz';
            let coreFreqs = [];
            if (wantFreq) try {
                const cpuinfo = await readFileAsync('/proc/cpuinfo');
                const mhzLines = cpuinfo.split('\n').filter(l => l.toLowerCase().startsWith('cpu mhz'));
                if (mhzLines.length > 0) {
                    let totalMhz = 0;
                    const parsedMhz = mhzLines.map(line => {
                        const val = parseFloat(line.split(':')[1].trim()) || 0;
                        totalMhz += val;
                        return val;
                    });
                    const avgGhz = (totalMhz / mhzLines.length) / 1000;
                    freqStr = `${avgGhz.toFixed(2)} GHz`;

                    if (detailed) {
                        coreFreqs = parsedMhz.map(mhz => mhz > 0 ? `${(mhz / 1000).toFixed(2)} GHz` : '');
                    }
                }
            } catch (e) {}

            // Fallback for architectures without cpu MHz in /proc/cpuinfo (e.g. some ARM / hypervisors)
            if (wantFreq && freqStr === '0.00 GHz') {
                try {
                    const sysFreq = await readFileAsync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
                    const khz = parseFloat(sysFreq.trim()) || 0;
                    if (khz > 0) {
                        freqStr = `${(khz / 1000000).toFixed(2)} GHz`;
                    }
                } catch (e) {}

                if (detailed && denseCores.length > 0) {
                    const freqPromises = denseCores.map(async (_, i) => {
                        try {
                            const cFreq = await readFileAsync(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
                            const khz = parseFloat(cFreq.trim()) || 0;
                            if (khz > 0) return `${(khz / 1000000).toFixed(2)} GHz`;
                        } catch (e) {}
                        return '';
                    });
                    coreFreqs = await Promise.all(freqPromises);
                }
            }

            return {
                total: totalCpu,
                cores: denseCores,
                coreFreqs: coreFreqs,
                loadavg: loadavg,
                uptime: uptime,
                frequency: wantFreq ? freqStr : null,
                hardwareModel: this._hardwareModel,
                cpuGen: this._cpuGen,
                vendor: this._vendor,
                tier: this._tier,
                coresCount: this._coresCount,
                threadsCount: this._threadsCount,
                osName: this._osName
            };
        } catch (e) {
            console.error(`Error in CPU sample: ${e.message}`);
            return {
                total: 0,
                cores: [],
                loadavg: [0, 0, 0],
                uptime: 0,
                frequency: '0.00 GHz',
                hardwareModel: this._hardwareModel || 'Unknown CPU',
                cpuGen: this._cpuGen,
                vendor: this._vendor,
                tier: this._tier,
                coresCount: this._coresCount,
                threadsCount: this._threadsCount,
                osName: this._osName || 'Linux OS'
            };
        }
    }

    _calcCpu(parts, prevTotal, prevActive) {
        const idle = parts[3] + parts[4];
        const active = parts[0] + parts[1] + parts[2] + parts[5] + parts[6] + parts[7];
        const total = idle + active;

        const deltaTotal = total - prevTotal;
        const deltaActive = active - prevActive;

        let percent = 0;
        if (prevTotal > 0 && deltaTotal > 0) {
            percent = (deltaActive / deltaTotal) * 100;
        }

        return {
            total: total,
            active: active,
            percent: Math.max(0, Math.min(100, percent))
        };
    }
}
