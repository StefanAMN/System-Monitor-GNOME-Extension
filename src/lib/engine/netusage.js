// Network data per day, for "today" and "this month" on the Network page.
// Engine layer: turns the kernel's cumulative interface counters into daily
// totals, kept for DAYS_KEPT days in a small JSON file.
//
// The counters are compared with the last ones seen, which are saved with
// the boot id. GNOME disables extensions while the screen is locked, so the
// traffic of a locked night is still counted after unlocking (on the day it
// is noticed), as long as the machine was not restarted in between. A
// counter that went backwards (interface re-created, driver reload) counts
// nothing for that step.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { counterDelta } from '../collectors/network.js';
import { readFileAsync } from '../common/utils.js';

export const DAYS_KEPT = 62;
// Bounded: interfaces come and go (USB tethering, docks).
const MAX_INTERFACES = 32;

export function netUsagePath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'resource-pulse', 'network-usage.json']);
}

export class NetUsage {
    constructor() {
        this.bootId = '';
        // iface -> { rx, tx } as last seen
        this.counters = {};
        // [{ day: 'YYYY-MM-DD', rx, tx }], oldest first, at most DAYS_KEPT
        this.days = [];
    }

    /**
     * @param {{iface: string, rxBytes: number, txBytes: number}[]} interfaces
     *   physical interfaces only (virtual ones would count traffic twice)
     * @param {string} bootId
     * @param {string} day local date, 'YYYY-MM-DD'
     * @returns {boolean} whether anything was added
     */
    ingest(interfaces, bootId, day) {
        const sameBoot = bootId === this.bootId;
        let rx = 0;
        let tx = 0;
        const counters = {};
        for (const { iface, rxBytes, txBytes } of interfaces.slice(0, MAX_INTERFACES)) {
            const prev = sameBoot ? this.counters[iface] : undefined;
            if (prev) {
                rx += counterDelta(rxBytes, prev.rx);
                tx += counterDelta(txBytes, prev.tx);
            }
            counters[iface] = { rx: rxBytes, tx: txBytes };
        }
        this.bootId = bootId;
        this.counters = counters;
        if (rx === 0 && tx === 0) return false;
        let last = this.days.at(-1);
        if (!last || last.day !== day) {
            last = { day, rx: 0, tx: 0 };
            this.days.push(last);
            if (this.days.length > DAYS_KEPT) this.days.splice(0, this.days.length - DAYS_KEPT);
        }
        last.rx += rx;
        last.tx += tx;
        return true;
    }

    /** Totals of one day ('YYYY-MM-DD') or one month ('YYYY-MM'). */
    total(prefix) {
        let rx = 0;
        let tx = 0;
        for (const d of this.days) {
            if (d.day.startsWith(prefix)) {
                rx += d.rx;
                tx += d.tx;
            }
        }
        return { rx, tx };
    }

    toJSON() {
        return { version: 1, bootId: this.bootId, counters: this.counters, days: this.days };
    }

    static fromJSON(text) {
        const data = JSON.parse(text);
        if (data?.version !== 1 || !Array.isArray(data.days)) throw new Error('not a network usage file');
        const usage = new NetUsage();
        usage.bootId = typeof data.bootId === 'string' ? data.bootId : '';
        usage.counters = typeof data.counters === 'object' && data.counters ? data.counters : {};
        usage.days = data.days
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d?.day) && d.rx >= 0 && d.tx >= 0)
            .slice(-DAYS_KEPT);
        return usage;
    }
}

/** The kernel's id of this boot (counters restart with it). @returns {Promise<string>} */
export async function readBootId() {
    try {
        return (await readFileAsync('/proc/sys/kernel/random/boot_id')).trim();
    } catch (e) {
        // Without it every enable starts a new baseline: traffic while
        // disabled is not counted, nothing is counted twice.
        console.warn(`ResourcePulse: cannot read the boot id: ${e.message}`);
        return '';
    }
}

/**
 * @returns {Promise<{usage: NetUsage, problem: ?string}>} a missing file is a
 *   fresh start; a damaged one is moved aside and reported.
 */
export function loadNetUsage(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.load_contents_async(null, (obj, res) => {
            let bytes;
            try {
                [, bytes] = obj.load_contents_finish(res);
            } catch (e) {
                resolve({ usage: new NetUsage(), problem: e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ? null : `cannot read ${path}: ${e.message}` });
                return;
            }
            try {
                resolve({ usage: NetUsage.fromJSON(new TextDecoder().decode(bytes)), problem: null });
            } catch (e) {
                const aside = `${path}.damaged-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
                try {
                    file.move(Gio.File.new_for_path(aside), Gio.FileCopyFlags.NONE, null, null);
                } catch (moveError) {
                    resolve({ usage: new NetUsage(), problem: `${path} is damaged (${e.message}); could not move it aside: ${moveError.message}` });
                    return;
                }
                resolve({ usage: new NetUsage(), problem: `${path} is damaged (${e.message}); kept as ${aside}` });
            }
        });
    });
}

export function saveNetUsage(path, usage) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                reject(e);
                return;
            }
        }
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(usage)));
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (obj, res) => {
            try {
                obj.replace_contents_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}
