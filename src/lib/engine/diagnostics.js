// Findings about unnecessary use of the processor, memory, battery and
// network, from the usage ledger, the daily network totals and the
// machine's current state. Pure functions: every finding carries the
// evidence it rests on, and a rule without evidence says nothing.
//
// Engine layer; the preferences window gathers the inputs and shows the
// findings.

// Thresholds. An app is a background consumer when most of its CPU time
// was spent without focus and it took a noticeable part of the energy.
import { _, fill } from '../common/i18n.js';
import { formatBytes } from '../common/format.js';

/** The areas findings are grouped in, in the order they are shown. */
export const AREAS = ['cpu', 'memory', 'battery', 'network', 'data'];

const BACKGROUND_FRACTION = 0.6;
const BACKGROUND_MIN_SHARE = 0.05;
const BACKGROUND_MIN_WH = 0.2;
const BRIGHT_FRACTION = 0.8;
const WORN_HEALTH = 80;
const MOSTLY_PLUGGED = 0.8;
const MIN_TRACKED_HOURS = 1;
const HOT_FRACTION = 0.2;
// CPU: an app using a tenth of a core on average while not in use; system
// services taking a quarter of all CPU time and a fifth of a core; programs
// waiting for the CPU a tenth of the time (a quarter: a warning).
const BACKGROUND_MIN_CORES = 0.1;
const SYSTEM_SHARE = 0.25;
const SYSTEM_MIN_CORES = 0.2;
const CPU_STALL = 0.1;
const CPU_STALL_BAD = 0.25;
// Memory: an app holding at least a GiB (or a tenth of the machine's memory)
// for 4 hours or more without being used; growing for 6 hours or more by half
// again and at least 512 MiB, rising in most hours; swap traffic of 100 MiB
// an hour; programs waiting for memory 5 % of the time; more than 90 % in use
// in 3 hours or more.
const IDLE_MEMORY_MIB = 1024;
const IDLE_MEMORY_SHARE = 0.1;
const IDLE_MEMORY_HOURS = 4;
const GROWTH_HOURS = 6;
const GROWTH_MIN_MIB = 512;
const GROWTH_FACTOR = 0.5;
const GROWTH_RISING = 0.8;
const SWAP_MIB_PER_HOUR = 100;
const MEMORY_STALL = 0.05;
const FULL_FRACTION = 0.9;
const FULL_HOURS = 3;
// Network: a day 3 times a usual one (the median of at least 7 earlier days)
// and over 1 GB; 200 MB and 20 kB/s while the user was away.
const DAY_FACTOR = 3;
const DAY_MIN_BYTES = 1e9;
const DAY_MIN_HISTORY = 7;
const AWAY_MIN_BYTES = 200e6;
const AWAY_MIN_RATE = 20e3;

/**
 * Minutes a full charge gains when the average drain drops by `savedW`.
 * @param {number} fullWh energy of a full charge
 * @param {number} drainW average drain on battery
 * @param {number} savedW
 * @returns {?number}
 */
export function minutesGained(fullWh, drainW, savedW) {
    if (!(fullWh > 0) || !(drainW > 0) || !(savedW > 0) || savedW >= drainW) return null;
    return (fullWh / (drainW - savedW) - fullWh / drainW) * 60;
}

function round1(x) {
    return Math.round(x * 10) / 10;
}

function percent(x) {
    return Math.round(x * 100);
}

/** MiB as "1.2 GiB". */
function mib(x) {
    return formatBytes(x * 1024 * 1024, true);
}

