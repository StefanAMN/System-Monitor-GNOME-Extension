// Pressure stall information (PSI): the share of time in which programs were
// stalled waiting for CPU, memory or disk I/O, from /proc/pressure/*. A
// better sign of a struggling machine than usage percentages: memory can be
// 90 % used by cache without anything waiting, and a full CPU is fine while
// nothing queues behind it. Readable without privileges.
//
// HAL layer: kernel 10-second averages and cumulative stall microseconds.
import { readProcFile, noteReadError } from '../common/utils.js';

const RESOURCES = ['cpu', 'memory', 'io'];

/**
 * The avg10 figures of one /proc/pressure file.
 * @param {string} text
 * @param {object} [totals] receives cumulative stall times from the same read
 * @returns {{some: ?number, full: ?number}} null for a line the file lacks
 *   (the "full" line of cpu exists only since Linux 5.13)
 */
export function parsePressure(text, totals = null) {
    const out = { some: null, full: null };
    for (const line of text.split('\n')) {
        const m = /^(some|full)\s.*\bavg10=([\d.]+)/.exec(line);
        if (!m) continue;
        out[m[1]] = Number(m[2]);
        if (totals) {
            const start = line.indexOf(' total=');
            const value = start >= 0 ? line.slice(start + 7).trim() : '';
            const total = value ? Number(value) : NaN;
            totals[m[1]] = Number.isSafeInteger(total) && total >= 0 ? total : null;
        }
    }
    return out;
}

export class PressureSampler {
    /** @param {string} [root] directory holding cpu, memory and io (a fixture in tests) */
    constructor(root = '/proc/pressure') {
        this._root = root;
        // Once the kernel is known not to report PSI the files are not tried again.
        this._missing = false;
    }

    /**
     * @returns {Promise<?{cpu: object, memory: object, io: object}>} null when
     *   this kernel does not report pressure (built without PSI, or psi=0)
     */
    async sample() {
        if (this._missing) return null;
        const out = { totals: {} };
        for (const key of RESOURCES) {
            try {
                const totals = { some: null, full: null };
                out[key] = parsePressure(readProcFile(`${this._root}/${key}`), totals);
                out.totals[key] = totals;
            } catch (e) {
                // ENOENT: no PSI here, a normal kernel configuration. EOPNOTSUPP
                // (psi=0 on the command line) and anything else are logged once.
                noteReadError(e);
                this._missing = true;
                return null;
            }
        }
        return out;
    }
}
