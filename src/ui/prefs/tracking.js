// The preferences window's Tracking page: the switch that starts battery
// tracking, the history, and the report of which apps used the battery.
// GTK side (preferences process); never imported by the shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import PangoCairo from 'gi://PangoCairo';

import { BatteryLedger, LedgerFormatError, DAYS_KEPT } from '../../lib/engine/batteryledger.js';
import { ledgerPath, TRACK_INTERVAL_S } from '../../lib/engine/batterytracker.js';
import { appInfo } from '../../lib/common/appnames.js';
import { formatDuration } from '../../lib/common/format.js';
import { _, fill, ngettext } from '../../lib/common/i18n.js';

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
export function drainPoints(ledger, from, now, batteryOnly) {
    const perDay = now - from > 48 * HOUR_MS;
    const step = perDay ? 24 * HOUR_MS : HOUR_MS;
    const start = perDay ? new Date(new Date(from).setHours(0, 0, 0, 0)).getTime() : startOfHour(from);
    const points = [];
    for (let t = start; t <= now; t = perDay ? new Date(new Date(t).setDate(new Date(t).getDate() + 1)).getTime() : t + step)
        points.push({ t, battery: 0, processor: 0 });
    for (const b of ledger.buckets) {
        if (b.t < start || (batteryOnly && !b.b)) continue;
        const i = perDay ? points.findLastIndex(p => p.t <= b.t) : Math.floor((b.t - start) / step);
        if (i < 0 || i >= points.length) continue;
        points[i].battery += b.bw;
        points[i].processor += b.pw - b.iw;
    }
    return points;
}

function drawDrain(area, cr, width, height, points) {
    const fg = area.get_color();
    const max = Math.max(0.001, ...points.map(p => Math.max(p.battery, p.processor)));
    const left = 44;
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
        const fmt = t => {
            const d = new Date(t);
            return points.length > 0 && points[1] && points[1].t - points[0].t > HOUR_MS
                ? `${d.getDate()}.${d.getMonth() + 1}` : `${String(d.getHours()).padStart(2, '0')}:00`;
        };
        text(fmt(points[0].t), left, height);
        text(fmt(points[points.length - 1].t), width, height, true);
    }
    cr.$dispose();
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
 * @param {Gio.Settings} settings
 * @param {HistorySource} history
 * @param {object} [opts]
 * @param {function(): ?number} [opts.fullWh] energy of a full charge, if known
 * @returns {{page: Adw.PreferencesPage, rows: object, render: function(), dispose: function()}}
 */
export function buildTrackingPage(settings, history, { fullWh = () => null } = {}) {
    const page = new Adw.PreferencesPage({ title: _('Tracking'), name: 'tracking', icon_name: 'battery-level-70-symbolic' });
    const rows = {};

    // Tracking itself.
    const control = new Adw.PreferencesGroup({
        title: _('Usage tracking'),
        description: fill(_('Records which apps use the processor and memory, and how much the network moves, every {seconds} seconds while you are logged in. Kept for {days} days, on this computer only.'),
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
    area.set_draw_func((a, cr, width, height) => drawDrain(a, cr, width, height, rows.chart.points));
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

    const appsGroup = new Adw.PreferencesGroup({ title: _('Apps'), description: _('Most first') });
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
        rows.chart.points = drainPoints(history.ledger, startOfHour(period.from(now)), now, batteryOnly);
        rows.chart.box.visible = batteryOnly && rows.chart.points.some(p => p.battery > 0);
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

    rows.period.connect('notify::selected', render);
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
            unsubscribe();
        },
    };
}
