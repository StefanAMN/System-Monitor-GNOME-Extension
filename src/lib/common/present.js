// Pure presentation helpers: decide what a snapshot should look like without
// touching any widget, so they can be unit-tested under plain gjs.
import { formatTemp } from './format.js';
import { METRICS } from './settingsmodel.js';

export const METRIC_KEYS = METRICS.map(m => m.key);

/**
 * A stored metric list (pinned metrics) reduced to known keys, each once,
 * in the stored order. GSettings accepts any strings in an `as` key.
 * @param {string[]} list
 */
export function sanitizeMetricList(list) {
    const out = [];
    for (const key of list || []) {
        if (METRIC_KEYS.includes(key) && !out.includes(key)) out.push(key);
    }
    return out;
}

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
 * Tooltip for the GPU metric. Integrated GPUs report neither dedicated
 * memory nor a temperature; those parts are left out rather than shown as
 * "0%" and "0°C".
 * @param {object} gpu collector snapshot
 * @param {string} tempUnit 'C' or 'F'
 */
export function gpuTooltip(gpu, tempUnit = 'C') {
    if (!gpu || !gpu.present) return 'GPU not available\nNo supported GPU was detected.';
    const extra = [];
    if (gpu.memTotal > 0) extra.push(`VRAM: ${Math.round(gpu.memPercent)}%`);
    if (gpu.temp > 0) extra.push(`Temp: ${formatTemp(gpu.temp, tempUnit)}`);
    const head = `${gpu.brand || 'GPU'}: ${Math.round(gpu.percent)}%`;
    return extra.length > 0 ? `${head}\n${extra.join(' · ')}` : head;
}

/**
 * What a GPU reports besides its load, as shown; null where it reports
 * nothing (integrated GPUs have no fan, power or often temperature reading),
 * so the UI can leave the field out instead of showing a placeholder.
 * @param {object} gpu collector reading
 * @param {string} tempUnit 'C' or 'F'
 * @returns {{clock: ?string, temp: ?string, fan: ?string, power: ?string}}
 */
export function gpuReadings(gpu, tempUnit = 'C') {
    let clock = null;
    if (gpu.clock > 0) {
        clock = gpu.maxClock > 0
            ? `${Math.round(gpu.clock)} / ${Math.round(gpu.maxClock)} MHz`
            : `${Math.round(gpu.clock)} MHz`;
    }
    return {
        clock,
        temp: gpu.temp > 0 ? formatTemp(gpu.temp, tempUnit) : null,
        // 0 RPM is a reading (the fan is stopped); only "no fan" is left out.
        fan: Number.isFinite(gpu.fanSpeed) ? `${gpu.fanSpeed} RPM` : null,
        power: gpu.powerDraw > 0 ? `${gpu.powerDraw.toFixed(1)} W` : null,
    };
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
    // Sized for the widest value that normally occurs, not the widest that
    // is conceivable: reserving for "100%" or "000.0W" left a visible gap
    // before the next metric. A rarer, wider value simply grows the label.
    switch (key) {
    case 'battery':
        // A full battery is the normal state on AC, so 100% must fit. The
        // time estimate comes and goes; reserving for it left a wide empty
        // gap before the next metric whenever it was absent.
        return '100%';
    case 'power':
        // Draw rarely crosses 10 W back and forth, so one integer digit:
        // a second one would sit empty on most laptops most of the time.
        return '9.9W';
    case 'thermal':
        return opts.tempUnit === 'F' ? '199°F' : '99°C';
    case 'network':
        return opts.netFmt === 'both' ? '↓999 KB/s ↑999 KB/s' : '↓ 999 KB/s';
    default:
        return '99%';
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

/**
 * Which history sample lies under pointer position x in a right-aligned
 * time series (newest sample at the right edge).
 * @returns {number} index into the history (0 = oldest) or -1 if none
 */
export function hoverIndex(x, padLeft, graphWidth, capacity, length) {
    if (length < 1 || capacity < 2 || !(graphWidth > 0)) return -1;
    const step = graphWidth / (capacity - 1);
    const fromRight = Math.round((padLeft + graphWidth - x) / step);
    if (fromRight < 0 || fromRight > length - 1) return -1;
    return length - 1 - fromRight;
}

/** "now", "14s ago", "1m 20s ago" for a sample `samplesBack` ticks old. */
export function agoLabel(samplesBack, sampleSeconds) {
    const t = Math.round(samplesBack * sampleSeconds);
    if (t <= 0) return 'now';
    if (t < 60) return `${t}s ago`;
    if (t >= 3600) {
        const m = Math.floor((t % 3600) / 60);
        return m ? `${Math.floor(t / 3600)}h ${m}m ago` : `${Math.floor(t / 3600)}h ago`;
    }
    const s = t % 60;
    return s ? `${Math.floor(t / 60)}m ${s}s ago` : `${Math.floor(t / 60)}m ago`;
}

/**
 * A value as the panel prints it, in words a screen reader says well: the
 * placeholders as what they mean, arrows as download / upload, rates "per
 * second", watts and hours spelled out.
 * @param {string} text  e.g. "7%", "↓1.2 MB/s ↑30 KB/s", "85% · 2h 10m", "n/a"
 */
export function spokenValue(text) {
    if (!text || text.startsWith('--')) return 'no reading yet';
    if (text === 'n/a') return 'not available';
    const unit = (n, one, many) => `${n} ${n === '1' ? one : many}`;
    return text
        .replace(/\s*·\s*/g, ', ')
        .replace(/\b(\d+)h (\d+)m\b/g, (_m, h, m) => (h === '0' ? unit(m, 'minute', 'minutes') : `${unit(h, 'hour', 'hours')} ${unit(m, 'minute', 'minutes')}`))
        .replace(/\s*↓\s*/g, (_m, at) => (at > 0 ? ', download ' : 'download '))
        .replace(/\s*↑\s*/g, (_m, at) => (at > 0 ? ', upload ' : 'upload '))
        .replace(/([KMGT]?i?B)\/s\b/g, '$1 per second')
        .replace(/(\d)\s?W\b/g, '$1 watts')
        .replace(/\s+/g, ' ')
        .trim();
}
