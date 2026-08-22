import GLib from 'gi://GLib';
import { readFileAsync, existsAsync } from './utils.js';

const VIRTUAL_IFACE_REGEX = /^(docker|veth|br-|virbr|lxc|tailscale|wg|tun|tap|bond|zt|vlan)/;

export class NetworkSampler {
    constructor() {
        this._prevStats = new Map(); // iface -> { rxBytes, txBytes, seen }
        this._prevTime = 0;
        this._isVirtualCache = new Map();
        this._seq = 0;
        this._sessionRx = 0;
        this._sessionTx = 0;
    }

    async _checkIsVirtual(iface) {
        const cached = this._isVirtualCache.get(iface);
        if (cached !== undefined) return cached;
        // Physical NICs have a backing bus device; everything else is virtual.
        const isVirtual = VIRTUAL_IFACE_REGEX.test(iface) ||
            !(await existsAsync(`/sys/class/net/${iface}/device`));
        this._isVirtualCache.set(iface, isVirtual);
        return isVirtual;
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

            const seq = ++this._seq;

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

                    const isVirtual = await this._checkIsVirtual(iface);

                    const prev = this._prevStats.get(iface);
                    if (prev && deltaTime > 0) {
                        const deltaRx = Math.max(0, rxBytes - prev.rxBytes);
                        const deltaTx = Math.max(0, txBytes - prev.txBytes);
                        rxRate = deltaRx / deltaTime;
                        txRate = deltaTx / deltaTime;

                        if (!isVirtual) {
                            this._sessionRx += deltaRx;
                            this._sessionTx += deltaTx;
                        }
                    }

                    if (prev) {
                        prev.rxBytes = rxBytes;
                        prev.txBytes = txBytes;
                        prev.seen = seq;
                    } else {
                        this._prevStats.set(iface, { rxBytes, txBytes, seen: seq });
                    }

                    interfaces[iface] = {
                        rxRate: rxRate,
                        txRate: txRate,
                        rxBytes: rxBytes,
                        txBytes: txBytes,
                        rxErrors: rxErrors,
                        rxDrops: rxDrops,
                        txErrors: txErrors,
                        txDrops: txDrops,
                        isVirtual: isVirtual
                    };

                    if (!isVirtual) {
                        totalRxRate += rxRate;
                        totalTxRate += txRate;
                    }
                }
            }

            // Interfaces come and go (containers, VPNs); forget the ones that left.
            for (const [iface, prev] of this._prevStats) {
                if (prev.seen !== seq) {
                    this._prevStats.delete(iface);
                    this._isVirtualCache.delete(iface);
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
                sessionRx: this._sessionRx,
                sessionTx: this._sessionTx,
                total: { rxRate: 0, txRate: 0 }
            };
        }
    }
}
