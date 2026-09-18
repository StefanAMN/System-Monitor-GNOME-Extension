// Display smoothing. Engine layer, pure: the panel shows values that glide
// from one reading to the next over one polling interval, and the noisiest
// readings are lightly smoothed first. Alerts, history and the battery
// tracker keep using the raw readings; only what is drawn goes through here.

// Weight of a new reading for the noisy metrics: a one-reading spike shows
// at half height, a real change is mostly there after two or three readings.
export const SMOOTH_ALPHA = 0.5;

/** Exponential moving average; without a usable previous value, the reading itself. */
export function ema(prev, next, alpha = SMOOTH_ALPHA) {
    if (!Number.isFinite(next)) return next;
    if (!Number.isFinite(prev)) return next;
    return prev + (next - prev) * alpha;
}

/**
 * The reading to display for CPU, GPU, network and disk rates, smoothed
 * against the previous smoothed one. Memory, battery, temperature and
 * everything else pass through unchanged. Only the objects that change are
 * copied; the raw reading is never modified.
 * @param {?object} prev the previous result of this function
 * @param {object} data the new raw reading
 */
export function smoothReading(prev, data, alpha = SMOOTH_ALPHA) {
    if (!prev) return data;
    const out = { ...data };
    if (data.cpu && prev.cpu) {
        out.cpu = { ...data.cpu, total: ema(prev.cpu.total, data.cpu.total, alpha) };
        if (Array.isArray(data.cpu.cores) && prev.cpu.cores?.length === data.cpu.cores.length)
            out.cpu.cores = data.cpu.cores.map((v, i) => ema(prev.cpu.cores[i], v, alpha));
    }
    if (data.gpu?.present && prev.gpu?.present)
        out.gpu = { ...data.gpu, percent: ema(prev.gpu.percent, data.gpu.percent, alpha) };
    if (data.dsk && prev.dsk) {
        out.dsk = {
            ...data.dsk,
            readRate: ema(prev.dsk.readRate, data.dsk.readRate, alpha),
            writeRate: ema(prev.dsk.writeRate, data.dsk.writeRate, alpha),
            diskPercent: ema(prev.dsk.diskPercent, data.dsk.diskPercent, alpha),
        };
    }
    if (data.net?.total && prev.net?.total) {
        const interfaces = {};
        for (const [name, iface] of Object.entries(data.net.interfaces ?? {})) {
            const p = prev.net.interfaces?.[name];
            interfaces[name] = p
                ? { ...iface, rxRate: ema(p.rxRate, iface.rxRate, alpha), txRate: ema(p.txRate, iface.txRate, alpha) }
                : iface;
        }
        out.net = {
            ...data.net,
            interfaces,
            total: {
                ...data.net.total,
                rxRate: ema(prev.net.total.rxRate, data.net.total.rxRate, alpha),
                txRate: ema(prev.net.total.txRate, data.net.total.txRate, alpha),
            },
        };
    }
    return out;
}

// Numeric fields that glide. Anything else (names, counts, identifiers, load
// averages printed as they are, process lists) switches at once: blending
// those would show long decimals or mix two different processes.
const GLIDE = new Set([
    'total', 'cores', 'percent', 'used', 'available', 'swapPercent',
    'energyRate', 'packagePower', 'systemPower', 'gpuPower',
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
