// Runs the battery ledger in the shell: one sample every 30 s whether the
// menu is open or not, focus time from the window tracker, and the ledger
// saved when an hour closes, when asked to, and when tracking stops.
//
// Shell-free on purpose: the focus source is handed in, so the tracker can
// be driven from tests.
import GLib from 'gi://GLib';

import { AppUsageSampler } from './appusage.js';
import { PowerSampler } from './power.js';
import { loadLedger, saveLedger } from './batteryledger.js';

export const TRACK_INTERVAL_S = 30;

export function ledgerPath() {
    return `${GLib.get_user_data_dir()}/resource-pulse/battery-history.json`;
}

function hourOf(wallMs) {
    const d = new Date(wallMs);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}

export class BatteryTracker {
    /**
     * @param {object} opts
     * @param {object} opts.battery a sampler with async sample() -> { present, state, energy }
     * @param {object} opts.focus { current(): ?string, connect(cb): handle, disconnect(handle) }
     * @param {string} [opts.path]
     * @param {AppUsageSampler} [opts.usage]
     * @param {PowerSampler} [opts.power] its own instance: power is averaged between its calls
     * @param {function(string)} [opts.onProblem]
     */
    constructor({ battery, focus, path = ledgerPath(), usage = new AppUsageSampler(), power = new PowerSampler(),
        onProblem = message => console.warn(`ResourcePulse: ${message}`) }) {
        this._battery = battery;
        this._focus = focus;
        this.path = path;
        this._usage = usage;
        this._power = power;
        this._onProblem = onProblem;
        this.ledger = null;
        this._timerId = 0;
        this._gen = 0;
        this._busy = false;
        this._savedHour = null;
        this._focusUsec = {};
        this._focusId = null;
        this._focusSince = 0;
        this._focusHandle = null;
        this.lastSample = null;
    }

    get running() {
        return this._timerId !== 0;
    }

    async start() {
        const gen = ++this._gen;
        const { ledger, problem } = await loadLedger(this.path);
        if (gen !== this._gen) return;
        if (problem) this._onProblem(problem);
        this.ledger = ledger;
        this._focusId = this._focus.current();
        this._focusSince = GLib.get_monotonic_time();
        this._focusHandle = this._focus.connect(() => this._noteFocus());
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TRACK_INTERVAL_S, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
        await this.tick();
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.forget] tracking was switched off: the next start
     *   must not report the time in between as a gap
     */
    async stop({ forget = false } = {}) {
        this._gen++;
        if (this._timerId) GLib.source_remove(this._timerId);
        this._timerId = 0;
        if (this._focusHandle !== null) this._focus.disconnect(this._focusHandle);
        this._focusHandle = null;
        if (!this.ledger) return;
        if (forget) this.ledger.forgetLast();
        await this.save();
    }

    _noteFocus() {
        const now = GLib.get_monotonic_time();
        if (this._focusId) this._focusUsec[this._focusId] = (this._focusUsec[this._focusId] ?? 0) + now - this._focusSince;
        this._focusId = this._focus.current();
        this._focusSince = now;
    }

    /** Take one sample now. Overlapping calls are dropped, not queued. */
    async tick() {
        if (this._busy || !this.ledger) return false;
        this._busy = true;
        const gen = this._gen;
        try {
            const [usage, power, battery] = await Promise.all([
                this._usage.sample(),
                this._power.sample(),
                this._battery.sample(),
            ]);
            if (gen !== this._gen) return false;
            this._noteFocus();
            const focusUsec = this._focusUsec;
            this._focusUsec = {};
            const wall = Date.now();
            const attributed = this.ledger.ingest({
                mono: GLib.get_monotonic_time(),
                wall,
                usage,
                packageW: power?.raplSupported ? power.packagePower : null,
                battery: battery?.present
                    ? { present: true, onBattery: battery.state === 'discharging', energyWh: battery.energy }
                    : null,
                focusUsec,
            });
            this.lastSample = { wall, attributed, appsAvailable: this._usage.available, energyAvailable: !!power?.raplSupported };
            if (this._savedHour !== hourOf(wall)) await this.save();
            return attributed;
        } catch (e) {
            this._onProblem(`battery tracking sample failed: ${e.message}`);
            return false;
        } finally {
            this._busy = false;
        }
    }

    async save() {
        if (!this.ledger) return;
        try {
            await saveLedger(this.path, this.ledger);
            this._savedHour = hourOf(Date.now());
        } catch (e) {
            this._onProblem(`cannot save ${this.path}: ${e.message}`);
        }
    }

    async clear() {
        this.ledger?.clear();
        await this.save();
    }
}
