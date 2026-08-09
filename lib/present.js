// Pure presentation helpers: decide what a snapshot should look like without
// touching any widget, so they can be unit-tested under plain gjs.

/**
 * What to show for power draw.
 * value is null when nothing on this machine can measure it right now.
 * @returns {{value: number|null, source: string, reason: string}}
 */
export function powerReadout(pwr) {
    if (!pwr) return { value: null, source: '', reason: 'Not sampled yet' };
    if (pwr.systemPower !== null && pwr.systemPower !== undefined)
        return { value: pwr.systemPower, source: 'On Battery', reason: '' };
    if (pwr.raplSupported)
        return { value: pwr.packagePower || 0, source: 'AC · CPU package only', reason: '' };
    return {
        value: null,
        source: '',
        reason: 'CPU energy counters are not readable.\nSee "Enable CPU Power Monitoring" in settings.'
    };
}

/** True when the thermal collector found no usable sensor. */
export function thermalUnavailable(thm) {
    return !thm || (!(thm.packageTemp > 0) && (!thm.sensors || thm.sensors.length === 0));
}

/**
 * Symbolic icon for a battery level, matching GNOME's own indicator.
 * @param {number} percent
 * @param {string} state collector state string
 */
export function batteryIconName(percent, state) {
    if (!(percent >= 0)) return 'battery-missing-symbolic';
    const level = Math.max(0, Math.min(100, Math.round(percent / 10) * 10));
    if (state === 'full' || (state === 'not charging' && level === 100))
        return 'battery-level-100-charged-symbolic';
    return `battery-level-${level}${state === 'charging' ? '-charging' : ''}-symbolic`;
}

/**
 * Widest text a top-bar metric can show. The label reserves this width so the
 * panel does not shift as values change.
 */
export function labelTemplate(key, opts = {}) {
    switch (key) {
    case 'cpu':
    case 'memory':
    case 'disk':
    case 'gpu':
        return '100%';
    case 'battery':
        return opts.batFmt === 'percent-time' ? '100% · 00h 00m' : '100%';
    case 'power':
        return '000.0W';
    case 'thermal':
        return opts.tempUnit === 'F' ? '000°F' : '000°C';
    case 'network':
        return opts.netFmt === 'both' ? '↓000.0 KB/s ↑000.0 KB/s' : '↓ 000.0 KB/s';
    default:
        return '100%';
    }
}

/**
 * Interfaces worth a row: every physical one, plus any virtual one that is
 * actually moving data.
 * @param {Object<string, {isVirtual: boolean, rxRate: number, txRate: number}>} interfaces
 * @returns {[string, object][]}
 */
export function visibleInterfaces(interfaces) {
    return Object.entries(interfaces || {}).filter(([, iface]) =>
        !iface.isVirtual || iface.rxRate > 100 || iface.txRate > 100);
}

/**
 * Full-scale value for a bar with no natural maximum (watts, bytes/s).
 * Jumps up to a new peak at once and decays back towards `floor` with the
 * given half-life, so the bar stays readable after a burst.
 */
export class PeakScale {
    constructor(floor, halfLifeSeconds = 60) {
        this._floor = floor;
        this._halfLife = halfLifeSeconds;
        this._peak = floor;
        this._time = 0;
    }

    /**
     * @param {number} value current reading
     * @param {number} nowUs monotonic time in microseconds
     * @returns {number} the scale to divide by, never below the floor
     */
    update(value, nowUs) {
        if (this._time > 0 && nowUs > this._time) {
            const dt = (nowUs - this._time) / 1000000;
            this._peak = this._floor + (this._peak - this._floor) * Math.pow(0.5, dt / this._halfLife);
        }
        this._time = nowUs;
        if (value > this._peak) this._peak = value;
        return this._peak;
    }

    percent(value, nowUs) {
        const scale = this.update(value, nowUs);
        return Math.max(0, Math.min(100, (value / scale) * 100));
    }
}
