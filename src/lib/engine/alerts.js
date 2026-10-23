// Sustained-threshold alerts. Engine layer: consumes the poll's readings and
// decides which metrics are in danger; the panel and notifications only read
// its result.
//
// A metric becomes active once it has stayed at or above its threshold for
// SUSTAIN_US, and clears once it has stayed HYSTERESIS points below the
// threshold for RECOVER_US, so a value hovering at the line does not flap.
// A clear drop, DEEP_DROP points or more below the threshold, clears after
// DEEP_RECOVER_US instead: memory falling from 95 % to 60 % against 90 %
// must not keep the warning on a value that reads 60 % for ten seconds.
// All times are monotonic microseconds.
import { _, fill } from '../common/i18n.js';

export const SUSTAIN_US = 30e6;
export const RECOVER_US = 10e6;
export const HYSTERESIS = 5;
export const DEEP_DROP = 3 * HYSTERESIS;
// Two readings at the default 2 s interval: one low reading is not a recovery.
export const DEEP_RECOVER_US = 2e6;
// One notification per metric at most this often.
export const NOTIFY_GAP_US = 10 * 60e6;

export class AlertMonitor {
    constructor({ sustainUs = SUSTAIN_US, recoverUs = RECOVER_US, hysteresis = HYSTERESIS, notifyGapUs = NOTIFY_GAP_US,
        deepDrop = DEEP_DROP, deepRecoverUs = DEEP_RECOVER_US } = {}) {
        this._sustainUs = sustainUs;
        this._recoverUs = recoverUs;
        this._hysteresis = hysteresis;
        this._deepDrop = deepDrop;
        this._deepRecoverUs = deepRecoverUs;
        this._notifyGapUs = notifyGapUs;
        // key -> { aboveSince, belowSince, deepSince, active, since, value, threshold }
        this._state = new Map();
        this._notified = new Map();
    }

    /**
     * Feed one set of readings.
     * @param {Object<string, ?{value: number, threshold: number, below?: boolean}>} readings
     *   null (or a non-finite value) means the metric cannot be read now: it
     *   never alerts and an active alert on it clears. `below`: the value is in
     *   danger at or under its threshold (the battery's charge), not over it.
     * @param {number} now monotonic µs
     * @returns {{raised: string[], cleared: string[]}} changes since the last call
     */
    update(readings, now) {
        const raised = [];
        const cleared = [];
        for (const [key, reading] of Object.entries(readings)) {
            let s = this._state.get(key);
            if (!s) {
                s = { aboveSince: null, belowSince: null, deepSince: null, active: false, since: 0, value: 0, threshold: 0 };
                this._state.set(key, s);
            }
            if (!reading || !Number.isFinite(reading.value) || !Number.isFinite(reading.threshold)) {
                s.aboveSince = s.belowSince = s.deepSince = null;
                if (s.active) {
                    s.active = false;
                    cleared.push(key);
                }
                continue;
            }
            // A reading in danger below its threshold is compared mirrored:
            // the same rules then hold for both directions.
            const sign = reading.below ? -1 : 1;
            const value = sign * reading.value;
            const threshold = sign * reading.threshold;
            s.value = reading.value;
            s.threshold = reading.threshold;
            if (!s.active) {
                s.aboveSince = value >= threshold ? (s.aboveSince ?? now) : null;
                if (s.aboveSince !== null && now - s.aboveSince >= this._sustainUs) {
                    s.active = true;
                    s.since = s.aboveSince;
                    s.belowSince = s.deepSince = null;
                    raised.push(key);
                }
            } else {
                s.belowSince = value < threshold - this._hysteresis ? (s.belowSince ?? now) : null;
                s.deepSince = value <= threshold - this._deepDrop ? (s.deepSince ?? now) : null;
                const recovered = (s.belowSince !== null && now - s.belowSince >= this._recoverUs) ||
                    (s.deepSince !== null && now - s.deepSince >= this._deepRecoverUs);
                if (recovered) {
                    s.active = false;
                    s.aboveSince = s.belowSince = s.deepSince = null;
                    cleared.push(key);
                }
            }
        }
        return { raised, cleared };
    }

    /** Active alerts, oldest first: [{key, value, threshold, since}]. */
    active() {
        const out = [];
        for (const [key, s] of this._state) {
            if (s.active) out.push({ key, value: s.value, threshold: s.threshold, since: s.since });
        }
        return out.sort((a, b) => a.since - b.since);
    }

    isActive(key) {
        return this._state.get(key)?.active ?? false;
    }

    /**
     * Whether a notification for this metric may be sent now; records it if so.
     * @param {string} key
     * @param {number} now monotonic µs
     */
    takeNotification(key, now) {
        const last = this._notified.get(key);
        if (last !== undefined && now - last < this._notifyGapUs) return false;
        this._notified.set(key, now);
        return true;
    }

    clear() {
        this._state.clear();
        this._notified.clear();
    }
}

/**
 * The readings the alerts watch, from one poll's data.
 * @param {object} data the poll snapshot (cpu, mem, thm, gpu, dsk, psi, bat, throttle)
 * @param {object} limits thresholds: cpu, memory, thermal (°C), gpu, disk, pressure, battery (%), throttle (% of the time)
 * @param {function(object): boolean} thermalUnavailable
 */
export function alertReadings(data, limits, thermalUnavailable) {
    const reading = (ok, value, threshold, below = false) => (ok ? { value, threshold, ...(below ? { below } : {}) } : null);
    const root = data.dsk?.mounts?.[0];
    return {
        cpu: reading(!!data.cpu, data.cpu?.total, limits.cpu),
        memory: reading(!!data.mem && data.mem.total > 0, data.mem?.percent, limits.memory),
        thermal: reading(!!data.thm && !thermalUnavailable(data.thm), data.thm?.packageTemp, limits.thermal),
        // The busiest awake GPU: the one shown may trail it by a few points.
        gpu: reading(!!data.gpu?.present && data.gpu.percent !== null, busiestGpu(data.gpu), limits.gpu),
        disk: reading(!!root, root?.percent, limits.disk),
        // The share of time some program waited for memory: the same figure
        // the Memory page shows.
        pressure: reading(Number.isFinite(data.psi?.memory?.some), data.psi?.memory?.some, limits.pressure),
        // The charge, only while it runs on battery: plugged in, it cannot run out.
        battery: reading(!!data.bat?.present && data.bat.state === 'discharging' && Number.isFinite(data.bat.percent) && Number.isFinite(limits.battery),
            data.bat?.percent, limits.battery, true),
        // The share of time the processor was slowed down to cool; not read on
        // processors that do not report it (AMD).
        throttle: reading(Number.isFinite(data.throttle?.percent) && Number.isFinite(limits.throttle), data.throttle?.percent, limits.throttle),
    };
}

/** Load of the busiest GPU that is awake (a machine may have several). */
function busiestGpu(gpu) {
    const awake = (gpu?.gpus ?? []).filter(g => !g.asleep);
    return awake.length ? Math.max(...awake.map(g => g.percent)) : gpu?.percent;
}

/** "CPU 97 % for 1 min" */
export function alertLine(alert, now, { name, format }) {
    const minutes = Math.max(1, Math.round((now - alert.since) / 60e6));
    // Translators: an alert, such as "CPU 97 % for 3 min".
    return fill(_('{name} {value} for {minutes} min'), { name, value: format(alert.value), minutes });
}
