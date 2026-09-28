import GLib from 'gi://GLib';
import { readFileAsync, existsAsync, logOnce } from '../common/utils.js';

const VIRTUAL_IFACE_REGEX = /^(docker|veth|br-|virbr|lxc|tailscale|wg|tun|tap|bond|zt|vlan)/;

/**
 * Parse /proc/net/dev. Loopback is skipped; malformed lines are ignored.
 * @param {string} content
 * @returns {{iface: string, rxBytes: number, rxErrors: number, rxDrops: number,
 *            txBytes: number, txErrors: number, txDrops: number}[]}
 */
export function parseNetDev(content) {
    const out = [];
    for (const line of content.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0 || line.includes('Inter-|')) continue;
        const iface = line.slice(0, colon).trim();
        if (!iface || iface === 'lo') continue;
        const stats = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (stats.length < 12 || stats.some(Number.isNaN)) continue;
        out.push({
            iface,
            rxBytes: stats[0], rxErrors: stats[2], rxDrops: stats[3],
            txBytes: stats[8], txErrors: stats[10], txDrops: stats[11]
        });
    }
    return out;
}

/**
 * Bytes transferred between two readings of a cumulative counter. A counter
 * that went backwards (driver reload, interface re-created, 32-bit wrap)
 * yields 0 for that interval rather than a negative or huge value.
 */
export function counterDelta(cur, prev) {
    return cur >= prev ? cur - prev : 0;
}

export class NetworkSampler {
    constructor() {
        this._prevStats = new Map(); // iface -> { rxBytes, txBytes, seen }
        this._prevTime = 0;
        this._isVirtualCache = new Map();
        this._seq = 0;
        this._sessionRx = 0;
        this._sessionTx = 0;
        // Counters saved before a disable: what moved meanwhile is counted
        // into the session totals at the first sample (restoreSession).
        this._carried = null;
    }

    /** The session totals and the counters they stopped at, for sessiontotals.js. */
    sessionTotals() {
        const counters = [];
        for (const [iface, prev] of this._prevStats) {
            if (this._isVirtualCache.get(iface) === false) counters.push({ iface, rxBytes: prev.rxBytes, txBytes: prev.txBytes });
        }
        return { rx: this._sessionRx, tx: this._sessionTx, counters };
    }

    /** Take back the totals of this session from before a disable (the screen lock). */
    restoreSession({ rx, tx, counters }) {
        this._sessionRx += rx;
        this._sessionTx += tx;
        this._carried = new Map(counters.map(c => [c.iface, c]));
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
            const now = GLib.get_monotonic_time();
            const deltaTime = this._prevTime > 0 ? (now - this._prevTime) / 1000000 : 0;

            const interfaces = {};
            let totalRxRate = 0;
            let totalTxRate = 0;

            const seq = ++this._seq;

            for (const { iface, rxBytes, rxErrors, rxDrops, txBytes, txErrors, txDrops } of parseNetDev(content)) {
                let rxRate = 0;
                let txRate = 0;

                const isVirtual = await this._checkIsVirtual(iface);

                const prev = this._prevStats.get(iface);
                const carried = !prev && !isVirtual ? this._carried?.get(iface) : null;
                if (carried) {
                    // Traffic while the extension was disabled (the screen lock).
                    this._sessionRx += counterDelta(rxBytes, carried.rxBytes);
                    this._sessionTx += counterDelta(txBytes, carried.txBytes);
                }
                if (prev && deltaTime > 0) {
                    const deltaRx = counterDelta(rxBytes, prev.rxBytes);
                    const deltaTx = counterDelta(txBytes, prev.txBytes);
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

                interfaces[iface] = { rxRate, txRate, rxBytes, txBytes, rxErrors, rxDrops, txErrors, txDrops, isVirtual };

                if (!isVirtual) {
                    totalRxRate += rxRate;
                    totalTxRate += txRate;
                }
            }

            this._carried = null;
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
            logOnce(`Error in Network sample: ${e.message}`, 'error');
            return {
                interfaces: {},
                sessionRx: this._sessionRx,
                sessionTx: this._sessionTx,
                total: { rxRate: 0, txRate: 0 }
            };
        }
    }
}
