// The preferences window's Tracking page: the switch that starts usage
// tracking, the history, and per component (battery, processor, memory,
// disk, network, graphics, temperature) the figures over a period, a chart
// and the apps that used it most. GTK side (preferences process); never
// imported by the shell.
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import PangoCairo from 'gi://PangoCairo';

import { BatteryLedger, LedgerFormatError, DAYS_KEPT } from '../../lib/engine/batteryledger.js';
import { ledgerPath, TRACK_INTERVAL_S } from '../../lib/engine/batterytracker.js';
import { COMPONENTS, componentView, bars, stepFor, fineFrom, zoomAbout, clampRange } from '../../lib/engine/trackingview.js';
import { appInfo } from '../../lib/common/appnames.js';
import { formatDuration, formatBytes, formatTemp } from '../../lib/common/format.js';
import { _, fill, ngettext } from '../../lib/common/i18n.js';
import { METRIC_COLORS } from './style.js';

const HOUR_MS = 3600 * 1000;
const APPS_SHOWN = 15;

export const PERIODS = [
    { id: 'day', label: () => _('Last 24 hours'), from: now => now - 24 * HOUR_MS },
    { id: 'today', label: () => _('Today'), from: now => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() },
    { id: 'week', label: () => _('Last 7 days'), from: now => now - 7 * 24 * HOUR_MS },
    { id: 'all', label: () => fill(ngettext('Last {n} day', 'Last {n} days', DAYS_KEPT), { n: DAYS_KEPT }), from: now => now - DAYS_KEPT * 24 * HOUR_MS },
];

/** "1.24 Wh" / "320 mWh". */
export function formatWh(wh) {
    if (!(wh > 0)) return '0 Wh';
    return wh < 1 ? `${Math.round(wh * 1000)} mWh` : `${wh.toFixed(wh < 10 ? 2 : 1)} Wh`;
}

/** CPU time in µs as "3h 05m", "12 min" or "40 s". */
export function formatCpu(usec) {
    const s = usec / 1e6;
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return formatDuration(s);
}

function startOfHour(ms) {
    return new Date(new Date(ms).setMinutes(0, 0, 0)).getTime();
}

/**
 * The ledger as the extension last saved it. Asks the extension to save
 * (action-flush-history) and reloads when the file changes. Shared by the
 * Tracking and Diagnostics pages.
 */
export class HistorySource {
    constructor(settings, path = ledgerPath()) {
        this._settings = settings;
        this.path = path;
        this.ledger = new BatteryLedger();
        this.problem = null;
        this._listeners = new Set();
        this._reloadId = 0;
        this._monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorId = this._monitor.connect('changed', () => this._queueReload());
    }

    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** Ask the extension for current figures; the file monitor picks them up. */
    requestFlush() {
        if (this._settings.get_boolean('battery-tracking')) this._settings.set_boolean('action-flush-history', true);
    }

    _queueReload() {
        if (this._reloadId) return;
        // Coalesce the bursts a replace produces.
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._reloadId = 0;
            this.reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    reload() {
        let text = null;
        try {
            const [, bytes] = GLib.file_get_contents(this.path);
            text = new TextDecoder().decode(bytes);
        } catch (e) {
            if (!e.matches(GLib.FileError, GLib.FileError.NOENT)) this.problem = fill(_('cannot read the history: {error}'), { error: e.message });
        }
        if (text !== null) {
            try {
                this.ledger = BatteryLedger.fromJSON(text);
                this.problem = null;
            } catch (e) {
                // The extension moves a damaged file aside on its next start;
                // here it is only reported.
                this.problem = e instanceof LedgerFormatError ? fill(_('the history file is damaged ({error})'), { error: e.message }) : e.message;
            }
        }
        for (const listener of this._listeners) listener(this);
    }

    dispose() {
        if (this._reloadId) GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        this._listeners.clear();
    }
}

/** A stat tile like the panel's cards: name, value, one line of detail. */
function tile(title, tint = null) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true,
        css_classes: ['rp-tile', ...(tint ? [`rp-tint-${tint}`] : [])],
    });
    const label = new Gtk.Label({ label: title, xalign: 0, wrap: true, css_classes: ['rp-tile-label'] });
    box.value = new Gtk.Label({ xalign: 0, wrap: true, css_classes: ['rp-tile-value'] });
    box.detail = new Gtk.Label({ xalign: 0, wrap: true, css_classes: ['rp-tile-detail'] });
    box.append(label);
    box.append(box.value);
    box.append(box.detail);
    Object.defineProperty(box, 'title', { get: () => label.label, set: text => { label.label = text; } });
    return box;
}

/** Show or hide a tile together with the flow box cell around it. */
function showTile(t, shown) {
    t.visible = shown;
    if (t.get_parent()) t.get_parent().visible = shown;
}

function tileGrid(tiles) {
    const grid = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 2, max_children_per_line: 2,
        column_spacing: 8, row_spacing: 8,
    });
    for (const t of tiles) {
        grid.append(t);
        t.get_parent().can_focus = false;
    }
    return grid;
}

/**
 * Battery use over the period as bars: one per hour (24 h and today) or per
 * day (7 and 14 days); the part the processor used drawn inside in blue.
 * @returns {Array<{t: number, battery: number, processor: number}>} Wh per bar
 */
export function drainPoints(ledger, from, to, batteryOnly, step = stepFor(from, to, fineFrom(ledger))) {
    return bars(ledger, from, to, batteryOnly, () => ({ battery: 0, processor: 0 }), (p, b) => {
        p.battery += b.bw;
        p.processor += b.pw - b.iw;
    }, step);
}

// Charts the pointer can read: the bar under it is highlighted and a box
// beside it gives its period and values. The box is drawn in the chart (no
// tooltip delay); from the keyboard Left / Right step through the bars.
const CHART_LEFT = { drain: 44, bars: 52 };

/** The bar under x in a chart `width` wide whose bars start at `left`; -1 outside. */
export function barAt(x, width, left, count) {
    if (count <= 0 || x < left || x >= width) return -1;
    return Math.min(count - 1, Math.floor((x - left) / ((width - left) / count)));
}

