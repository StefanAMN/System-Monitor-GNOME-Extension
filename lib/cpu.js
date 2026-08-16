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
    }

    async _detectHardware() {
        if (this._hardwareModel) return;
        try {
            const cpuinfo = await readFileAsync('/proc/cpuinfo');
            const lines = cpuinfo.split('\n');
            let model = '';
            let cores = 0;
            let threads = 0;
            for (const line of lines) {
                if (!model && line.startsWith('model name')) {
                    model = line.split(':')[1].trim();
                }
                if (!cores && line.startsWith('cpu cores')) {
                    cores = parseInt(line.split(':')[1].trim(), 10) || 0;
                }
                if (!threads && line.startsWith('siblings')) {
                    threads = parseInt(line.split(':')[1].trim(), 10) || 0;
                }
            }

            // Clean model name
            let cleanModel = model
                .replace(/Intel\(R\)|Core\(TM\)|\(TM\)|\(R\)/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            let gen = '';
            const genMatch = cleanModel.match(/^(\d+(st|nd|rd|th)\s+Gen)\s+(.+)$/i);
            if (genMatch) {
                gen = genMatch[1];
                cleanModel = genMatch[3];
            } else {
                // Try guessing generation for newer chips
                const iMatch = cleanModel.match(/i\d-(\d{2})\d{2}/);
                if (iMatch) {
                    gen = `${iMatch[1]}th Gen`;
                }
            }

            this._hardwareModel = cleanModel || 'Unknown CPU';
            this._cpuGen = gen || 'Processor';
            this._coresCount = cores || 4;
            this._threadsCount = threads || 8;
        } catch (e) {
            this._hardwareModel = 'Unknown CPU';
            this._cpuGen = 'Processor';
            this._coresCount = 4;
            this._threadsCount = 8;
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

    async sample(detailed = false) {
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

            // Average Frequency
            let freqStr = '0.00 GHz';
            try {
                const sysFreq = await readFileAsync('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
                const khz = parseFloat(sysFreq.trim()) || 0;
                if (khz > 0) {
                    freqStr = `${(khz / 1000000).toFixed(2)} GHz`;
                }
            } catch (e) {
                try {
                    const cpuinfo = await readFileAsync('/proc/cpuinfo');
                    const mhzLines = cpuinfo.split('\n').filter(l => l.toLowerCase().startsWith('cpu mhz'));
                    if (mhzLines.length > 0) {
                        let totalMhz = 0;
                        mhzLines.forEach(line => {
                            const val = parseFloat(line.split(':')[1].trim()) || 0;
                            totalMhz += val;
                        });
                        const avgGhz = (totalMhz / mhzLines.length) / 1000;
                        freqStr = `${avgGhz.toFixed(2)} GHz`;
                    }
                } catch (e2) {}
            }

            // Per-core frequencies (sampled in parallel only when detailed is requested)
            let coreFreqs = [];
            if (detailed) {
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

            return {
                total: totalCpu,
                cores: denseCores,
                coreFreqs: coreFreqs,
                loadavg: loadavg,
                uptime: uptime,
                frequency: freqStr,
                hardwareModel: this._hardwareModel,
                cpuGen: this._cpuGen,
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
                cpuGen: this._cpuGen || 'Processor',
                coresCount: this._coresCount || 4,
                threadsCount: this._threadsCount || 8,
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
        if (deltaTotal > 0) {
            percent = (deltaActive / deltaTotal) * 100;
        }

        return {
            total: total,
            active: active,
            percent: Math.max(0, Math.min(100, percent))
        };
    }
}
