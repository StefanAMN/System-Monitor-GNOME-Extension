// What the Tracking tab shows for each component other than the battery:
// the summary figures, the bars of the chart and the apps ranked by the
// component's figure. Pure functions over the ledger; numbers only (the
// preferences window formats them).
//
// Engine layer.

/** The components, in the order offered; 'battery' is the tab's own view. */
export const COMPONENTS = ['battery', 'cpu', 'memory', 'disk', 'network', 'gpu', 'thermal'];

const HOUR_MS = 3600 * 1000;

function startOfHour(ms) {
    return new Date(new Date(ms).setMinutes(0, 0, 0)).getTime();
}

const DAY = 'day';
const FINE_STEP_MS = 5 * 60 * 1000;
// The narrowest span a chart zooms to.
export const MIN_SPAN_MS = 30 * 60 * 1000;

function startOfDay(ms) {
    return new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
}

function nextDay(ms) {
    const d = new Date(ms);
    return new Date(d.setDate(d.getDate() + 1)).getTime();
}

/**
 * The bar length for a span: 5 minutes up to 4 h, 15 minutes up to 16 h
 * (both only where five-minute totals cover the start), an hour up to two
 * days, a day beyond.
 * @param {number} from wall ms
 * @param {number} to wall ms
 * @param {number} fineStart the oldest five-minute total (Infinity: none)
 * @returns {number|string} ms, or 'day'
 */
export function stepFor(from, to, fineStart = Infinity) {
    const span = to - from;
    if (from >= fineStart && span <= 4 * HOUR_MS) return FINE_STEP_MS;
    if (from >= fineStart && span <= 16 * HOUR_MS) return 3 * FINE_STEP_MS;
    return span <= 48 * HOUR_MS ? HOUR_MS : DAY;
}

/** The oldest five-minute total the ledger holds, or Infinity. */
export function fineFrom(ledger) {
    return ledger.fine?.length ? ledger.fine[0].t : Infinity;
}

/**
 * Bars over [from, to): one per `step` (ms, or 'day'); steps under an hour
 * read the five-minute totals, longer ones the hourly buckets.
 * @param {object} ledger BatteryLedger
 * @param {number} from wall ms
 * @param {number} to wall ms (usually now)
 * @param {boolean} batteryOnly
 * @param {function(object): object} start a bar's empty accumulator
 * @param {function(object, object)} add adds a bucket into a bar
 * @param {number|string} [step] by default an hour up to two days, a day beyond
 * @returns {Array<object>} the bars, each with t (its start), step and its accumulator's fields
 */
export function bars(ledger, from, to, batteryOnly, start, add, step = to - from > 48 * HOUR_MS ? DAY : HOUR_MS) {
    const perDay = step === DAY;
    const first = perDay ? startOfDay(from) : Math.floor(from / step) * step;
    // Hours start on the hour in local time (zones with a half-hour offset too).
    const aligned = step === HOUR_MS ? startOfHour(from) : first;
    const points = [];
    for (let t = aligned; t < to || points.length === 0; t = perDay ? nextDay(t) : t + step)
        points.push({ t, step, ...start() });
    const source = !perDay && step < HOUR_MS ? (ledger.fine ?? []) : ledger.buckets;
    for (const b of source) {
        if (b.t < aligned || b.t >= to || (batteryOnly && !b.b)) continue;
        const i = perDay ? points.findLastIndex(p => p.t <= b.t) : Math.floor((b.t - aligned) / step);
        if (i >= 0 && i < points.length) add(points[i], b);
    }
    return points;
}

/** [from, to] moved and resized to stay inside [lo, hi], at least MIN_SPAN_MS wide. */
export function clampRange(from, to, lo, hi) {
    const span = Math.min(hi - lo, Math.max(MIN_SPAN_MS, to - from));
    let start = Math.max(lo, Math.min(from, hi - span));
    if (start + span > hi) start = hi - span;
    return [start, start + span];
}

/**
 * Zoom [from, to] about the time `centre` by `factor` (< 1 in, > 1 out),
 * kept inside [lo, hi]: the time under the pointer stays under it.
 */