/** A bar's length in ms ('day' bars: a day). */
function stepMs(points) {
    const step = points[0]?.step;
    if (typeof step === 'number') return step;
    if (step === 'day') return 24 * HOUR_MS;
    return points.length > 1 ? points[1].t - points[0].t : HOUR_MS;
}

/** The axis label of the bar starting at t: the day, the hour, or hour and minutes. */
function axisLabel(points, t) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(t / 1000));
    const step = stepMs(points);
    if (step > HOUR_MS) return `${d.get_day_of_month()}.${d.get_month()}`;
    return d.format(step < HOUR_MS ? '%H:%M' : '%H:00');
}

/** The period a bar covers: "14:00–15:00", "14:05–14:10", or the day for a chart of days. */
export function barPeriod(points, i) {
    const t = points[i]?.t;
    if (t === undefined) return '';
    const step = stepMs(points);
    const start = GLib.DateTime.new_from_unix_local(Math.floor(t / 1000));
    if (step > HOUR_MS) return start.format('%a %e %b').replace(/\s+/g, ' ');
    const end = start.add_seconds(step / 1000);
    const pattern = step < HOUR_MS ? '%H:%M' : '%H:00';
    return `${start.format(pattern)}–${end.format(pattern)}`;
}

/** "5-minute bars", "15-minute bars", "hourly bars", "daily bars". */
function stepName(points) {
    const step = stepMs(points);
    if (step > HOUR_MS) return _('daily bars');
    if (step === HOUR_MS) return _('hourly bars');
    return fill(_('{n}-minute bars'), { n: Math.round(step / 60000) });
}

/** The time under x in a chart whose bars start at `left`. */
export function timeAt(x, width, left, points) {
    if (points.length === 0) return 0;
    const start = points[0].t;
    const end = points[points.length - 1].t + stepMs(points);
    const f = Math.max(0, Math.min(1, (x - left) / Math.max(1, width - left)));
    return start + f * (end - start);
}

/**
 * Zoom on a chart: drag across it to zoom into that stretch; Ctrl+wheel
 * zooms about the pointer (the plain wheel is left to scroll the page); +, -
 * and 0 from the keyboard. `chart` holds the view ({from, to} or null),
 * `bounds()` the period and `points()` the bars shown; `onChange` redraws.
 */
function zoomable(area, left, chart, bounds, points, onChange) {
    const setView = ([from, to]) => {
        const [lo, hi] = bounds();
        chart.view = from <= lo && to >= hi ? null : { from, to };
        chart.hover?.set(-1);
        onChange();
    };
    chart.zoomTo = (from, to) => {
        const [lo, hi] = bounds();
        setView(clampRange(Math.min(from, to), Math.max(from, to), lo, hi));
    };
    chart.zoomBy = (factor, centre = null) => {
        const [lo, hi] = bounds();
        const [from, to] = chart.view ? [chart.view.from, chart.view.to] : [lo, hi];
        setView(zoomAbout(from, to, centre ?? (from + to) / 2, factor, lo, hi));
    };
    chart.reset = () => setView(bounds());
    chart.selection = null;
    const drag = new Gtk.GestureDrag({ button: Gdk.BUTTON_PRIMARY });
    drag.connect('drag-begin', (_g, x) => {
        chart.selection = { x0: x, x1: x };
    });
    drag.connect('drag-update', (_g, dx) => {
        if (!chart.selection) return;
        chart.selection.x1 = chart.selection.x0 + dx;
        area.queue_draw();
    });
    drag.connect('drag-end', (_g, dx) => {
        const sel = chart.selection;
        chart.selection = null;
        area.queue_draw();
        // A short drag is a click: nothing to zoom into.
        if (!sel || Math.abs(dx) < 8) return;
        const width = area.get_width();
        const shown = points();
        chart.zoomTo(timeAt(sel.x0, width, left, shown), timeAt(sel.x0 + dx, width, left, shown));
    });
    area.add_controller(drag);
    let pointerX = null;
    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_c, x) => {
        pointerX = x;
    });
    motion.connect('leave', () => {
        pointerX = null;
    });
    area.add_controller(motion);
    const wheel = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL });
    wheel.connect('scroll', (controller, _dx, dy) => {
        if (!(controller.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK) || !dy) return false;
        const centre = pointerX === null ? null : timeAt(pointerX, area.get_width(), left, points());
        chart.zoomBy(dy > 0 ? 1.25 : 0.8, centre);
        return true;
    });
    area.add_controller(wheel);
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval) => {
        const shown = points();
        const hovered = chart.hover?.index >= 0 ? shown[chart.hover.index] : null;
        const centre = hovered ? hovered.t + stepMs(shown) / 2 : null;
        if (keyval === Gdk.KEY_plus || keyval === Gdk.KEY_equal || keyval === Gdk.KEY_KP_Add) chart.zoomBy(0.5, centre);
        else if (keyval === Gdk.KEY_minus || keyval === Gdk.KEY_KP_Subtract) chart.zoomBy(2, centre);
        else if (keyval === Gdk.KEY_0 || keyval === Gdk.KEY_KP_0) chart.reset();
        else return false;
        return true;
    });
    area.add_controller(keys);
    chart.zoomControllers = { drag, wheel, keys };
}

/** The stretch being dragged across, over the chart. */
function paintSelection(area, cr, height, chart) {
    const sel = chart?.selection;
    if (!sel || Math.abs(sel.x1 - sel.x0) < 2) return;
    cr.setSourceRGBA(0.208, 0.518, 0.894, 0.18);
    cr.rectangle(Math.min(sel.x0, sel.x1), 0, Math.abs(sel.x1 - sel.x0), height - 18);
    cr.fill();
    cr.setSourceRGBA(0.208, 0.518, 0.894, 0.8);
    cr.rectangle(Math.min(sel.x0, sel.x1), 0, 1, height - 18);
    cr.rectangle(Math.max(sel.x0, sel.x1) - 1, 0, 1, height - 18);
    cr.fill();
}

/**
 * The header's zoom line: the range shown and the bar size, with a Reset
 * button while zoomed.
 */
