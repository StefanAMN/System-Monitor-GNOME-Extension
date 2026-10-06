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

/**
 * Bars over a period: one per hour up to two days, one per day beyond.
 * @param {object} ledger BatteryLedger
 * @param {number} from wall ms
 * @param {number} now wall ms
 * @param {boolean} batteryOnly
 * @param {function(object): object} start a bar's empty accumulator
 * @param {function(object, object)} add adds a bucket into a bar
 * @returns {Array<object>} the bars, each with t (its start) and its accumulator's fields
 */
export function bars(ledger, from, now, batteryOnly, start, add) {
    const perDay = now - from > 48 * HOUR_MS;
    const first = perDay ? new Date(new Date(from).setHours(0, 0, 0, 0)).getTime() : startOfHour(from);
    const points = [];
    for (let t = first; t <= now; t = perDay ? new Date(new Date(t).setDate(new Date(t).getDate() + 1)).getTime() : t + HOUR_MS)
        points.push({ t, ...start() });
    for (const b of ledger.buckets) {
        if (b.t < first || (batteryOnly && !b.b)) continue;
        const i = perDay ? points.findLastIndex(p => p.t <= b.t) : Math.floor((b.t - first) / HOUR_MS);
        if (i >= 0 && i < points.length) add(points[i], b);
    }
    return points;
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
 * @returns {{has: boolean, tiles: Object<string, ?number>, series: string[], points: Array<object>,
 *   apps: ?Array<{app: object, value: number, share: number}>}}
 *   has: the period holds figures for this component; tiles: named figures
 *   (null: not measured); points: bars with one value per series; apps: null
 *   where no per-app figure exists
 */
export function componentView(component, ledger, { from, now, cores = 1 }) {
    const sum = ledger.summarize({ from });
    const barsOf = (start, add) => bars(ledger, from, now, false, start, add);
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
