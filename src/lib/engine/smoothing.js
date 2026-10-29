// Display smoothing. Engine layer, pure: the panel shows values that glide
// from one reading to the next over one polling interval, and the noisiest
// readings are averaged over 10 s first. Alerts, history and the battery
// tracker keep using the raw readings; only what is drawn goes through here.

// What is shown for the noisy readings: their average over the last 10 s. A
// 2 s reading of CPU power really does swing from 6 to 8 W and back, as bursts
// of work fall into one window or the next; numbers that do so read as noise.
// The rates come from running totals, so this is the true figure over 10 s.
export const DISPLAY_WINDOW_US = 10e6;
// Kept per value. The shortest interval, 0.25 s, needs 40 in the window.
const WINDOW_READINGS = 48;

/** A value's readings over the window, each weighted by the time it covers. */
class WindowMean {
    constructor() {
        this._end = new Float64Array(WINDOW_READINGS);
        this._covers = new Float64Array(WINDOW_READINGS);
        this._value = new Float64Array(WINDOW_READINGS);
        this._next = 0;
        this._count = 0;
        this._last = NaN;
    }

    add(value, now) {
        const newest = (this._next + WINDOW_READINGS - 1) % WINDOW_READINGS;
        this._end[this._next] = now;
        // The first reading covers no time: it has no baseline (a rate reads 0).
        this._covers[this._next] = this._count > 0 ? now - this._end[newest] : 0;
        this._value[this._next] = value;
        this._next = (this._next + 1) % WINDOW_READINGS;
        if (this._count < WINDOW_READINGS) this._count++;
        this._last = value;
    }

    /** The average over the window; with nothing in it, the last reading. */
    mean(now) {
        const from = now - DISPLAY_WINDOW_US;
        let sum = 0;
        let weight = 0;
        for (let back = 1; back <= this._count; back++) {
            const i = (this._next + WINDOW_READINGS - back) % WINDOW_READINGS;
            if (this._end[i] <= from) break;
            const part = this._end[i] - Math.max(this._end[i] - this._covers[i], from);
            sum += this._value[i] * part;
            weight += part;
        }
        return weight > 0 ? sum / weight : this._last;
    }
}

/**
 * The readings to display for CPU, GPU, power, network and disk: each its
 * average over DISPLAY_WINDOW_US. Memory, battery, temperature and everything
 * else pass through unchanged. Only what changes is copied; the raw reading is
 * never modified, and a part of it repeated from the last poll (not read this
 * time) is not counted twice. Fixed memory per value shown.
 */
export class DisplayAverage {
    constructor() {
        this._values = new Map();
        this._interfaces = new Map();
        this._raw = {};
    }

    /** A number's average; anything else (no reading) as it is, and the value starts anew. */
    _mean(values, key, value, fresh, now) {
        if (!Number.isFinite(value)) {
            values.delete(key);
            return value;
        }
        let series = values.get(key);
        if (!series) values.set(key, series = new WindowMean());
        if (fresh) series.add(value, now);
        return series.mean(now);
    }