function zoomHeader() {
    const box = new Gtk.Box({ spacing: 8, css_classes: ['rp-zoom-line'] });
    const label = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true, css_classes: ['rp-tile-detail'] });
    const reset = new Gtk.Button({ label: _('Reset zoom'), css_classes: ['flat', 'rp-zoom-reset'], valign: Gtk.Align.CENTER });
    box.append(label);
    box.append(reset);
    box.update = (chart, points) => {
        if (points.length === 0) {
            label.label = '';
            reset.visible = false;
            return;
        }
        const name = stepName(points);
        const span = fill(_('{from}–{to}'), { from: axisLabel(points, points[0].t), to: axisLabel(points, points[points.length - 1].t + stepMs(points)) });
        label.label = chart.view
            ? fill(_('Zoomed: {span} · {bars}'), { span, bars: name })
            : fill(_('{bars} · drag across the chart, or Ctrl+scroll, to zoom'), { bars: `${name[0].toUpperCase()}${name.slice(1)}` });
        reset.visible = !!chart.view;
    };
    box.label = label;
    box.reset = reset;
    return box;
}

/**
 * Make a chart area hoverable and focusable.
 * @param {Gtk.DrawingArea} area
 * @param {number} left where its bars start
 * @param {function(): number} count how many bars it has now
 * @param {function(number): {title: string, lines: Array<[string, string, string]>}} details
 *   a bar's period and its lines: [colour, label, value]
 * @returns {{index: number, set: function(number), text: function(): string}}
 */
function hoverable(area, left, count, details) {
    const hover = { index: -1 };
    hover.text = () => {
        if (hover.index < 0 || hover.index >= count()) return '';
        const d = details(hover.index);
        return [d.title, ...d.lines.map(([, label, value]) => `${label} ${value}`)].join(', ');
    };
    hover.set = index => {
        const next = index >= 0 && index < count() ? index : -1;
        if (next === hover.index) return;
        hover.index = next;
        area.update_property([Gtk.AccessibleProperty.DESCRIPTION], [hover.text()]);
        area.queue_draw();
    };
    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_c, x) => hover.set(barAt(x, area.get_width(), left, count())));
    motion.connect('leave', () => hover.set(-1));
    area.add_controller(motion);
    area.focusable = true;
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_c, keyval) => {
        const n = count();
        if (keyval === Gdk.KEY_Left || keyval === Gdk.KEY_Right) {
            if (n === 0) return false;
            const step = keyval === Gdk.KEY_Left ? -1 : 1;
            hover.set(hover.index < 0 ? n - 1 : Math.max(0, Math.min(n - 1, hover.index + step)));
            return true;
        }
        if (keyval === Gdk.KEY_Escape && hover.index >= 0) {
            hover.set(-1);
            return true;
        }
        return false;
    });
    area.add_controller(keys);
    hover.motion = motion;
    hover.keys = keys;
    hover.details = details;
    return hover;
}

/** The hovered bar's highlight and details box, drawn over the chart. */
function paintHover(area, cr, width, height, left, count, hover) {
    if (hover.index < 0 || hover.index >= count) return;
    const fg = area.get_color();
    const slot = (width - left) / count;
    const x0 = left + hover.index * slot;
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.10);
    cr.rectangle(x0, 0, slot, height - 18);
    cr.fill();
    const { title, lines } = hover.details(hover.index);
    const esc = str => GLib.markup_escape_text(str, -1);
    const markup = [`<b>${esc(title)}</b>`, ...lines.map(([colour, label, value]) => `<span foreground="${colour}">■</span> ${esc(label)}  <b>${esc(value)}</b>`)].join('\n');
    const layout = area.create_pango_layout(null);
    layout.set_markup(markup, -1);
    const [, logical] = layout.get_pixel_extents();
    const pad = 8;
    const w = logical.width + 2 * pad;
    const h = logical.height + 2 * pad;
    // Beside the bar, on whichever side has room; clamped inside the chart.
    const middle = x0 + slot / 2;
    let x = middle + 10 + w <= width ? middle + 10 : middle - 10 - w;
    x = Math.max(0, Math.min(width - w, x));
    const y = 4;
    const r = 7;
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    cr.setSourceRGBA(0.043, 0.047, 0.059, 0.94);
    cr.fill();
    cr.setSourceRGBA(0.933, 0.945, 0.961, 1);
    cr.moveTo(x + pad, y + pad);
    PangoCairo.show_layout(cr, layout);
}

function drawDrain(area, cr, width, height, points, hover = null) {
    const fg = area.get_color();
    const max = Math.max(0.001, ...points.map(p => Math.max(p.battery, p.processor)));
    const left = CHART_LEFT.drain;
    const bottom = 18;
    const plotH = height - bottom - 6;
    const slot = (width - left) / Math.max(1, points.length);
    const barW = Math.max(2, slot * 0.7);
    // Text through Pango, in the widget's own font and antialiasing.
    const text = (str, x, y, right = false) => {
        const layout = area.create_pango_layout(str);
        const [, logical] = layout.get_pixel_extents();
        cr.moveTo(right ? x - logical.width : x, y - logical.height);
        PangoCairo.show_layout(cr, layout);
    };
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1);
    text(formatWh(max), 0, 16);
    text('0', 0, plotH + 10);
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.25);
    cr.rectangle(left, plotH + 6, width - left, 1);
    cr.fill();
    points.forEach((p, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        const bh = plotH * p.battery / max;
        const ph = plotH * Math.min(p.processor, p.battery || p.processor) / max;
        cr.setSourceRGBA(0.18, 0.76, 0.494, 0.85);
        cr.rectangle(x, plotH + 6 - bh, barW, bh);
        cr.fill();
        cr.setSourceRGBA(0.208, 0.518, 0.894, 0.95);
        cr.rectangle(x + barW * 0.25, plotH + 6 - ph, barW * 0.5, ph);
        cr.fill();
    });
    if (points.length > 0) {
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1);
        const fmt = t => axisLabel(points, t);
        text(fmt(points[0].t), left, height);
        text(fmt(points[points.length - 1].t), width, height, true);
    }
    paintSelection(area, cr, height, hover?.chart);
    if (hover) paintHover(area, cr, width, height, left, points.length, hover);
    cr.$dispose();
}

