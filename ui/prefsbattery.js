// The preferences window's Tracking page: the switch that starts battery
// tracking, the history, and the report of which apps used the battery.
// GTK side (preferences process); never imported by the shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { BatteryLedger, LedgerFormatError, DAYS_KEPT } from '../lib/batteryledger.js';
import { ledgerPath, TRACK_INTERVAL_S } from '../lib/batterytracker.js';
import { appInfo } from '../lib/appnames.js';
import { formatDuration } from '../lib/format.js';

const HOUR_MS = 3600 * 1000;
const APPS_SHOWN = 15;

export const PERIODS = [
    { id: 'day', label: 'Last 24 hours', from: now => now - 24 * HOUR_MS },
    { id: 'today', label: 'Today', from: now => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() },
    { id: 'week', label: 'Last 7 days', from: now => now - 7 * 24 * HOUR_MS },
    { id: 'all', label: `Last ${DAYS_KEPT} days`, from: now => now - DAYS_KEPT * 24 * HOUR_MS },
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
            if (!e.matches(GLib.FileError, GLib.FileError.NOENT)) this.problem = `cannot read the history: ${e.message}`;
        }
        if (text !== null) {
            try {
                this.ledger = BatteryLedger.fromJSON(text);
                this.problem = null;
            } catch (e) {
                // The extension moves a damaged file aside on its next start;
                // here it is only reported.
                this.problem = e instanceof LedgerFormatError ? `the history file is damaged (${e.message})` : e.message;
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

function valueRow(title, subtitle = '') {
    const row = new Adw.ActionRow({ title, subtitle });
    const value = new Gtk.Label({ css_classes: ['dim-label'], valign: Gtk.Align.CENTER });
    row.add_suffix(value);
    row.value = value;
    return row;
}

function appRow(app, total, hasEnergy) {
    const info = appInfo(app.id);
    const background = app.cpu > 0 ? 1 - app.fg / app.cpu : 0;
    const parts = [`${formatCpu(app.cpu)} of processor time`];
    if (!app.id.startsWith('@') && app.cpu > 0) parts.push(`${Math.round(background * 100)} % in the background`);
    const row = new Adw.ActionRow({ title: info.name, subtitle: parts.join(' · ') });
    row.appId = app.id;
    const icon = info.gicon ? new Gtk.Image({ gicon: info.gicon, pixel_size: 32 }) : new Gtk.Image({ icon_name: info.iconName, pixel_size: 24 });
    row.add_prefix(icon);

    const share = total > 0 ? (hasEnergy ? app.wh : app.cpu) / total : 0;
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER });
    box.append(new Gtk.Label({ label: hasEnergy ? formatWh(app.wh) : `${Math.round(share * 100)} %`, xalign: 1 }));
    const bar = new Gtk.LevelBar({ min_value: 0, max_value: 1, value: Math.min(1, share), width_request: 96 });
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
    const page = new Adw.PreferencesPage({ title: 'Tracking', name: 'tracking', icon_name: 'battery-level-70-symbolic' });
    const rows = {};

    // Tracking itself.
    const control = new Adw.PreferencesGroup({
        title: 'Battery tracking',
        description: `Records which apps use the processor, every ${TRACK_INTERVAL_S} seconds while you are logged in. ` +
            `Kept for ${DAYS_KEPT} days, on this computer only.`,
    });
    page.add(control);
    rows.tracking = new Adw.SwitchRow({ title: 'Track battery use per app' });
    settings.bind('battery-tracking', rows.tracking, 'active', Gio.SettingsBindFlags.DEFAULT);
    control.add(rows.tracking);
    rows.status = new Adw.ActionRow({ title: 'Status' });
    control.add(rows.status);
    rows.clear = new Adw.ActionRow({ title: 'History', subtitle: `Recorded figures of the last ${DAYS_KEPT} days` });
    rows.clearButton = new Gtk.Button({ label: 'Clear…', valign: Gtk.Align.CENTER, css_classes: ['destructive-action'] });
    rows.clearButton.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({
            heading: 'Clear the battery history?',
            body: 'All recorded figures are deleted. Tracking goes on if it is switched on.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('clear', 'Clear');
        dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'clear') settings.set_boolean('action-clear-history', true);
        });
        dialog.present(page.get_root());
    });
    rows.clear.add_suffix(rows.clearButton);
    control.add(rows.clear);

    // What to report on.
    const options = new Adw.PreferencesGroup({ title: 'Report' });
    page.add(options);
    rows.period = new Adw.ComboRow({ title: 'Period', model: Gtk.StringList.new(PERIODS.map(p => p.label)) });
    options.add(rows.period);
    rows.batteryOnly = new Adw.SwitchRow({ title: 'On battery only', subtitle: 'Leave out the time on the charger', active: true });
    options.add(rows.batteryOnly);

    const summary = new Adw.PreferencesGroup({
        title: 'Summary',
        description: 'Processor energy is shared among apps by the processor time each used: an estimate. ' +
            'The display, radios and the rest of the machine cannot be measured per app.',
    });
    page.add(summary);
    for (const [key, title] of [
        ['used', 'Battery used'], ['time', 'Time on battery'], ['drain', 'Average drain'], ['runtime', 'A full charge would last'],
        ['apps', 'Processor, shared among apps'], ['idle', 'Processor idle and platform'], ['rest', 'Display, radios and the rest'],
        ['gap', 'While locked or asleep'],
    ]) {
        rows[key] = valueRow(title);
        summary.add(rows[key]);
    }
    rows.gap.subtitle = 'Not attributed: GNOME pauses extensions while the screen is locked';
    rows.summary = summary;

    const appsGroup = new Adw.PreferencesGroup({ title: 'Apps', description: 'Most first' });
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

        if (history.problem) rows.status.subtitle = `Problem: ${history.problem}`;
        else if (!tracking) rows.status.subtitle = hours > 0 ? 'Off. The history below is kept until you clear it.' : 'Off';
        else if (hours === 0) rows.status.subtitle = 'Recording. The first figures appear within a minute.';
        else rows.status.subtitle = `Recording · ${formatDuration(hours * 3600)} recorded · ` +
            (sum.hasEnergy || history.ledger.summarize().hasEnergy ? 'energy measured' : 'processor time only: power readings are not available');
        rows.clearButton.sensitive = history.ledger.buckets.length > 0;

        // Nothing recorded for this period: no column of zeros.
        summary.visible = sum.seconds > 0 || sum.gapWh > 0;
        const full = fullWh();
        const drain = sum.seconds > 0 && sum.batteryWh > 0 ? sum.batteryWh / (sum.seconds / 3600) : null;
        rows.used.value.label = batteryOnly
            ? `${formatWh(sum.batteryWh)}${full > 0 && sum.batteryWh > 0 ? ` · ${Math.round(sum.batteryWh / full * 100)} % of a full charge` : ''}`
            : '—';
        rows.time.title = batteryOnly ? 'Time on battery' : 'Time recorded';
        rows.time.value.label = formatDuration(sum.seconds);
        rows.drain.value.label = drain !== null ? `${drain.toFixed(1)} W` : '—';
        rows.runtime.value.label = drain !== null && full > 0 ? `about ${formatDuration(full / drain * 3600)}` : '—';
        rows.apps.value.label = sum.hasEnergy
            ? `${formatWh(sum.attributedWh)}${sum.batteryWh > 0 ? ` · ${Math.round(sum.attributedWh / sum.batteryWh * 100)} %` : ''}`
            : 'not measured';
        rows.idle.value.label = sum.hasEnergy ? formatWh(sum.idleWh) : 'not measured';
        const rest = sum.batteryWh - sum.packageWh;
        rows.rest.visible = batteryOnly && sum.hasEnergy && sum.batteryWh > 0;
        rows.rest.value.label = `${formatWh(Math.max(0, rest))}${sum.batteryWh > 0 ? ` · ${Math.round(Math.max(0, rest) / sum.batteryWh * 100)} %` : ''}`;
        rows.gap.visible = sum.gapWh > 0;
        rows.gap.value.label = formatWh(sum.gapWh);
        for (const key of ['used', 'drain', 'runtime']) rows[key].visible = batteryOnly;

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
            const more = new Adw.ActionRow({ title: `${hidden.length} more`, subtitle: 'Each below the ones above' });
            list.append(more);
        }
        if (shown.length === 0) {
            list.append(new Adw.ActionRow({
                title: 'No figures for this period',
                subtitle: tracking ? 'Tracking is on; figures appear as time passes.' : 'Switch on tracking above to start recording.',
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