    /**
     * @param {object} data the new raw reading
     * @param {number} now monotonic µs
     * @returns {object} the reading to display
     */
    add(data, now) {
        const out = { ...data };
        const v = this._values;
        const raw = this._raw;
        if (data.cpu) {
            const fresh = data.cpu !== raw.cpu;
            out.cpu = { ...data.cpu, total: this._mean(v, 'cpu', data.cpu.total, fresh, now) };
            if (Array.isArray(data.cpu.cores))
                out.cpu.cores = data.cpu.cores.map((value, i) => this._mean(v, `core${i}`, value, fresh, now));
        }
        if (data.gpu?.present) {
            // Per card: the one shown can change, and the GPU page shows them all.
            const fresh = data.gpu !== raw.gpu;
            const key = data.gpu.key ?? '';
            const averaged = (g, add) => ({
                ...g,
                percent: this._mean(v, `gpu${g.key ?? ''}`, g.percent, add, now),
                powerDraw: this._mean(v, `gpuPower${g.key ?? ''}`, g.powerDraw, add, now),
            });
            const gpus = data.gpu.gpus?.map(g => averaged(g, fresh));
            // The one shown is one of those: its reading counts once.
            out.gpu = averaged(data.gpu, fresh && !gpus?.some(g => g.key === key));
            if (gpus) out.gpu.gpus = gpus;
        }
        if (data.pwr) {
            const fresh = data.pwr !== raw.pwr;
            out.pwr = {
                ...data.pwr,
                packagePower: this._mean(v, 'package', data.pwr.packagePower, fresh, now),
                systemPower: this._mean(v, 'system', data.pwr.systemPower, fresh, now),
            };
        }
        if (data.dsk) {
            const fresh = data.dsk !== raw.dsk;
            out.dsk = {
                ...data.dsk,
                readRate: this._mean(v, 'read', data.dsk.readRate, fresh, now),
                writeRate: this._mean(v, 'write', data.dsk.writeRate, fresh, now),
                diskPercent: this._mean(v, 'busy', data.dsk.diskPercent, fresh, now),
            };
        }
        if (data.net?.total) {
            const fresh = data.net !== raw.net;
            const interfaces = {};
            for (const [name, iface] of Object.entries(data.net.interfaces ?? {})) {
                let own = this._interfaces.get(name);
                if (!own) this._interfaces.set(name, own = new Map());
                interfaces[name] = {
                    ...iface,
                    rxRate: this._mean(own, 'rx', iface.rxRate, fresh, now),
                    txRate: this._mean(own, 'tx', iface.txRate, fresh, now),
                };
            }
            // Interfaces come and go (containers, VPNs).
            for (const name of this._interfaces.keys()) if (!(name in interfaces)) this._interfaces.delete(name);
            out.net = {
                ...data.net,
                interfaces,
                total: {
                    ...data.net.total,
                    rxRate: this._mean(v, 'rx', data.net.total.rxRate, fresh, now),
                    txRate: this._mean(v, 'tx', data.net.total.txRate, fresh, now),
                },
            };
        }
        this._raw = data;
        return out;
    }
}

// Numeric fields that glide. Anything else (names, counts, identifiers, load
// averages printed as they are, process lists) switches at once: blending
// those would show long decimals or mix two different processes.
const GLIDE = new Set([
    'total', 'cores', 'percent', 'used', 'available', 'swapPercent',
    'energyRate', 'packagePower', 'systemPower', 'gpuPower', 'powerDraw',
    'readRate', 'writeRate', 'diskPercent', 'rxRate', 'txRate',
    'packageTemp', 'temp', 'clock', 'power', 'memUsed',
]);
// Never descended into: their entries are not the same thing from one
// reading to the next.
const OPAQUE = new Set(['processes']);

// Objects and arrays this module created for a buffer. Only these are ever
// written into: a buffer can also hold references to a reading's own
// objects (fields taken as they are), and those must stay untouched, since
// alerts, history and the averaging read them.
const OWNED = new WeakSet();
const owned = value => {
    OWNED.add(value);
    return value;
};

// `out`, when given, is a previous result to write into: the nested objects
// and arrays it created are reused when they fit, so repeated calls
// allocate nothing new once the shape is stable.
function blend(from, to, t, glide, out) {
    if (typeof to === 'number') {
        return glide && typeof from === 'number' && Number.isFinite(from) && Number.isFinite(to)
            ? from + (to - from) * t : to;
    }
    if (Array.isArray(to)) {
        if (!Array.isArray(from) || from.length !== to.length) return to;
        const arr = Array.isArray(out) && OWNED.has(out) && out.length === to.length ? out : owned(new Array(to.length));
        for (let i = 0; i < to.length; i++) arr[i] = blend(from[i], to[i], t, glide, arr[i]);
        return arr;
    }
    if (to && typeof to === 'object' && Object.getPrototypeOf(to) === Object.prototype) {
        if (!from || typeof from !== 'object') return to;
        const obj = out && !Array.isArray(out) && OWNED.has(out) ? out : owned({});
        for (const key of Object.keys(to)) {
            obj[key] = OPAQUE.has(key) ? to[key] : blend(from[key], to[key], t, glide || GLIDE.has(key), obj[key]);
        }
        // A key the reading no longer has (an interface that went away).
        for (const key in obj) {
            if (!(key in to)) delete obj[key];
        }
        return obj;
    }
    return to;
}

/** An empty buffer for interpolateReading() to write into and reuse. */
export function glideBuffer() {
    return owned({});
}

/**
 * The reading part of the way from `from` to `to` (t from 0 to 1), for the
 * fields in GLIDE; every other field is already `to`'s.
 * @param {object} [out] a buffer from glideBuffer() to write into (reused
 *   across frames); the result is then that buffer, so callers must not
 *   keep it across calls
 */
export function interpolateReading(from, to, t, out = null) {
    if (!from || t >= 1) return to;
    return blend(from, to, Math.max(0, t), false, out);
}