function median(values) {
    const sorted = [...values].sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The longest run of consecutive hours in which an app held memory.
 * @returns {Array<{t: number, mib: number}>}
 */
function longestMemoryRun(hours, id) {
    let best = [];
    let run = [];
    let prevT = null;
    for (const h of hours) {
        const app = h.apps.get(id);
        if (!app || !(app.memMaxMiB > 0)) run = [];
        else if (run.length > 0 && h.t - prevT === 3600 * 1000) run.push({ t: h.t, mib: app.memMaxMiB });
        else run = [{ t: h.t, mib: app.memMaxMiB }];
        if (run.length > best.length) best = run;
        prevT = h.t;
    }
    return best;
}

/**
 * @param {object} input
 * @param {object} input.battery summary of the ledger on battery only (BatteryLedger.summarize)
 * @param {object} input.all summary of the ledger, AC and battery
 * @param {object} input.state current state of the machine:
 *   { battery: ?{ healthPct, cycles, fullWh, chargeLimit: 'unsupported'|'off'|'on' },
 *     backlight: ?number (0..1), powerProfile: ?string, onBattery: boolean, energyReadable: boolean }
 * @param {function(string): string} [input.appName] display name for an app id
 * @param {Array<object>} [input.hours] the same range by hour (BatteryLedger.hours)
 * @param {Array<{day: string, rx: number, tx: number}>} [input.netDays] daily network totals, oldest first
 * @param {function(string): boolean} [input.isApp] whether an id is an app the user starts (not a service)
 * @returns {Array<{id: string, area: string, severity: string, title: string, detail: string,
 *   evidence: string, estimate: ?{watts: number, minutes: ?number}, action: ?object, app?: string}>}
 *   app: the app a finding about background work is about, for pausing it or lowering its priority
 *   area is one of AREAS; most important first
 */
export function diagnose({ battery, all, state, appName = id => id, hours = [], netDays = [], isApp = () => true }) {
    const findings = [];
    const hoursOnBattery = battery.seconds / 3600;
    const drainW = hoursOnBattery > 0 ? battery.batteryWh / hoursOnBattery : null;
    const fullWh = state.battery?.fullWh ?? null;

    // Runtime: apps that use energy while you are not using them.
    if (hoursOnBattery >= MIN_TRACKED_HOURS && battery.hasEnergy && battery.attributedWh > 0) {
        for (const app of battery.apps) {
            if (app.id.startsWith('@') || app.cpu <= 0) continue;
            const background = (app.cpu - app.fg) / app.cpu;
            const backgroundWh = app.wh * background;
            if (background < BACKGROUND_FRACTION || app.wh / battery.attributedWh < BACKGROUND_MIN_SHARE ||
                backgroundWh < BACKGROUND_MIN_WH) continue;
            const watts = backgroundWh / hoursOnBattery;
            const minutes = drainW !== null ? minutesGained(fullWh, drainW, watts) : null;
            findings.push({
                id: `background:${app.id}`,
                area: 'battery',
                severity: 'suggestion',
                title: fill(_('{app} works in the background'), { app: appName(app.id) }),
                detail: _('Quit it when you are not using it, or check its settings for background activity.'),
                evidence: fill(_('{percent} % of its CPU time on battery was without focus: about {wh} Wh over {hours} h on battery.'),
                    { percent: Math.round(background * 100), wh: round1(backgroundWh), hours: round1(hoursOnBattery) }),
                estimate: { watts, minutes },
                action: null,
                // Pausing it or lowering its priority acts on this: the panel offers both.
                app: app.id,
            });
        }
    }

    // Runtime: settings that cost energy on battery.
    if (state.battery && state.onBattery && state.powerProfile === 'performance') {
        findings.push({
            id: 'power-profile',
            area: 'battery',
            severity: 'suggestion',
            title: _('Performance power mode on battery'),
            detail: _('Balanced mode keeps the processor from running at its highest clocks when nothing needs them.'),
            evidence: _('The power mode is "performance" and the machine runs on battery.'),
            estimate: null,
            action: { kind: 'power-profile', value: 'balanced', label: _('Switch to Balanced') },
        });
    }
    if (state.battery && Number.isFinite(state.backlight) && state.backlight >= BRIGHT_FRACTION) {
        findings.push({
            id: 'brightness',
            area: 'battery',
            severity: 'suggestion',
            title: _('Screen brightness is high'),
            detail: _('The display is often the largest single consumer of a laptop. Its use cannot be measured here, so no saving is estimated.'),
            evidence: fill(_('The backlight is at {percent} %.'), { percent: Math.round(state.backlight * 100) }),
            estimate: null,
            action: null,
        });
    }
    if (hoursOnBattery >= MIN_TRACKED_HOURS && battery.hotSeconds > 0 && battery.hotSeconds / battery.seconds >= HOT_FRACTION) {
        findings.push({
            id: 'heat',
            area: 'battery',
            severity: 'suggestion',
            title: _('The processor runs hot on battery'),
            detail: _('Heat means power: look at the apps at the top of the list, and keep the air vents free.'),
            evidence: fill(_('{percent} % of the time on battery the CPU was above the temperature alert.'), { percent: Math.round(battery.hotSeconds / battery.seconds * 100) }),
            estimate: null,
            action: null,
        });
    }

    // Lifespan: wear, charge limit, always plugged in.
    const b = state.battery;
    if (b && Number.isFinite(b.healthPct)) {
        const worn = b.healthPct < WORN_HEALTH;
        findings.push({
            id: 'wear',
            area: 'battery',
            severity: worn ? 'warning' : 'info',
            title: worn ? _('The battery is worn') : _('Battery health'),
            detail: worn
                ? _('It holds noticeably less than when new; runtime per charge is shorter by the same amount.')
                : _('Capacity is within the normal range for its age.'),
            evidence: fill(Number.isFinite(b.cycles) && b.cycles > 0
                ? _('It holds {percent} % of its design capacity after {cycles} charge cycles.')
                : _('It holds {percent} % of its design capacity.'), { percent: Math.round(b.healthPct), cycles: b.cycles }),
            estimate: null,
            action: null,
        });
        const pluggedFraction = all.seconds > 0 ? 1 - battery.seconds / all.seconds : null;
        if (b.chargeLimit === 'off') {
            findings.push({
                id: 'charge-limit',
                area: 'battery',
                severity: 'suggestion',
                title: _('Limit charging to about 80 %'),
                detail: _('Keeping a battery full wears it faster. This battery supports a charge limit: turn on "Preserve Battery Health" in Settings › Power.'),
                evidence: _('The battery supports a charge limit and it is off.'),
                estimate: null,
                action: { kind: 'open-power-settings', label: _('Open Power Settings') },
            });
        } else if (b.chargeLimit === 'unsupported' && pluggedFraction !== null && all.seconds / 3600 >= MIN_TRACKED_HOURS &&
            pluggedFraction >= MOSTLY_PLUGGED) {
            findings.push({
                id: 'always-plugged',
                area: 'battery',
                severity: 'info',
                title: _('Mostly plugged in'),
                detail: _('This battery has no charge limit. Kept at 100 % on the charger it wears faster; unplugging now and then, or running between about 20 and 80 %, helps it last.'),
                evidence: fill(_('{percent} % of the tracked time was on the charger.'), { percent: Math.round(pluggedFraction * 100) }),
                estimate: null,
                action: null,
            });
        }
    }

    // Data: what limits the report itself.
    if (!state.energyReadable) {
        findings.push({
            id: 'energy-unreadable',
            area: 'data',
            severity: 'info',
            title: _('Power readings are not available'),
            detail: _('Apps are ranked by CPU time only. Enabling CPU power readings (Troubleshooting) gives energy figures.'),
            evidence: _('The CPU energy counters cannot be read by this user.'),
            estimate: null,
            action: null,
        });
    }

    findings.push(...cpuFindings({ battery, all, state, appName, named: new Set(findings.map(f => f.id)) }));
    findings.push(...memoryFindings({ all, hours, appName, isApp }));
    findings.push(...networkFindings({ all, netDays }));
    if (all.seconds / 3600 >= MIN_TRACKED_HOURS && all.memSeconds === 0) {
        findings.push({
            id: 'memory-untracked',
            area: 'data',
            severity: 'info',
            title: _('Memory and network are not in the history yet'),
            detail: _('They are recorded from this version on; their findings appear after an hour or more of tracking.'),
            evidence: _('The tracked hours hold no memory figures.'),
            estimate: null,
            action: null,
        });
    }

    const rank = { warning: 0, suggestion: 1, info: 2 };
    return findings.sort((x, y) => (rank[x.severity] - rank[y.severity]) ||
        ((y.estimate?.watts ?? 0) - (x.estimate?.watts ?? 0)));
}

/** Processor: apps busy while not in use (on the charger too), system services, waiting for the CPU, heat on the charger. */
function cpuFindings({ battery, all, state, appName, named }) {
    const out = [];
    const hours = all.seconds / 3600;
    if (hours < MIN_TRACKED_HOURS) return out;
    for (const app of all.apps) {
        // Named on battery already, with its energy: not twice.
        if (app.id.startsWith('@') || app.cpu <= 0 || named.has(`background:${app.id}`)) continue;
        const background = (app.cpu - app.fg) / app.cpu;
        const cores = (app.cpu - app.fg) / 1e6 / all.seconds;
        if (background < BACKGROUND_FRACTION || cores < BACKGROUND_MIN_CORES) continue;
        out.push({
            id: `cpu-background:${app.id}`,
            area: 'cpu',
            severity: 'suggestion',
            title: fill(_('{app} keeps the processor busy in the background'), { app: appName(app.id) }),
            detail: _('Quit it when you are not using it, or look in its settings for background work (sync, indexing, updates).'),
            evidence: fill(_('{percent} % of its processor time was without focus: on average {cores} % of one core over {hours} h tracked.'),
                { percent: percent(background), cores: percent(cores), hours: round1(hours) }),
            estimate: all.hasEnergy && app.wh > 0 ? { watts: app.wh * background / hours, minutes: null } : null,
            action: null,
            app: app.id,
        });
    }
    const system = all.apps.find(a => a.id === '@system');
    if (system && all.cpu > 0) {
        const share = system.cpu / all.cpu;
        const cores = system.cpu / 1e6 / all.seconds;
        if (share >= SYSTEM_SHARE && cores >= SYSTEM_MIN_CORES) {
            out.push({
                id: 'system-services',
                area: 'cpu',
                severity: 'suggestion',
                title: _('System services use a large share of the processor'),
                detail: _('These run outside your session (updates, indexing, backups, drivers). "systemd-cgtop" shows which one.'),
                evidence: fill(_('{percent} % of all processor time, on average {cores} % of one core over {hours} h tracked.'),
                    { percent: percent(share), cores: percent(cores), hours: round1(hours) }),
                estimate: null,
                action: null,
            });
        }
    }
    if (all.stallSeconds / 3600 >= MIN_TRACKED_HOURS) {
        const waiting = all.stall.cpu / all.stallSeconds;
        if (waiting >= CPU_STALL) {
            out.push({
                id: 'cpu-stalls',
                area: 'cpu',
                severity: waiting >= CPU_STALL_BAD ? 'warning' : 'suggestion',
                title: _('Programs often wait for the processor'),
                detail: _('More work is asked of the processor than it can do at once, so everything feels slower. The apps at the top of the list are the place to start.'),
                evidence: fill(_('In {percent} % of the tracked time at least one program was waiting for the processor.'), { percent: percent(waiting) }),
                estimate: null,
                action: null,
            });
        }
    }
    // Heat on battery is a battery finding; here the rest of the time.
    const acSeconds = state.battery ? all.seconds - battery.seconds : all.seconds;
    const acHot = state.battery ? all.hotSeconds - battery.hotSeconds : all.hotSeconds;
    if (acSeconds / 3600 >= MIN_TRACKED_HOURS && acHot / acSeconds >= HOT_FRACTION) {
        out.push({
            id: 'heat-ac',
            area: 'cpu',
            severity: 'suggestion',
            title: state.battery ? _('The processor runs hot on the charger') : _('The processor runs hot'),
            detail: _('Heat means the processor works hard or cannot cool: look at the apps at the top of the list, and keep the air vents free.'),
            evidence: fill(state.battery
                ? _('{percent} % of the time on the charger the CPU was above the temperature alert.')
                : _('{percent} % of the tracked time the CPU was above the temperature alert.'), { percent: percent(acHot / acSeconds) }),
            estimate: null,
            action: null,
        });
    }
    return out;
}

/** Memory: held without use, growing, swapping, waiting for memory, nearly full. */
function memoryFindings({ all, hours, appName, isApp }) {
    const out = [];
    const enough = all.memTotalMiB > 0 ? Math.max(IDLE_MEMORY_MIB, all.memTotalMiB * IDLE_MEMORY_SHARE) : IDLE_MEMORY_MIB;
    const ids = new Set();
    for (const h of hours) for (const id of h.apps.keys()) if (!id.startsWith('@') && isApp(id)) ids.add(id);
    for (const id of ids) {
        // Hours in which it held a lot without ever being in front.
        let idleHours = 0;
        let idleMiBs = 0;
        let idleSeconds = 0;
        for (const h of hours) {
            const app = h.apps.get(id);
            if (!app || h.memSeconds <= 0 || app.fg > 0 || app.memMiBs / h.memSeconds < enough) continue;
            idleHours++;
            idleMiBs += app.memMiBs;
            idleSeconds += h.memSeconds;
        }
        if (idleHours >= IDLE_MEMORY_HOURS) {
            out.push({
                id: `memory-idle:${id}`,
                area: 'memory',
                severity: 'suggestion',
                title: fill(_('{app} holds a lot of memory while unused'), { app: appName(id) }),
                detail: _('Quitting it, or closing the tabs and documents it keeps open, gives the memory back to the apps you use.'),
                evidence: fill(_('On average {size} in {hours} hours in which it was never in front.'), { size: mib(idleMiBs / idleSeconds), hours: idleHours }),
                estimate: null,
                action: null,
            });
        }

        const run = longestMemoryRun(hours, id);
        if (run.length < GROWTH_HOURS) continue;
        const first = run[0].mib;
        const last = run[run.length - 1].mib;
        let rising = 0;
        for (let i = 1; i < run.length; i++) if (run[i].mib >= run[i - 1].mib) rising++;
        if (last - first >= GROWTH_MIN_MIB && last - first >= first * GROWTH_FACTOR && rising / (run.length - 1) >= GROWTH_RISING) {
            out.push({
                id: `memory-growth:${id}`,
                area: 'memory',
                severity: 'warning',
                title: fill(_('{app} keeps growing in memory'), { app: appName(id) }),
                detail: _('Memory that only grows while an app runs can be a leak. Restarting it gives the memory back; if it grows again, an update or a bug report may help.'),
                evidence: fill(_('From {from} to {to} over {hours} hours in a row, higher in {rising} of them.'),
                    { from: mib(first), to: mib(last), hours: run.length, rising }),
                estimate: null,
                action: null,
            });
        }
    }

    const memHours = all.memSeconds / 3600;
    if (memHours >= MIN_TRACKED_HOURS) {
        const swapPerHour = (all.swapInMiB + all.swapOutMiB) / memHours;
        if (swapPerHour >= SWAP_MIB_PER_HOUR) {
            out.push({
                id: 'swapping',
                area: 'memory',
                severity: 'warning',
                title: _('The machine swaps'),
                detail: _('Memory is moved to disk and back because there is not enough of it, which slows everything down. Quit apps that hold a lot of memory.'),
                evidence: fill(_('{amount} moved to and from swap per hour on average; swap in use reached {used}.'),
                    { amount: mib(swapPerHour), used: mib(all.swapMaxMiB) }),
                estimate: null,
                action: null,
            });
        }
        let fullHours = 0;
        for (const h of hours) if (h.memTotalMiB > 0 && h.memMaxMiB >= h.memTotalMiB * FULL_FRACTION) fullHours++;
        if (fullHours >= FULL_HOURS) {
            out.push({
                id: 'memory-full',
                area: 'memory',
                severity: 'suggestion',
                title: _('Memory is often nearly full'),
                detail: _('With little memory left the system swaps and drops cached files, and apps slow down. Quit the apps that hold the most.'),
                evidence: fill(_('More than {percent} % was in use in {hours} of the tracked hours.'), { percent: percent(FULL_FRACTION), hours: fullHours }),
                estimate: null,
                action: null,
            });
        }
    }
    if (all.stallSeconds / 3600 >= MIN_TRACKED_HOURS) {
        const waiting = all.stall.memory / all.stallSeconds;
        if (waiting >= MEMORY_STALL) {
            out.push({
                id: 'memory-stalls',
                area: 'memory',
                severity: 'warning',
                title: _('Programs wait for memory'),
                detail: _('The kernel had to free memory before programs could go on: the clearest sign that memory is short.'),
                evidence: fill(_('In {percent} % of the tracked time at least one program was waiting for memory.'), { percent: percent(waiting) }),
                estimate: null,
                action: null,
            });
        }
    }
    return out;
}

/** Network, for the whole machine: traffic per app cannot be read without root. */
function networkFindings({ all, netDays }) {
    const out = [];
    let worst = null;
    // Each of the last 7 days against the median of the days before it.
    for (let i = Math.max(DAY_MIN_HISTORY, netDays.length - 7); i < netDays.length; i++) {
        const usual = median(netDays.slice(0, i).map(d => d.rx + d.tx));
        const total = netDays[i].rx + netDays[i].tx;
        if (total >= DAY_MIN_BYTES && usual > 0 && total >= usual * DAY_FACTOR && (!worst || total / usual > worst.factor))
            worst = { day: netDays[i].day, total, usual, factor: total / usual };
    }
    if (worst) {
        out.push({
            id: 'traffic-day',
            area: 'network',
            severity: 'info',
            title: _('A day with far more traffic than usual'),
            detail: _('A large update, a backup or a sync can explain it. If none ran, look at which apps were busy that day on the Tracking page.'),
            evidence: fill(_('On {day} the machine moved {total}, {factor} times a usual day ({usual}).'),
                { day: worst.day, total: formatBytes(worst.total), factor: round1(worst.factor), usual: formatBytes(worst.usual) }),
            estimate: null,
            action: null,
        });
    }
    if (all.idleSeconds / 3600 >= MIN_TRACKED_HOURS) {
        const bytes = all.idleRxBytes + all.idleTxBytes;
        const rate = bytes / all.idleSeconds;
        if (bytes >= AWAY_MIN_BYTES && rate >= AWAY_MIN_RATE) {
            out.push({
                id: 'traffic-away',
                area: 'network',
                severity: 'suggestion',
                title: _('Data moves while you are away'),
                detail: _('Something uploads or downloads while nobody uses the machine: sync, backups, updates, or an app left playing. Which program it is cannot be read without administrator rights ("sudo nethogs" shows it).'),
                evidence: fill(_('{total} over {hours} h without input ({sent} of it sent), about {rate}/s.'),
                    { total: formatBytes(bytes), hours: round1(all.idleSeconds / 3600), sent: formatBytes(all.idleTxBytes), rate: formatBytes(rate) }),
                estimate: null,
                action: null,
            });
        }
    }
    return out;
}