function hexColour(hex, alpha) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    return [r, g, b, alpha];
}

/**
 * Bars of one component: the first series full width; a second one drawn
 * inside it (`nested`: a part or an average of the first) or beside it.
 */
function drawBars(area, cr, width, height, chart, hover = null) {
    const { points, series, axis, colour, nested } = chart;
    const fg = area.get_color();
    const max = Math.max(1e-9, ...points.flatMap(p => series.map(key => p[key] ?? 0)));
    const left = CHART_LEFT.bars;
    const bottom = 18;
    const plotH = height - bottom - 6;
    const slot = (width - left) / Math.max(1, points.length);
    const barW = Math.max(2, slot * 0.7);
    const text = (str, x, y, right = false) => {
        const layout = area.create_pango_layout(str);
        const [, logical] = layout.get_pixel_extents();
        cr.moveTo(right ? x - logical.width : x, y - logical.height);
        PangoCairo.show_layout(cr, layout);
    };
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1);
    text(axis(max), 0, 16);
    text('0', 0, plotH + 10);
    cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.25);
    cr.rectangle(left, plotH + 6, width - left, 1);
    cr.fill();
    points.forEach((p, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        series.forEach((key, j) => {
            const h = plotH * Math.max(0, p[key] ?? 0) / max;
            const [bx, bw] = nested ? [x + barW * 0.25 * j, barW * (1 - 0.5 * j)] : [x + (barW / series.length) * j, barW / series.length];
            cr.setSourceRGBA(...hexColour(colour, j === 0 ? (nested ? 0.45 : 0.95) : (nested ? 0.95 : 0.5)));
            cr.rectangle(bx, plotH + 6 - h, Math.max(1, bw), h);
            cr.fill();
        });
    });
    if (points.length > 1) {
        cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1);
        const fmt = t => axisLabel(points, t);
        text(fmt(points[0].t), left, height);
        text(fmt(points[points.length - 1].t), width, height, true);
    }
    paintSelection(area, cr, height, hover?.chart);
    if (hover) paintHover(area, cr, width, height, left, points.length, hover);
    cr.$dispose();
}

const dash = '—';
// Small shares keep a decimal: an idle machine is not "0 %" busy.
const pct = x => (x === null || x === undefined ? dash : `${x > 0 && x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)} %`);
const hotFor = s => (s === null || s === undefined ? dash : s > 0 ? formatDuration(s) : _('never'));
const mib = x => (x === null || x === undefined ? dash : formatBytes(x * 1024 * 1024, true));
const bytes = x => (x === null || x === undefined ? dash : formatBytes(x));

/**
 * How each component is shown: its tiles (title, then value and detail from
 * the view's figures), its chart and how an app's figure reads. `unit` is the
 * temperature unit setting.
 */
export function componentSpecs(unit = 'C') {
    const temp = x => (x === null || x === undefined ? dash : formatTemp(x, unit));
    return {
        battery: { title: _('Battery') },
        cpu: {
            title: _('Processor'),
            description: _('The processor\'s load is its share of all cores over the time recorded.'),
            tiles: [
                [_('Average load'), t => [pct(t.load), _('of all cores')]],
                [_('Waiting for the processor'), t => [pct(t.waiting), t.waiting === null ? _('not measured') : _('of the time, some program waited')]],
                [_('Above the temperature alert'), t => [hotFor(t.hot), '']],
                [_('Time recorded'), t => [formatDuration(t.time), '']],
            ],
            chart: _('Processor load'), series: [[_('load'), 'load']], axis: pct,
            app: a => [formatCpu(a.app.cpu), a.app.id.startsWith('@') || a.app.cpu <= 0 ? ''
                : fill(_('{percent} % in the background'), { percent: Math.round((1 - a.app.fg / a.app.cpu) * 100) })],
            appsTitle: _('Apps by processor time'),
        },
        memory: {
            title: _('Memory'),
            tiles: [
                [_('Average in use'), t => [mib(t.average), t.total ? fill(_('of {total}'), { total: mib(t.total) }) : '']],
                [_('Highest in use'), t => [mib(t.highest), t.total && t.highest !== null ? fill(_('{percent} of the total'), { percent: pct(t.highest / t.total) }) : '']],
                [_('Swap in use, at most'), t => [mib(t.swap), t.swapTotal ? fill(_('of {total}'), { total: mib(t.swapTotal) }) : _('no swap')]],
                [_('Waiting for memory'), t => [pct(t.waiting), t.waiting === null ? _('not measured') : _('of the time, some program waited')]],
            ],
            chart: _('Memory in use'), series: [[_('highest'), 'highest'], [_('average'), 'average']], nested: true, axis: mib,
            app: a => [mib(a.value), fill(_('at most {size}'), { size: mib(a.app.memMaxMiB) })],
            appsTitle: _('Apps by memory'),
            appsDescription: _('Average over the period, the hours an app was not running included'),
        },
        disk: {
            title: _('Disk'),
            tiles: [
                [_('Read'), t => [bytes(t.read), _('by the disks')]],
                [_('Written'), t => [bytes(t.written), _('by the disks')]],
                [_('Waiting for the disk'), t => [pct(t.waiting), t.waiting === null ? _('not measured') : _('of the time, some program waited')]],
                [_('Seen per app'), t => [bytes(t.apps), _('read and written, an estimate')]],
            ],
            chart: _('Disk traffic'), series: [[_('read'), 'read'], [_('written'), 'written']], axis: bytes,
            app: a => [bytes(a.value), fill(_('{read} read · {written} written'), { read: bytes(a.app.diskRead), written: bytes(a.app.diskWritten) })],
            appsTitle: _('Apps by disk traffic'),
            appsDescription: _('An estimate: what a process read or wrote is missed if it started and ended between two readings, 30 seconds apart'),
        },
        network: {
            title: _('Network'),
            tiles: [
                [_('Received'), t => [bytes(t.received), '']],
                [_('Sent'), t => [bytes(t.sent), '']],
                [_('While you were away'), t => [bytes(t.away), t.away === null ? '' : fill(_('over {time}'), { time: formatDuration(t.awaySeconds) })]],
            ],
            chart: _('Network traffic'), series: [[_('received'), 'received'], [_('sent'), 'sent']], axis: bytes,
            appsTitle: _('Apps'),
            noApps: _('Traffic per app cannot be read without administrator rights; these are the whole computer\'s figures.'),
        },
        gpu: {
            title: _('Graphics'),
            tiles: [
                [_('Graphics busy'), t => [t.busy === null ? dash : formatDuration(t.busy), _('time the GPU worked for apps')]],
                [_('Share of the time'), t => [pct(t.share), '']],
                [_('Graphics energy'), t => [t.energy === null ? _('not measured') : formatWh(t.energy), _('an estimate')]],
            ],
            chart: _('Graphics busy'), series: [[_('busy'), 'busy']], axis: x => formatDuration(x),
            app: a => [formatCpu(a.app.gpu / 1000), fill(_('{percent} % of the graphics time'), { percent: Math.round(a.share * 100) })],
            appsTitle: _('Apps by graphics time'),
        },
        thermal: {
            title: _('Temperature'),
            tiles: [
                [_('Average'), t => [temp(t.average), _('processor')]],
                [_('Highest'), t => [temp(t.highest), _('processor')]],
                [_('Above the temperature alert'), t => [hotFor(t.hot), '']],
            ],
            chart: _('Processor temperature'), series: [[_('highest'), 'highest'], [_('average'), 'average']], nested: true, axis: temp,
            appsTitle: _('Apps'),
            noApps: _('Temperature belongs to the processor, not to apps: the Processor view shows which apps kept it busy.'),
        },
    };
}

