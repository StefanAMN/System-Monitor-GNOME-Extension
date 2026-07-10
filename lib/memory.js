import Gio from 'gi://Gio';

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

export class MemorySampler {
    async sample() {
        try {
            const content = await readFileAsync('/proc/meminfo');
            const lines = content.split('\n');

            let memTotal = 0;
            let memAvailable = 0;
            let swapTotal = 0;
            let swapFree = 0;

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const key = parts[0];
                    const val = parseInt(parts[1], 10) * 1024; // Convert kB to Bytes
                    if (key === 'MemTotal:') {
                        memTotal = val;
                    } else if (key === 'MemAvailable:') {
                        memAvailable = val;
                    } else if (key === 'SwapTotal:') {
                        swapTotal = val;
                    } else if (key === 'SwapFree:') {
                        swapFree = val;
                    }
                }
            }

            const memUsed = memTotal - memAvailable;
            const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

            const swapUsed = swapTotal - swapFree;
            const swapPercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

            return {
                total: memTotal,
                used: memUsed,
                percent: Math.max(0, Math.min(100, memPercent)),
                swapTotal: swapTotal,
                swapUsed: swapUsed,
                swapPercent: Math.max(0, Math.min(100, swapPercent))
            };
        } catch (e) {
            console.error(`Error in Memory sample: ${e.message}`);
            return {
                total: 0,
                used: 0,
                percent: 0,
                swapTotal: 0,
                swapUsed: 0,
                swapPercent: 0
            };
        }
    }
}
