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
    }

    async sample() {
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
                        cores.push(stats.percent);
                    }
                }
            }

            // Load average
            let loadavg = [0, 0, 0];
            try {
                const loadContent = await readFileAsync('/proc/loadavg');
                const loadParts = loadContent.trim().split(/\s+/).slice(0, 3).map(Number);
                if (loadParts.length === 3 && !loadParts.some(isNaN)) {
                    loadavg = loadParts;
                }
            } catch (e) {
                console.error(`Failed to read /proc/loadavg: ${e.message}`);
            }

            // Uptime
            let uptime = 0;
            try {
                const uptimeContent = await readFileAsync('/proc/uptime');
                uptime = parseFloat(uptimeContent.trim().split(/\s+/)[0]) || 0;
            } catch (e) {
                console.error(`Failed to read /proc/uptime: ${e.message}`);
            }

            return {
                total: totalCpu,
                cores: cores,
                loadavg: loadavg,
                uptime: uptime
            };
        } catch (e) {
            console.error(`Error in CPU sample: ${e.message}`);
            return {
                total: 0,
                cores: [],
                loadavg: [0, 0, 0],
                uptime: 0
            };
        }
    }

    _calcCpu(parts, prevTotal, prevActive) {
        // parts: user, nice, system, idle, iowait, irq, softirq, steal, guest, guest_nice
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