/** A row of a component's app list: icon, name, detail, figure and share. */
function rankedRow(entry, [value, detail], tint) {
    const info = appInfo(entry.app.id);
    const row = new Adw.ActionRow({ title: info.name, subtitle: detail });
    row.appId = entry.app.id;
    row.add_prefix(info.gicon ? new Gtk.Image({ gicon: info.gicon, pixel_size: 32 }) : new Gtk.Image({ icon_name: info.iconName, pixel_size: 24 }));
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER });
    box.append(new Gtk.Label({ label: value, xalign: 1 }));
    const bar = new Gtk.LevelBar({ min_value: 0, max_value: 1, value: Math.min(1, entry.share), width_request: 96, css_classes: [`rp-bar-${tint}`] });
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_LOW);
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_HIGH);
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_FULL);
    box.append(bar);
    row.add_suffix(box);
    row.share = entry.share;
    row.value = value;
    return row;
}

function appRow(app, total, hasEnergy) {
    const info = appInfo(app.id);
    const background = app.cpu > 0 ? 1 - app.fg / app.cpu : 0;
    const parts = [fill(_('{time} of processor time'), { time: formatCpu(app.cpu) })];
    if (app.gpu > 0) parts.push(fill(_('{time} of graphics time'), { time: formatCpu(app.gpu / 1000) }));
    if (!app.id.startsWith('@') && app.cpu > 0) parts.push(fill(_('{percent} % in the background'), { percent: Math.round(background * 100) }));
    const row = new Adw.ActionRow({ title: info.name, subtitle: parts.join(' · ') });
    row.appId = app.id;
    const icon = info.gicon ? new Gtk.Image({ gicon: info.gicon, pixel_size: 32 }) : new Gtk.Image({ icon_name: info.iconName, pixel_size: 24 });
    row.add_prefix(icon);

    const share = total > 0 ? (hasEnergy ? app.wh : app.cpu) / total : 0;
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER });
    box.append(new Gtk.Label({ label: hasEnergy ? formatWh(app.wh) : `${Math.round(share * 100)} %`, xalign: 1 }));
    const bar = new Gtk.LevelBar({ min_value: 0, max_value: 1, value: Math.min(1, share), width_request: 96, css_classes: ['rp-bar-battery'] });
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_LOW);
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_HIGH);
    bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_FULL);
    box.append(bar);
    row.add_suffix(box);
    row.share = share;
    return row;
}

/**
 * A row of tabs, one per component (icon over name), the selected one in
 * its component's tint. Keeps `selected` and `model` as the dropdown it
 * replaced had them.
 * @param {Array<[string, string]>} components key and title
 * @param {?function(string): Gio.Icon} iconFor
 * @param {function()} onChange
 */
function componentTabs(components, iconFor, onChange) {
    // Sized by their names, the space left shared out: equal widths would
    // need every tab as wide as "Temperature".
    const widget = new Gtk.Box({ spacing: 4, css_classes: ['rp-tabs'], accessible_role: Gtk.AccessibleRole.TAB_LIST });
    widget.update_property([Gtk.AccessibleProperty.LABEL], [_('Component')]);
    const buttons = components.map(([key, title], i) => {
        const button = new Gtk.ToggleButton({ css_classes: ['rp-tab'], accessible_role: Gtk.AccessibleRole.TAB, tooltip_text: title, hexpand: true });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, halign: Gtk.Align.CENTER });
        const gicon = iconFor?.(key);
        if (gicon) box.append(new Gtk.Image({ gicon, pixel_size: 18, css_classes: [`rp-c-${key}`] }));
        box.append(new Gtk.Label({ label: title, css_classes: ['rp-tab-label'] }));
        button.set_child(box);
        button.update_property([Gtk.AccessibleProperty.LABEL], [title]);
        if (i > 0) button.set_group(widget.get_first_child());
        button.key = key;
        widget.append(button);
        return button;
    });
    const mark = button => {
        button.update_state([Gtk.AccessibleState.SELECTED], [button.active]);
        if (button.active) button.add_css_class(`rp-tint-${button.key}`);
        else button.remove_css_class(`rp-tint-${button.key}`);
    };
    // The first tab selected before the page can render: no change reported.
    buttons[0].active = true;
    buttons.forEach(mark);
    for (const button of buttons) {
        button.connect('toggled', () => {
            mark(button);
            if (button.active) onChange();
        });
    }
    const tabs = { widget, buttons, model: Gtk.StringList.new(components.map(([, title]) => title)) };
    Object.defineProperty(tabs, 'selected', {
        get: () => buttons.findIndex(b => b.active),
        set: i => {
            if (buttons[i]) buttons[i].active = true;
        },
    });
    return tabs;
}