export function zoomAbout(from, to, centre, factor, lo, hi) {
    const at = Math.max(from, Math.min(to, centre));
    return clampRange(at - (at - from) * factor, at + (to - at) * factor, lo, hi);
}

/**
 * The battery's wear over time, from the ledger's daily entries.
 * @returns {?{health: number, change: ?number, since: string, cycles: number, fullWh: number,
 *   points: Array<{t: number, health: number, step: number}>, floor: number}} null with no entry; change
 *   null with one day; points per day, per week over 8 weeks; floor where the chart's bars start
 */
export function healthView(ledger) {
    const days = ledger.health ?? [];
    if (days.length === 0) return null;
    const first = days[0];
    const last = days[days.length - 1];
    const every = days.length > 56 ? 7 : 1;
    // Counted back from today, so the newest reading is always a bar.
    const shown = days.filter((_d, i) => (days.length - 1 - i) % every === 0);
    const points = shown.map(e => {
        const [y, m, d] = e.d.split('-').map(Number);
        return { t: new Date(y, m - 1, d).getTime(), health: e.h, step: every * 24 * HOUR_MS };
    });
    // Wear moves a few points a year: on an axis from 0 the bars would all look the same.
    const lowest = Math.min(...shown.map(e => e.h));
    return {
        health: last.h,
        change: days.length > 1 ? Math.round((last.h - first.h) * 10) / 10 : null,
        since: first.d,
        cycles: last.c,
        fullWh: last.f,
        points,
        floor: Math.max(0, Math.floor((lowest - 5) / 10) * 10),
    };
}

/** Apps (not the '@' pseudo apps unless asked) with a figure above 0, largest first. */
function ranked(apps, value, { withSystem = false } = {}) {
    const list = apps.filter(a => (withSystem || !a.id.startsWith('@')) && value(a) > 0);
    const total = list.reduce((t, a) => t + value(a), 0);
    return list.map(a => ({ app: a, value: value(a), share: total > 0 ? value(a) / total : 0 }))
        .sort((x, y) => y.value - x.value);
}

/**
 * @param {string} component one of COMPONENTS but 'battery'
 * @param {object} ledger BatteryLedger
 * @param {object} opts
 * @param {number} opts.from wall ms
 * @param {number} opts.now wall ms
 * @param {number} opts.cores logical processors, for the processor's share of the machine
 * @param {number} [opts.viewFrom] start of the part of the period the chart shows (zoomed)
 * @param {number} [opts.viewTo] its end
 * @returns {{has: boolean, tiles: Object<string, ?number>, series: string[], points: Array<object>,
 *   apps: ?Array<{app: object, value: number, share: number}>}}
 *   has: the period holds figures for this component; tiles: named figures
 *   (null: not measured); points: bars with one value per series; apps: null
 *   where no per-app figure exists
 */
