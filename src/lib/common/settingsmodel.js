// The user-facing settings, described once: the panel menu's settings page
// and the preferences window are both built from this list, so their labels,
// order, choices and step sizes cannot drift apart. Pure data and pure
// helpers; nothing here touches a widget or GSettings.
import { formatTemp } from './format.js';
import { N_ } from './i18n.js';

/**
 * The metrics that can be pinned to the top bar, in their default order.
 * icon: symbolic icon from the theme; bundled: an icon of the extension's
 * icons/ directory used instead (thermal: no theme has one) or when the
 * theme lacks the icon (cpu).
 */
export const METRICS = [
    { key: 'cpu', name: N_('CPU'), icon: 'utilities-system-monitor-symbolic', bundled: 'rp-cpu' },
    { key: 'memory', name: N_('Memory'), icon: 'media-flash-symbolic' },
    { key: 'battery', name: N_('Battery'), icon: 'battery-good-symbolic' },
    { key: 'power', name: N_('Power'), icon: 'thunderbolt-symbolic' },
    { key: 'disk', name: N_('Disk'), icon: 'drive-harddisk-symbolic' },
    { key: 'network', name: N_('Network'), icon: 'network-transmit-receive-symbolic' },
    { key: 'thermal', name: N_('Thermal'), icon: null, bundled: 'rp-thermal' },
    // Some icon themes (Tela) ship this name as a colour-scheme SVG GTK
    // cannot recolour: the bundled card is used first.
    { key: 'gpu', name: N_('GPU'), icon: 'video-display-symbolic', bundled: 'rp-gpu', bundledFirst: true },
];

/**
 * Row kinds:
 *   pins    the pinned-metrics list (key is an `as` setting)
 *   switch  a boolean
 *   choice  a string with a fixed set of values: choices = [[value, label, longLabel, segment], ...];
 *           segment is the label of its button in the window's segmented control
 *   number  an integer with min / max (the schema's range) and the step of
 *           one click; unit is 's', '%' or 'temp' (stored in °C)
 * `metric` names the metric a row is about (its icon beside the row).
 * `title` is short enough for the 360 px panel; `detail` is the longer
 * explanation the preferences window has room for. Labels are marked with
 * N_() and translated where they are shown; keys and values are not.
 */
