// Short incident captures from the existing periodic poll. All times used for
// deltas and window boundaries are monotonic microseconds. The wall time is
// just the label of a completed capture.
export const INCIDENT_STEP_SECONDS = 2;
export const INCIDENT_PRE_SECONDS = 60;
export const INCIDENT_POST_SECONDS = 30;
export const INCIDENT_SLOTS = (INCIDENT_PRE_SECONDS + INCIDENT_POST_SECONDS) / INCIDENT_STEP_SECONDS + 1;
export const INCIDENT_LIMIT = 5;
export const INCIDENT_METRICS = ['cpu', 'memory', 'swap', 'disk', 'thermal', 'cpuWait', 'memoryWait', 'ioWait'];

const STEP_US = INCIDENT_STEP_SECONDS * 1e6;
const PRE_US = INCIDENT_PRE_SECONDS * 1e6;
const POST_US = INCIDENT_POST_SECONDS * 1e6;
const COOLDOWN_US = 120e6;
const PRE_SLOTS = INCIDENT_PRE_SECONDS / INCIDENT_STEP_SECONDS;
// Two extra slots keep the full prehistory when the trigger falls between slots.
const ROLLING_SLOTS = PRE_SLOTS + 2;
const METRIC_COUNT = INCIDENT_METRICS.length;
const PRESSURE_RESOURCES = ['cpu', 'memory', 'io'];
const PRESSURE_LIMITS = [25, 10, 10];
const MIN_STALL_US = 100000;

export class IncidentRecorder {
    constructor() {
        this.captures = [];
        this.active = null;
        this._values = new Float64Array(ROLLING_SLOTS * METRIC_COUNT);
        this._times = new Float64Array(this._values.length).fill(-Infinity);
        this._pressure = new Float64Array(PRESSURE_RESOURCES.length).fill(NaN);
        this._pressureAt = null;
        this._above = 0;
        this._nextAuto = 0;
    }

    restore(captures) {
        this.captures = [...this.captures, ...captures].slice(0, INCIDENT_LIMIT);
    }

    startManual(now, wall) {
        return this._start('manual', now, wall);
    }

    _start(trigger, now, wall) {
        if (this.active) return false;
        this.active = {
            at: wall,
            trigger,
            start: now,
            end: now + POST_US,
            rows: Array.from({ length: INCIDENT_SLOTS }, () => new Array(METRIC_COUNT).fill(null)),
        };
        this._nextAuto = this.active.end + COOLDOWN_US;
        for (let i = 0; i < this._values.length; i++)
            this._append(i % METRIC_COUNT, this._values[i], this._times[i]);
        return true;
    }

    _append(metric, value, at) {
        const capture = this.active;
        if (at < capture.start - PRE_US || at > capture.end) return;
        const row = capture.rows[PRE_SLOTS + Math.round((at - capture.start) / STEP_US)];
        if (row[metric] === null || value > row[metric]) row[metric] = value;
    }

    _record(metric, value, at, now) {
        if (!Number.isFinite(value) || !Number.isFinite(at) || at < 0 || at > now) return;
        if (this.active) this._append(metric, value, at);
        if (now - at > PRE_US) return;
        const slot = Math.floor(at / STEP_US);
        const i = (slot % ROLLING_SLOTS) * METRIC_COUNT + metric;
        const oldSlot = Math.floor(this._times[i] / STEP_US);
        if (slot > oldSlot || (slot === oldSlot && value >= this._values[i])) {
            this._times[i] = at;
            this._values[i] = value;
        }
    }

    _recordPressure(psi, at, now, maxGapUs) {
        if (!psi?.totals || !Number.isFinite(at) || at > now) {
            this._pressureAt = null;
            this._above = 0;
            return null;
        }
        if (this._pressureAt !== null && at <= this._pressureAt) return null;
        const dt = this._pressureAt === null ? 0 : at - this._pressureAt;
        const continuous = dt > 0 && dt <= maxGapUs;
        let trigger = null;
        let strongest = 0;
        for (let i = 0; i < PRESSURE_RESOURCES.length; i++) {
            const resource = PRESSURE_RESOURCES[i];
            const total = psi.totals[resource]?.some;
            const delta = Number.isFinite(total) ? total - this._pressure[i] : NaN;
            this._pressure[i] = Number.isFinite(total) ? total : NaN;
            const bit = 1 << i;
            if (!continuous || !(delta >= 0 && delta <= dt)) {
                this._above &= ~bit;
                continue;
            }
            const share = delta / dt * 100;
            this._record(5 + i, share, at, now);
            const limit = PRESSURE_LIMITS[i];
            if (share < limit / 2) this._above &= ~bit;
            if (share < limit || delta < MIN_STALL_US || (this._above & bit)) continue;
            this._above |= bit;
            const strength = share / limit;
            if (strength > strongest) {
                strongest = strength;
                trigger = resource;
            }
        }
        this._pressureAt = at;
        return trigger;
    }

    /** Consume a raw periodic snapshot. Returns a capture once it completes. */
    observe(data, now, wall, maxGapUs) {
        const { cpu, mem, dsk, thm, psi } = data.samples;
        if (cpu.fresh && data.cpu.cores?.length) this._record(0, data.cpu.total, cpu.sampledAt, now);
        if (mem.fresh && data.mem.total > 0) {
            this._record(1, data.mem.percent, mem.sampledAt, now);
            if (data.mem.swapTotal > 0) this._record(2, data.mem.swapPercent, mem.sampledAt, now);
        }
        if (dsk.fresh && data.dsk.ioSampled) this._record(3, data.dsk.diskPercent, dsk.sampledAt, now);
        if (thm.fresh && data.thm.packageTemp > 0) this._record(4, data.thm.packageTemp, thm.sampledAt, now);
        const trigger = this._recordPressure(psi.fresh ? data.psi : null, psi.sampledAt, now, maxGapUs);
        if (trigger && !this.active && now >= this._nextAuto && now - psi.sampledAt < POST_US)
            this._start(trigger, psi.sampledAt, Math.round(wall - (now - psi.sampledAt) / 1000));
        return this.finish(now);
    }

    /** Complete even when a long polling interval leaves the deadline between polls. */
    finish(now) {
        if (!this.active || now < this.active.end) return null;
        const { at, trigger: reason, rows } = this.active;
        this.active = null;
        const capture = { at, trigger: reason, intervalSeconds: INCIDENT_STEP_SECONDS, rows };
        this.captures.unshift(capture);
        if (this.captures.length > INCIDENT_LIMIT) this.captures.pop();
        return capture;
    }
}
