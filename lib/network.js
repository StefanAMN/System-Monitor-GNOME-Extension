import GLib from 'gi://GLib';
import { readFileAsync } from './utils.js';

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

            if (this._sessionRx === undefined) {
                this._sessionRx = 0;
                this._sessionTx = 0;
            }

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
                        const deltaRx = Math.max(0, rxBytes - prev.rxBytes);
                        const deltaTx = Math.max(0, txBytes - prev.txBytes);
                        rxRate = deltaRx / deltaTime;
                        txRate = deltaTx / deltaTime;

                        const isVirtual = /^(docker|veth|br-|virbr|lxc)/.test(iface);
                        if (!isVirtual) {
                            this._sessionRx += deltaRx;
                            this._sessionTx += deltaTx;
                        }
                    }

                    this._prevStats[iface] = { rxBytes, txBytes };

                    interfaces[iface] = {
                        rxRate: rxRate,
                        txRate: txRate,
                        rxBytes: rxBytes,
                        txBytes: txBytes,
                        rxErrors: rxErrors,
                        rxDrops: rxDrops,
                        txErrors: txErrors,
                        txDrops: txDrops
                    };

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
                sessionRx: this._sessionRx,
                sessionTx: this._sessionTx,
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