export const SETTINGS_SECTIONS = [
    {
        id: 'topbar',
        title: N_('Top bar'),
        rows: [
            {
                key: 'pinned-metrics', kind: 'pins', title: N_('Pinned metrics'), hint: N_('numbered in top-bar order'),
                detail: N_('Shown permanently in the top bar. When they do not all fit, the last ones show only their icon.'),
            },
            {
                key: 'compact-label', kind: 'switch', title: N_('Compact (icons only)'),
                detail: N_('Hide the values in the top bar and show only the icons'),
            },
            {
                key: 'show-tooltips', kind: 'switch', title: N_('Tooltips'),
                detail: N_('Show details when the pointer rests on a metric in the top bar'),
            },
            {
                key: 'battery-top-format', kind: 'choice', title: N_('Battery shows'),
                detail: N_('What the battery metric displays in the top bar'),
                choices: [
                    ['percent', '%', N_('Percentage (85%)'), '85%'],
                    ['percent-time', '% + time', N_('Percentage and time (85% · 2h 15m)'), '85% · 2h 15m'],
                ],
            },
            {
                key: 'network-top-format', kind: 'choice', title: N_('Network shows'),
                detail: N_('What the network metric displays in the top bar'),
                choices: [
                    ['download', '↓', N_('Download (↓)'), N_('↓ Download')],
                    ['upload', '↑', N_('Upload (↑)'), N_('↑ Upload')],
                    ['both', '↓ ↑', N_('Download and upload (↓ ↑)'), N_('↓ ↑ Both')],
                ],
            },
        ],
    },
    {
        id: 'units',
        title: N_('Units and refresh'),
        rows: [
            {
                key: 'poll-interval', kind: 'number', title: N_('Update every'),
                detail: N_('Seconds between two readings (1 to 10)'),
                min: 1, max: 10, step: 1, unit: 's',
            },
            {
                key: 'smooth-transitions', kind: 'switch', title: N_('Smooth changes'),
                detail: N_('Values glide to each new reading over one update; CPU, GPU, network and disk are lightly averaged'),
            },
            {
                key: 'unit-temp', kind: 'choice', title: N_('Temperature'),
                detail: N_('Unit for every temperature shown'),
                choices: [['C', '°C', N_('Celsius (°C)'), '°C'], ['F', '°F', N_('Fahrenheit (°F)'), '°F']],
            },
            {
                key: 'unit-mem', kind: 'choice', title: N_('Memory'),
                detail: N_('Decimal gigabytes or binary gibibytes'),
                choices: [['GB', 'GB', N_('Gigabytes (GB)'), 'GB'], ['GiB', 'GiB', N_('Gibibytes (GiB)'), 'GiB']],
            },
        ],
    },
    {
        id: 'alerts',
        title: N_('Alerts'),
        hint: N_('a value that stays above its limit for 30 seconds shows ⚠ in the top bar'),
        rows: [
            {
                key: 'alert-notify', kind: 'switch', title: N_('Notifications'),
                detail: N_('Also send a notification, at most one per metric every 10 minutes'),
            },
            {
                key: 'threshold-cpu', kind: 'number', metric: 'cpu', title: N_('CPU'),
                detail: N_('CPU usage above this is shown as a warning'),
                min: 50, max: 100, step: 5, unit: '%',
            },
            {
                key: 'threshold-mem', kind: 'number', metric: 'memory', title: N_('Memory'),
                detail: N_('Memory usage above this is shown as a warning'),
                min: 50, max: 100, step: 5, unit: '%',
            },
            {
                key: 'threshold-temp', kind: 'number', metric: 'thermal', title: N_('Temperature'),
                detail: N_('CPU temperature above this is shown as a warning (stored in °C)'),
                min: 40, max: 100, step: 5, unit: 'temp',
            },
            {
                key: 'threshold-gpu', kind: 'number', metric: 'gpu', title: N_('GPU'),
                detail: N_('GPU usage above this is shown as a warning'),
                min: 50, max: 100, step: 5, unit: '%',
            },
            {
                key: 'threshold-disk', kind: 'number', metric: 'disk', title: N_('Disk space'),
                detail: N_('Space used on / above this is shown as a warning'),
                min: 50, max: 100, step: 1, unit: '%',
            },
        ],
    },
];

/** Every row of every section, in display order. */
export function allSettingRows() {
    return SETTINGS_SECTIONS.flatMap(section => section.rows);
}

/**
 * A number row's value as the user reads it.
 * @param {object} row a `number` row
 * @param {number} value the stored value
 * @param {string} tempUnit 'C' or 'F', for rows whose unit is 'temp'
 */
export function formatSettingValue(row, value, tempUnit = 'C') {
    if (row.unit === 'temp') return formatTemp(value, tempUnit);
    if (row.unit === 's') return `${value} s`;
    return `${value}${row.unit ?? ''}`;
}

/**
 * The value one click on a stepper leads to. The stored value need not be a
 * multiple of the step (the preferences window allows any value in range),
 * so this clamps to the range instead of assuming a grid.
 * @param {object} row a `number` row
 * @param {number} value the stored value
 * @param {number} direction +1 or -1
 */
export function stepSettingValue(row, value, direction) {
    return Math.max(row.min, Math.min(row.max, value + direction * row.step));
}

/**
 * Position (1-based) of each pinned metric in the top bar, 0 when unpinned.
 * @param {string[]} pinned the sanitised pinned list
 * @returns {Object<string, number>}
 */
export function pinPositions(pinned) {
    const positions = {};
    for (const { key } of METRICS) positions[key] = pinned.indexOf(key) + 1;
    return positions;
}

/**
 * The pinned list after toggling one metric: removed if present, appended
 * (last in the top bar, first to lose its label) otherwise.
 */
export function togglePinned(pinned, key) {
    return pinned.includes(key) ? pinned.filter(k => k !== key) : [...pinned, key];
}

/**
 * The pinned list with `key` placed at `index` (0: first in the top bar),
 * counted in the list without `key`; pinned if it was not. An index past
 * the end places it last.
 * @param {string[]} pinned
 * @param {string} key
 * @param {number} index
 */
export function movePinned(pinned, key, index) {
    const rest = pinned.filter(k => k !== key);
    const at = Math.max(0, Math.min(rest.length, Math.trunc(index)));
    return [...rest.slice(0, at), key, ...rest.slice(at)];
}
