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

export class NetworkSampler {
    constructor() {
        this._prevStats = {}; // Map of iface -> { rxBytes, txBytes }
        this._prevTime = 0;
    }

    async sample() {
        try {
            const content = await readFileAsync('/proc/net/dev');
            const lines = content.split('\n');
            const now = GLib.get_monotonic_time();
            const deltaTime = this._prevTime > 0 ? (now - this._prevTime) / 1000000 : 0;

            const interfaces = {};
            let totalRxRate = 0;
            let totalTxRate = 0;

            for (const line of lines) {
                if (!line.includes(':') || line.includes('Inter-|')) continue;
                const parts = line.split(':');
                const iface = parts[0].trim();
                if (iface === 'lo') continue;

                const stats = parts[1].trim().split(/\s+/).map(Number);
                if (stats.length >= 12) {
                    const rxBytes = stats[0];
                    const rxErrors = stats[2];
                    const rxDrops = stats[3];
                    const txBytes = stats[8];
                    const txErrors = stats[10];
                    const txDrops = stats[11];

                    let rxRate = 0;
                    let txRate = 0;

                    if (this._prevStats[iface] && deltaTime > 0) {
                        const prev = this._prevStats[iface];
                        rxRate = Math.max(0, (rxBytes - prev.rxBytes) / deltaTime);
                        txRate = Math.max(0, (txBytes - prev.txBytes) / deltaTime);
                    }

                    this._prevStats[iface] = { rxBytes, txBytes };

                    interfaces[iface] = {
                        rxRate: rxRate,
                        txRate: txRate,
                        rxErrors: rxErrors,
                        rxDrops: rxDrops,
                        txErrors: txErrors,
                        txDrops: txDrops
                    };

                    // Only count interfaces that are active and likely physical (e.g. wlan, eth, enp, wlp)
                    // We sum all interfaces except common virtual ones (like docker, veth)
                    const isVirtual = /^(docker|veth|br-|virbr|lxc)/.test(iface);
                    if (!isVirtual) {
                        totalRxRate += rxRate;
                        totalTxRate += txRate;
                    }
                }
            }

            this._prevTime = now;

            return {
                interfaces: interfaces,
                total: {
                    rxRate: totalRxRate,
                    txRate: totalTxRate
                }
            };
        } catch (e) {
            console.error(`Error in Network sample: ${e.message}`);
            return {
                interfaces: {},
                total: { rxRate: 0, txRate: 0 }
            };
        }
    }
}
