// Machine-wide counters for usage tracking: memory and swap in use, swap
// traffic and the kernel's cumulative stall times (PSI). One reading every
// 30 s from the tracker; cumulative counters, so the ledger takes exact
// deltas whatever the interval was.
//
// HAL layer: plain numbers in bytes and µs; nothing is formatted here.
import { readFileAsync, getSysconf, noteReadError } from '../common/utils.js';

/** The value in kB after `key:` in /proc/meminfo, as bytes; null when absent. */
function meminfoField(text, key) {
    const at = text.indexOf(`\n${key}:`);
    const start = at < 0 ? (text.startsWith(`${key}:`) ? key.length + 1 : -1) : at + key.length + 2;
    if (start < 0) return null;
    const value = parseInt(text.slice(start, text.indexOf('\n', start)), 10);
    return Number.isFinite(value) ? value * 1024 : null;
}

/**
 * @param {string} text /proc/meminfo
 * @returns {{memTotal: ?number, memUsed: ?number, swapTotal: ?number, swapUsed: ?number}} bytes
 */
export function parseMeminfo(text) {
    const memTotal = meminfoField(text, 'MemTotal');
    const available = meminfoField(text, 'MemAvailable');
    const swapTotal = meminfoField(text, 'SwapTotal');
    const swapFree = meminfoField(text, 'SwapFree');
    return {
        memTotal,
        memUsed: memTotal !== null && available !== null ? Math.max(0, memTotal - available) : null,
        swapTotal,
        swapUsed: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
    };
}

/** A counter line `key value` of /proc/vmstat; null when absent. */
function vmstatField(text, key) {
    const at = text.indexOf(`\n${key} `);
    const start = at < 0 ? (text.startsWith(`${key} `) ? key.length + 1 : -1) : at + key.length + 2;
    if (start < 0) return null;
    const value = parseInt(text.slice(start, text.indexOf('\n', start)), 10);
    return Number.isFinite(value) ? value : null;
}

/** @returns {{swapIn: ?number, swapOut: ?number}} pages swapped in and out since boot */
export function parseVmstatSwap(text) {
    return { swapIn: vmstatField(text, 'pswpin'), swapOut: vmstatField(text, 'pswpout') };
}

/**
 * The cumulative stall times of one /proc/pressure file.
 * @returns {{some: ?number, full: ?number}} µs since boot; null for a missing line
 */
export function parsePressureTotals(text) {
    const out = { some: null, full: null };
    // Two short lines: "some avg10=… avg60=… avg300=… total=N".
    for (const line of text.split('\n')) {
        const kind = line.slice(0, 4);
        const at = line.indexOf(' total=');
        if ((kind !== 'some' && kind !== 'full') || at < 0) continue;
        const value = parseInt(line.slice(at + 7), 10);
        if (Number.isFinite(value)) out[kind] = value;
    }
    return out;
}

export class MachineUsageSampler {
    /** @param {object} [paths] for tests: { proc, pressure } */
    constructor({ proc = '/proc', pressure = '/proc/pressure' } = {}) {
        this._proc = proc;
        this._pressure = pressure;
        // A kernel without PSI is not asked again.
        this._noPressure = false;
        this._pageSize = null;
    }

    async _read(path) {
        try {
            return await readFileAsync(path);
        } catch (e) {
            noteReadError(e);
            return null;
        }
    }

    async _readPressure() {
        if (this._noPressure) return null;
        const out = {};
        for (const key of ['cpu', 'memory', 'io']) {
            const text = await this._read(`${this._pressure}/${key}`);
            if (text === null) {
                this._noPressure = true;
                return null;
            }
            out[key] = parsePressureTotals(text);
        }
        return { cpu: out.cpu.some, memory: out.memory.some, memoryFull: out.memory.full, io: out.io.some };
    }

    /**
     * @returns {Promise<{memTotal: ?number, memUsed: ?number, swapTotal: ?number, swapUsed: ?number,
     *   swapInBytes: ?number, swapOutBytes: ?number,
     *   pressure: ?{cpu: ?number, memory: ?number, memoryFull: ?number, io: ?number}}>}
     *   bytes, swap traffic cumulative since boot; pressure in µs since boot,
     *   null when this kernel does not report it
     */
    async sample() {
        this._pageSize ??= (await getSysconf()).pageSize;
        const [meminfo, vmstat, pressure] = await Promise.all([
            this._read(`${this._proc}/meminfo`),
            this._read(`${this._proc}/vmstat`),
            this._readPressure(),
        ]);
        const mem = meminfo !== null ? parseMeminfo(meminfo) : { memTotal: null, memUsed: null, swapTotal: null, swapUsed: null };
        const swap = vmstat !== null ? parseVmstatSwap(vmstat) : { swapIn: null, swapOut: null };
        const bytes = pages => (pages !== null && this._pageSize ? pages * this._pageSize : null);
        return { ...mem, swapInBytes: bytes(swap.swapIn), swapOutBytes: bytes(swap.swapOut), pressure };
    }
}
