// Advice for longer runtime per charge and a longer battery life, from the
// battery ledger and the machine's current state. Pure functions: every
// finding carries the evidence it rests on, and a rule without evidence
// says nothing.
//
// Engine layer; the preferences window gathers the inputs and shows the
// findings.

// Thresholds. An app is a background consumer when most of its CPU time
// was spent without focus and it took a noticeable part of the energy.
import { _, fill } from '../common/i18n.js';
const BACKGROUND_FRACTION = 0.6;
const BACKGROUND_MIN_SHARE = 0.05;
const BACKGROUND_MIN_WH = 0.2;
const BRIGHT_FRACTION = 0.8;
const WORN_HEALTH = 80;
const MOSTLY_PLUGGED = 0.8;
const MIN_TRACKED_HOURS = 1;
const HOT_FRACTION = 0.2;

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

/**
 * @param {object} input
 * @param {object} input.battery summary of the ledger on battery only (BatteryLedger.summarize)
 * @param {object} input.all summary of the ledger, AC and battery
 * @param {object} input.state current state of the machine:
 *   { battery: ?{ healthPct, cycles, fullWh, chargeLimit: 'unsupported'|'off'|'on' },
 *     backlight: ?number (0..1), powerProfile: ?string, onBattery: boolean, energyReadable: boolean }
 * @param {function(string): string} [input.appName] display name for an app id
 * @returns {Array<{id: string, goal: string, severity: string, title: string, detail: string,
 *   evidence: string, estimate: ?{watts: number, minutes: ?number}, action: ?object}>}
 *   goal is 'runtime' (per charge), 'lifespan' (of the battery) or 'data'; most important first
 */
export function diagnose({ battery, all, state, appName = id => id }) {
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
                goal: 'runtime',
                severity: 'suggestion',
                title: fill(_('{app} works in the background'), { app: appName(app.id) }),
                detail: _('Quit it when you are not using it, or check its settings for background activity.'),
                evidence: fill(_('{percent} % of its CPU time on battery was without focus: about {wh} Wh over {hours} h on battery.'),
                    { percent: Math.round(background * 100), wh: round1(backgroundWh), hours: round1(hoursOnBattery) }),
                estimate: { watts, minutes },
                action: null,
            });
        }
    }

    // Runtime: settings that cost energy on battery.
    if (state.battery && state.onBattery && state.powerProfile === 'performance') {
        findings.push({
            id: 'power-profile',
            goal: 'runtime',
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
            goal: 'runtime',
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
            goal: 'runtime',
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
            goal: 'lifespan',
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
                goal: 'lifespan',
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
                goal: 'lifespan',
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
            goal: 'data',
            severity: 'info',
            title: _('Power readings are not available'),
            detail: _('Apps are ranked by CPU time only. Enabling CPU power readings (Troubleshooting) gives energy figures.'),
            evidence: _('The CPU energy counters cannot be read by this user.'),
            estimate: null,
            action: null,
        });
    }

    const rank = { warning: 0, suggestion: 1, info: 2 };
    return findings.sort((x, y) => (rank[x.severity] - rank[y.severity]) ||
        ((y.estimate?.watts ?? 0) - (x.estimate?.watts ?? 0)));
}