export function componentView(component, ledger, { from, now, cores = 1, viewFrom = from, viewTo = now }) {
    const sum = ledger.summarize({ from });
    // The chart may show a zoomed part of the period; the figures cover all of it.
    const step = stepFor(viewFrom, viewTo, fineFrom(ledger));
    const barsOf = (start, add) => bars(ledger, viewFrom, viewTo, false, start, add, step);
    const share = (part, whole) => (whole > 0 ? part / whole : null);
    switch (component) {
    case 'cpu': {
        const capacity = sum.seconds * 1e6 * cores;
        return {
            has: sum.seconds > 0,
            tiles: {
                load: share(sum.cpu, capacity),
                waiting: sum.stallSeconds > 0 ? sum.stall.cpu / sum.stallSeconds : null,
                hot: sum.seconds > 0 ? sum.hotSeconds : null,
                time: sum.seconds,
            },
            series: ['load'],
            points: barsOf(() => ({ cpu: 0, s: 0, load: 0 }), (p, b) => {
                p.cpu += b.cpu;
                p.s += b.s;
                p.load = p.s > 0 ? p.cpu / (p.s * 1e6 * cores) : 0;
            }),
            apps: ranked(sum.apps, a => a.cpu, { withSystem: true }),
        };
    }
    case 'memory':
        return {
            has: sum.memSeconds > 0,
            tiles: {
                average: sum.memSeconds > 0 ? sum.memUsedMiBs / sum.memSeconds : null,
                highest: sum.memSeconds > 0 ? sum.memMaxMiB : null,
                total: sum.memTotalMiB || null,
                swap: sum.memSeconds > 0 ? sum.swapMaxMiB : null,
                swapTotal: sum.swapTotalMiB || null,
                waiting: sum.stallSeconds > 0 ? sum.stall.memory / sum.stallSeconds : null,
            },
            series: ['highest', 'average'],
            points: barsOf(() => ({ highest: 0, average: 0, mu: 0, ms: 0 }), (p, b) => {
                p.highest = Math.max(p.highest, b.mx ?? 0);
                p.mu += b.mu ?? 0;
                p.ms += b.ms ?? 0;
                p.average = p.ms > 0 ? p.mu / p.ms : 0;
            }),
            apps: ranked(sum.apps, a => a.memAvgMiB),
        };
    case 'disk':
        return {
            has: sum.diskSeconds > 0,
            tiles: {
                read: sum.diskSeconds > 0 ? sum.diskReadBytes : null,
                written: sum.diskSeconds > 0 ? sum.diskWrittenBytes : null,
                waiting: sum.stallSeconds > 0 ? sum.stall.io / sum.stallSeconds : null,
                apps: sum.apps.reduce((t, a) => t + a.diskRead + a.diskWritten, 0),
            },
            series: ['read', 'written'],
            points: barsOf(() => ({ read: 0, written: 0 }), (p, b) => {
                p.read += b.dr ?? 0;
                p.written += b.dw ?? 0;
            }),
            apps: ranked(sum.apps, a => a.diskRead + a.diskWritten),
        };
    case 'network':
        return {
            has: sum.netSeconds > 0,
            tiles: {
                received: sum.netSeconds > 0 ? sum.rxBytes : null,
                sent: sum.netSeconds > 0 ? sum.txBytes : null,
                away: sum.idleSeconds > 0 ? sum.idleRxBytes + sum.idleTxBytes : null,
                awaySeconds: sum.idleSeconds,
            },
            series: ['received', 'sent'],
            points: barsOf(() => ({ received: 0, sent: 0 }), (p, b) => {
                p.received += b.rx ?? 0;
                p.sent += b.tx ?? 0;
            }),
            apps: null,
        };
    case 'gpu':
        return {
            has: sum.seconds > 0 && sum.gpu > 0,
            tiles: {
                busy: sum.gpu > 0 ? sum.gpu / 1e9 : null,
                share: sum.seconds > 0 && sum.gpu > 0 ? sum.gpu / 1e9 / sum.seconds : null,
                energy: sum.hasEnergy && sum.graphicsWh > 0 ? sum.graphicsWh : null,
            },
            series: ['busy'],
            points: barsOf(() => ({ busy: 0 }), (p, b) => {
                p.busy += (b.gpu ?? 0) / 1e9;
            }),
            apps: ranked(sum.apps, a => a.gpu),
        };
    case 'thermal':
        return {
            has: sum.tempSeconds > 0,
            tiles: {
                average: sum.tempAvg,
                highest: sum.tempSeconds > 0 ? sum.tempMax : null,
                hot: sum.seconds > 0 ? sum.hotSeconds : null,
            },
            series: ['highest', 'average'],
            points: barsOf(() => ({ highest: 0, average: 0, ta: 0, tt: 0 }), (p, b) => {
                p.highest = Math.max(p.highest, b.tm ?? 0);
                p.ta += b.ta ?? 0;
                p.tt += b.tt ?? 0;
                p.average = p.tt > 0 ? p.ta / p.tt : 0;
            }),
            apps: null,
        };
    default:
        throw new Error(`no view for component ${component}`);
    }
}
