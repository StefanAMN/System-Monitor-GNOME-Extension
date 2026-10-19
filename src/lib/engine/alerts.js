// Sustained-threshold alerts. Engine layer: consumes the poll's readings and
// decides which metrics are in danger; the panel and notifications only read
// its result.
//
// A metric becomes active once it has stayed at or above its threshold for
// SUSTAIN_US, and clears once it has stayed HYSTERESIS points below the
// threshold for RECOVER_US, so a value hovering at the line does not flap.
// All times are monotonic microseconds.
import { _, fill } from '../common/i18n.js';

export const SUSTAIN_US = 30e6;
export const RECOVER_US = 10e6;
export const HYSTERESIS = 5;
// One notification per metric at most this often.
export const NOTIFY_GAP_US = 10 * 60e6;

export class AlertMonitor {
    constructor({ sustainUs = SUSTAIN_US, recoverUs = RECOVER_US, hysteresis = HYSTERESIS, notifyGapUs = NOTIFY_GAP_US } = {}) {
        this._sustainUs = sustainUs;
        this._recoverUs = recoverUs;
        this._hysteresis = hysteresis;
        this._notifyGapUs = notifyGapUs;
        // key -> { aboveSince, belowSince, active, since, value, threshold }
        this._state = new Map();
        this._notified = new Map();
    }

    /**
     * Feed one set of readings.
     * @param {Object<string, ?{value: number, threshold: number}>} readings
     *   null (or a non-finite value) means the metric cannot be read now: it
     *   never alerts and an active alert on it clears.
     * @param {number} now monotonic µs
     * @returns {{raised: string[], cleared: string[]}} changes since the last call
     */
    update(readings, now) {
        const raised = [];
        const cleared = [];
        for (const [key, reading] of Object.entries(readings)) {
            let s = this._state.get(key);
            if (!s) {
                s = { aboveSince: null, belowSince: null, active: false, since: 0, value: 0, threshold: 0 };
                this._state.set(key, s);
            }
            if (!reading || !Number.isFinite(reading.value) || !Number.isFinite(reading.threshold)) {
                s.aboveSince = s.belowSince = null;
                if (s.active) {
                    s.active = false;
                    cleared.push(key);
                }
                continue;
            }
            const { value, threshold } = reading;
            s.value = value;
            s.threshold = threshold;
            if (!s.active) {
                s.aboveSince = value >= threshold ? (s.aboveSince ?? now) : null;
                if (s.aboveSince !== null && now - s.aboveSince >= this._sustainUs) {
                    s.active = true;
                    s.since = s.aboveSince;
                    s.belowSince = null;
                    raised.push(key);
                }
            } else {
                s.belowSince = value < threshold - this._hysteresis ? (s.belowSince ?? now) : null;
                if (s.belowSince !== null && now - s.belowSince >= this._recoverUs) {
                    s.active = false;
                    s.aboveSince = null;
                    s.belowSince = null;
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
 * @param {object} data the poll snapshot (cpu, mem, thm, gpu, dsk, psi)
 * @param {object} limits thresholds: cpu, memory, thermal (°C), gpu, disk, pressure
 * @param {function(object): boolean} thermalUnavailable
 */
export function alertReadings(data, limits, thermalUnavailable) {
    const reading = (ok, value, threshold) => ok ? { value, threshold } : null;
    const root = data.dsk?.mounts?.[0];
    return {
        cpu: reading(!!data.cpu, data.cpu?.total, limits.cpu),
        memory: reading(!!data.mem && data.mem.total > 0, data.mem?.percent, limits.memory),
        thermal: reading(!!data.thm && !thermalUnavailable(data.thm), data.thm?.packageTemp, limits.thermal),
        gpu: reading(!!data.gpu?.present && data.gpu.percent !== null, data.gpu?.percent, limits.gpu),
        disk: reading(!!root, root?.percent, limits.disk),
        // The share of time some program waited for memory: the same figure
        // the Memory page shows.
        pressure: reading(Number.isFinite(data.psi?.memory?.some), data.psi?.memory?.some, limits.pressure),
    };
}

/** "CPU 97 % for 1 min" */
export function alertLine(alert, now, { name, format }) {
    const minutes = Math.max(1, Math.round((now - alert.since) / 60e6));
    // Translators: an alert, such as "CPU 97 % for 3 min".
    return fill(_('{name} {value} for {minutes} min'), { name, value: format(alert.value), minutes });
}