/**
 * @param {Gio.Settings} settings
 * @param {HistorySource} history
 * @param {object} [opts]
 * @param {function(): ?number} [opts.fullWh] energy of a full charge, if known
 * @returns {{page: Adw.PreferencesPage, rows: object, render: function(), dispose: function()}}
 */
export function buildTrackingPage(settings, history, { fullWh = () => null, iconFor = null } = {}) {
    const page = new Adw.PreferencesPage({ title: _('Tracking'), name: 'tracking', icon_name: 'battery-level-70-symbolic' });
    const rows = {};

    // Tracking itself.
    const control = new Adw.PreferencesGroup({
        title: _('Usage tracking'),
        description: fill(_('Records which apps use the processor, memory, disk and graphics, and how much the network moves and how warm the processor runs, every {seconds} seconds while you are logged in. Kept for {days} days, on this computer only.'),
            { seconds: TRACK_INTERVAL_S, days: DAYS_KEPT }),
    });
    page.add(control);
    rows.tracking = new Adw.SwitchRow({ title: _('Track usage per app') });
    settings.bind('battery-tracking', rows.tracking, 'active', Gio.SettingsBindFlags.DEFAULT);
    control.add(rows.tracking);
    rows.status = new Adw.ActionRow({ title: _('Status') });
    control.add(rows.status);
    rows.clear = new Adw.ActionRow({ title: _('History'), subtitle: fill(ngettext('Recorded figures of the last {n} day', 'Recorded figures of the last {n} days', DAYS_KEPT), { n: DAYS_KEPT }) });
    rows.clearButton = new Gtk.Button({ label: _('Clear…'), valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
    rows.clearButton.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({
            heading: _('Clear the battery history?'),
            body: _('All recorded figures are deleted. Tracking goes on if it is switched on.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('clear', _('Clear'));
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'clear') settings.set_boolean('action-clear-history', true);
        });
        dialog.present(page.get_root());
    });
    rows.clear.add_suffix(rows.clearButton);
    control.add(rows.clear);

    // The components as tabs: each shows the whole page for one of them.
    const specsNow = () => componentSpecs(settings.get_string('unit-temp') || 'C');
    const tabsGroup = new Adw.PreferencesGroup();
    page.add(tabsGroup);
    rows.component = componentTabs(COMPONENTS.map(c => [c, specsNow()[c].title]), iconFor, () => render());
    tabsGroup.add(rows.component.widget);

    // What to report on.
    const options = new Adw.PreferencesGroup({ title: _('Report') });
    page.add(options);
    rows.period = new Adw.ComboRow({ title: _('Period'), model: Gtk.StringList.new(PERIODS.map(p => p.label())) });
    options.add(rows.period);
    rows.batteryOnly = new Adw.SwitchRow({ title: _('On battery only'), subtitle: _('Leave out the time on the charger'), active: true });
    options.add(rows.batteryOnly);

    const summary = new Adw.PreferencesGroup({
        title: _('Summary'),
        description: _('Processor energy is shared among apps by the processor time each used, and the integrated graphics part by graphics time where the machine reports it: an estimate. The display, radios and the rest of the machine cannot be measured per app.'),
    });
    page.add(summary);
    for (const [key, title] of [['used', _('Battery used')], ['drain', _('Average drain')], ['runtime', _('A full charge lasts')], ['time', _('Time on battery')]])
        rows[key] = tile(title, 'battery');
    const batteryBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
    batteryBox.append(tileGrid([rows.used, rows.drain, rows.runtime, rows.time]));

    // Battery use over the period.
    const chartBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ['rp-chart'] });
    const chartHead = new Gtk.Box({ spacing: 12 });
    chartHead.append(new Gtk.Label({ label: _('Battery use'), xalign: 0, hexpand: true, css_classes: ['rp-tile-label'] }));
    for (const [text, colour] of [[_('battery'), 'rp-c-battery'], [_('processor'), 'rp-c-cpu']]) {
        const key = new Gtk.Box({ spacing: 4 });
        key.append(new Gtk.Label({ label: '■', css_classes: [colour] }));
        key.append(new Gtk.Label({ label: text, css_classes: ['rp-tile-detail'] }));
        chartHead.append(key);
    }
    chartBox.append(chartHead);
    const area = new Gtk.DrawingArea({ content_height: 140, hexpand: true, css_classes: ['rp-chart-area'] });
    rows.chart = { area, box: chartBox, points: [] };
    area.update_property([Gtk.AccessibleProperty.LABEL], [_('Battery use over time; Left and Right step through the bars, plus and minus zoom, 0 shows the whole period')]);
    rows.chart.hover = hoverable(area, CHART_LEFT.drain, () => rows.chart.points.length, i => {
        const p = rows.chart.points[i];
        return { title: barPeriod(rows.chart.points, i), lines: [['#2ec27e', _('battery'), formatWh(p.battery)], ['#3584e4', _('processor'), formatWh(p.processor)]] };
    });
    area.set_draw_func((a, cr, width, height) => drawDrain(a, cr, width, height, rows.chart.points, rows.chart.hover));
    rows.chart.hover.chart = rows.chart;
    rows.chart.view = null;
    rows.chart.bounds = [0, 0];
    zoomable(area, CHART_LEFT.drain, rows.chart, () => rows.chart.bounds, () => rows.chart.points, () => render());
    rows.chart.zoomLine = zoomHeader();
    rows.chart.zoomLine.reset.connect('clicked', () => rows.chart.reset());
    chartBox.append(rows.chart.zoomLine);
    chartBox.append(area);
    batteryBox.append(chartBox);

    for (const [key, title] of [['apps', _('Processor, shared among apps')], ['graphics', _('of which graphics')], ['idle', _('Processor idle and platform')],
        ['rest', _('Display, radios and the rest')], ['gap', _('While locked or asleep')]])
        rows[key] = tile(title);
    rows.graphics.add_css_class('rp-tint-gpu');
    rows.apps.add_css_class('rp-tint-cpu');
    batteryBox.append(tileGrid([rows.apps, rows.graphics, rows.idle, rows.rest, rows.gap]));
    summary.add(batteryBox);
    rows.summary = summary;

    // Every component but the battery: tiles, a chart and a message when there is nothing.
    const componentGroup = new Adw.PreferencesGroup();
    page.add(componentGroup);
    const componentBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
    rows.componentTiles = [0, 1, 2, 3].map(() => tile(''));
    componentBox.append(tileGrid(rows.componentTiles));
    const barsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ['rp-chart'] });
    const barsHead = new Gtk.Box({ spacing: 12 });
    const barsTitle = new Gtk.Label({ xalign: 0, hexpand: true, css_classes: ['rp-tile-label'] });
    barsHead.append(barsTitle);
    const legend = [0, 1].map(() => {
        const key = new Gtk.Box({ spacing: 4 });
        key.swatch = new Gtk.Label({ label: '■' });
        key.text = new Gtk.Label({ css_classes: ['rp-tile-detail'] });
        key.append(key.swatch);
        key.append(key.text);
        barsHead.append(key);
        return key;
    });
    barsBox.append(barsHead);
    const barsArea = new Gtk.DrawingArea({ content_height: 140, hexpand: true, css_classes: ['rp-chart-area'] });
    rows.bars = { area: barsArea, box: barsBox, chart: null, title: barsTitle };
    barsArea.update_property([Gtk.AccessibleProperty.LABEL], [_('Use over time; Left and Right step through the bars, plus and minus zoom, 0 shows the whole period')]);
    rows.bars.hover = hoverable(barsArea, CHART_LEFT.bars, () => rows.bars.chart?.points.length ?? 0, i => {
        const chart = rows.bars.chart;
        const p = chart.points[i];
        return {
            title: barPeriod(chart.points, i),
            lines: chart.series.map((key, j) => [chart.colour, chart.labels[j], chart.axis(p[key] ?? 0)]),
        };
    });
    barsArea.set_draw_func((a, cr, width, height) => {
        if (rows.bars.chart) drawBars(a, cr, width, height, rows.bars.chart, rows.bars.hover);
    });
    rows.bars.hover.chart = rows.bars;
    rows.bars.view = null;
    rows.bars.bounds = [0, 0];
    zoomable(barsArea, CHART_LEFT.bars, rows.bars, () => rows.bars.bounds, () => rows.bars.chart?.points ?? [], () => render());
    rows.bars.zoomLine = zoomHeader();
    rows.bars.zoomLine.reset.connect('clicked', () => rows.bars.reset());
    barsBox.append(rows.bars.zoomLine);
    barsBox.append(barsArea);
    componentBox.append(barsBox);
    rows.componentEmpty = new Gtk.Label({ xalign: 0, wrap: true, css_classes: ['dim-label'] });
    componentBox.append(rows.componentEmpty);
    componentGroup.add(componentBox);
    rows.componentGroup = componentGroup;

    const appsGroup = new Adw.PreferencesGroup({ title: _('Apps'), description: _('Most first') });
    rows.appsGroup = appsGroup;
    page.add(appsGroup);
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'] });
    appsGroup.add(list);
    rows.list = list;
    rows.appRows = [];

    const render = () => {
        const tracking = settings.get_boolean('battery-tracking');
        const now = Date.now();
        const period = PERIODS[rows.period.selected] ?? PERIODS[0];
        const batteryOnly = rows.batteryOnly.active;
        const sum = history.ledger.summarize({ from: startOfHour(period.from(now)), batteryOnly });
        const hours = history.ledger.summarize().seconds / 3600;

        if (history.problem) rows.status.subtitle = fill(_('Problem: {problem}'), { problem: history.problem });
        else if (!tracking) rows.status.subtitle = hours > 0 ? _('Off. The history below is kept until you clear it.') : _('Off');
        else if (hours === 0) rows.status.subtitle = _('Recording. The first figures appear within a minute.');
        else rows.status.subtitle = fill(sum.hasEnergy || history.ledger.summarize().hasEnergy
            ? _('Recording · {time} recorded · energy measured')
            : _('Recording · {time} recorded · processor time only: power readings are not available'), { time: formatDuration(hours * 3600) });
        rows.clearButton.sensitive = history.ledger.buckets.length > 0;

        const component = COMPONENTS[rows.component.selected] ?? 'battery';
        rows.batteryOnly.visible = component === 'battery';
        componentGroup.visible = component !== 'battery';
        if (component !== 'battery') {
            summary.visible = false;
            renderComponent(component, startOfHour(period.from(now)), now, tracking);
            return;
        }
        appsGroup.title = _('Apps');
        appsGroup.description = _('Most first');

        // Nothing recorded for this period: no column of zeros.
        summary.visible = sum.seconds > 0 || sum.gapWh > 0;
        const full = fullWh();
        const drain = sum.seconds > 0 && sum.batteryWh > 0 ? sum.batteryWh / (sum.seconds / 3600) : null;
        const ofBattery = wh => (sum.batteryWh > 0 ? fill(_('{percent} % of the battery used'), { percent: Math.round(wh / sum.batteryWh * 100) }) : '');
        rows.used.value.label = formatWh(sum.batteryWh);
        rows.used.detail.label = full > 0 && sum.batteryWh > 0 ? fill(_('{percent} % of a full charge'), { percent: Math.round(sum.batteryWh / full * 100) }) : '';
        rows.time.title = batteryOnly ? _('Time on battery') : _('Time recorded');
        rows.time.value.label = formatDuration(sum.seconds);
        rows.time.detail.label = '';
        rows.drain.value.label = drain !== null ? `${drain.toFixed(1)} W` : '—';
        rows.drain.detail.label = _('on average');
        rows.runtime.value.label = drain !== null && full > 0 ? `${formatDuration(full / drain * 3600)}` : '—';
        rows.runtime.detail.label = drain !== null && full > 0 ? _('at this drain') : '';
        rows.apps.value.label = sum.hasEnergy ? formatWh(sum.attributedWh) : _('not measured');
        rows.apps.detail.label = sum.hasEnergy ? ofBattery(sum.attributedWh) : _('power readings are not available');
        rows.idle.value.label = sum.hasEnergy ? formatWh(sum.idleWh) : _('not measured');
        rows.idle.detail.label = sum.hasEnergy ? ofBattery(sum.idleWh) : '';
        rows.graphics.value.label = formatWh(sum.graphicsWh);
        rows.graphics.detail.label = _('by graphics time');
        const rest = Math.max(0, sum.batteryWh - sum.packageWh);
        rows.rest.value.label = formatWh(rest);
        rows.rest.detail.label = ofBattery(rest) ? fill(_('{share}; not measurable per app'), { share: ofBattery(rest) }) : _('not measurable per app');
        rows.gap.value.label = formatWh(sum.gapWh);
        rows.gap.detail.label = _('not attributed: extensions pause while the screen is locked');
        showTile(rows.graphics, sum.graphicsWh > 0);
        showTile(rows.rest, batteryOnly && sum.hasEnergy && sum.batteryWh > 0);
        showTile(rows.gap, sum.gapWh > 0);
        for (const key of ['used', 'drain', 'runtime']) showTile(rows[key], batteryOnly);
        // The chart shows the period, or the part of it zoomed into.
        rows.chart.bounds = [startOfHour(period.from(now)), now];
        const [chartFrom, chartTo] = rows.chart.view ? [rows.chart.view.from, rows.chart.view.to] : rows.chart.bounds;
        rows.chart.points = drainPoints(history.ledger, chartFrom, chartTo, batteryOnly);
        rows.chart.box.visible = batteryOnly && (!!rows.chart.view || rows.chart.points.some(p => p.battery > 0));
        rows.chart.zoomLine.update(rows.chart, rows.chart.points);
        rows.chart.area.queue_draw();

        list.remove_all();
        rows.appRows = [];
        const total = sum.hasEnergy ? sum.attributedWh : sum.cpu;
        const shown = sum.apps.filter(a => a.cpu > 0).slice(0, APPS_SHOWN);
        for (const app of shown) {
            const row = appRow(app, total, sum.hasEnergy);
            list.append(row);
            rows.appRows.push(row);
        }
        const hidden = sum.apps.filter(a => a.cpu > 0).slice(APPS_SHOWN);
        if (hidden.length > 0) {
            const more = new Adw.ActionRow({ title: fill(_('{n} more'), { n: hidden.length }), subtitle: _('Each below the ones above') });
            list.append(more);
        }
        if (shown.length === 0) {
            list.append(new Adw.ActionRow({
                title: _('No figures for this period'),
                subtitle: tracking ? _('Tracking is on; figures appear as time passes.') : _('Switch on tracking above to start recording.'),
            }));
        }
    };

    /** One component other than the battery, over [from, now]. */
    const renderComponent = (component, from, now, tracking) => {
        const spec = specsNow()[component];
        rows.bars.bounds = [from, now];
        const [viewFrom, viewTo] = rows.bars.view ? [rows.bars.view.from, rows.bars.view.to] : rows.bars.bounds;
        const view = componentView(component, history.ledger, { from, now, cores: GLib.get_num_processors(), viewFrom, viewTo });
        componentGroup.title = spec.title;
        componentGroup.description = spec.description ?? '';
        rows.componentView = view;
        rows.componentTiles.forEach((t, i) => {
            const def = spec.tiles[i];
            showTile(t, !!def && view.has);
            if (!def) return;
            t.title = def[0];
            const [value, detail] = def[1](view.tiles);
            t.value.label = value;
            t.detail.label = detail;
            t.set_css_classes(['rp-tile', `rp-tint-${component}`]);
        });
        rows.bars.chart = { points: view.points, series: view.series, labels: spec.series.map(([label]) => label), axis: spec.axis, colour: METRIC_COLORS[component], nested: !!spec.nested };
        // A new view: no bar of the old one stays highlighted.
        rows.bars.hover.set(-1);
        rows.bars.title.label = spec.chart;
        legend.forEach((key, i) => {
            key.visible = i < spec.series.length;
            if (!key.visible) return;
            key.text.label = spec.series[i][0];
            key.swatch.set_css_classes([`rp-c-${component}`]);
            // As drawn: nested, the outer bar is the faint one; beside, the second.
            key.swatch.opacity = (spec.nested ? i === 0 : i === 1) ? 0.5 : 1;
        });
        barsBox.visible = view.has;
        rows.bars.zoomLine.update(rows.bars, view.points);
        barsArea.queue_draw();
        rows.componentEmpty.visible = !view.has;
        rows.componentEmpty.label = tracking
            ? _('No figures for this period yet: they are recorded while tracking is on, and this kind only since a recent version.')
            : _('No figures for this period. Switch on tracking above to start recording.');

        list.remove_all();
        rows.appRows = [];
        appsGroup.title = spec.appsTitle;
        appsGroup.description = view.apps ? spec.appsDescription ?? _('Most first') : '';
        if (!view.apps) {
            list.append(new Adw.ActionRow({ title: _('No figures per app'), subtitle: spec.noApps }));
            return;
        }
        for (const entry of view.apps.slice(0, APPS_SHOWN)) {
            const row = rankedRow(entry, spec.app(entry), component);
            list.append(row);
            rows.appRows.push(row);
        }
        if (view.apps.length > APPS_SHOWN)
            list.append(new Adw.ActionRow({ title: fill(_('{n} more'), { n: view.apps.length - APPS_SHOWN }), subtitle: _('Each below the ones above') }));
        if (view.apps.length === 0) {
            list.append(new Adw.ActionRow({
                title: _('No figures for this period'),
                subtitle: tracking ? _('Tracking is on; figures appear as time passes.') : _('Switch on tracking above to start recording.'),
            }));
        }
    };

    rows.period.connect('notify::selected', () => {
        // A zoom belongs to the period it was made in.
        rows.chart.view = null;
        rows.bars.view = null;
        render();
    });
    const unitId = settings.connect('changed::unit-temp', render);
    rows.batteryOnly.connect('notify::active', render);
    const trackingId = settings.connect('changed::battery-tracking', () => {
        history.requestFlush();
        render();
    });
    const unsubscribe = history.subscribe(render);
    history.reload();

    return {
        page,
        rows,
        render,
        dispose: () => {
            settings.disconnect(trackingId);
            settings.disconnect(unitId);
            unsubscribe();
        },
    };
}
