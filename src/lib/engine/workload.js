// Compare whole, completed history buckets, using each metric's own measured
// time. This is a view over existing Tracking data and starts no new sampler.
import { FINE_MS } from './batteryledger.js';

const HOUR_MS = 3600 * 1000;
export const WORKLOAD_MINUTES = [5, 15, 30, 60, 120, 240, 480, 1440];
export const WORKLOAD_MIN_COVERAGE = 0.95;
export const WORKLOAD_METRICS = ['cpu', 'memory', 'read', 'write', 'battery'];

function source(ledger, minutes) {
    return minutes < 60 ? (ledger.fine ?? []) : ledger.buckets;
}

/** Recorded start choices for a whole range which has already ended. */
export function workloadStarts(ledger, minutes, now) {
    const span = minutes * 60000;
    const starts = new Set();
    for (const bucket of source(ledger, minutes)) {
        if (bucket.t + span <= now && bucket.s > 0) starts.add(bucket.t);
    }
    return [...starts].sort((a, b) => b - a);
}

function rangeTotals(buckets, from, to, step) {
    let cs = 0, cc = 0, ms = 0, mu = 0, ds = 0, dr = 0, dw = 0, bs = 0, bc = 0;
    for (const b of buckets) {
        if (b.t < from || b.t + step > to) continue;
        if (b.cs > 0) { cs += b.cs; cc += b.cc ?? 0; }
        if (b.ms > 0) { ms += b.ms; mu += b.mu ?? 0; }
        if (b.ds > 0) { ds += b.ds; dr += b.dr ?? 0; dw += b.dw ?? 0; }
        if (b.b && b.bs > 0) { bs += b.bs; bc += b.bc ?? 0; }
    }
    const measure = (seconds, amount, scale = 1) => ({ seconds, value: seconds > 0 ? amount / seconds * scale : null });
    return {
        cpu: measure(cs, cc, 60 / 1e6),
        memory: measure(ms, mu, 2 ** 20),
        read: measure(ds, dr, 60),
        write: measure(ds, dw, 60),
        battery: measure(bs, bc, 3600),
    };
}

/** Equal-duration, non-overlapping ranges. Difference is withheld if either
 * period lacks coverage. A measured zero stays a valid value and delta. */
export function compareWorkloads(ledger, { before, after, minutes, now }) {
    if (!WORKLOAD_MINUTES.includes(minutes) || !Number.isFinite(now)) return null;
    const span = minutes * 60000;
    const step = minutes < 60 ? FINE_MS : HOUR_MS;
    const buckets = source(ledger, minutes);
    // Hourly starts use the timezone in effect when the history was written.
    // A previous location's whole hours may start at :30 or :45 today.
    const aligned = time => Number.isSafeInteger(time) && time >= 0 && (step === FINE_MS
        ? time % step === 0 : buckets.some(bucket => bucket.t === time));
    if (!aligned(before) || !aligned(after) || before + span > after || after + span > now) return null;
    const a = rangeTotals(buckets, before, before + span, step);
    const b = rangeTotals(buckets, after, after + span, step);
    const seconds = span / 1000;
    const reliable = measure => measure.seconds >= seconds * WORKLOAD_MIN_COVERAGE;
    const result = {};
    for (const key of WORKLOAD_METRICS) {
        const left = a[key], right = b[key];
        const change = reliable(left) && reliable(right) ? right.value - left.value : null;
        result[key] = { before: left, after: right, change, percent: change !== null && left.value > 0 ? change / left.value * 100 : null };
    }
    return { seconds, metrics: result };
}
