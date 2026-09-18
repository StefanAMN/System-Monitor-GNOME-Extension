// The preferences window's rows, built from the same settings model as the
// panel menu's settings page. GTK side: this module runs in the preferences
// process and must never be imported by the shell (and must not import St,
// Clutter or shell modules itself).
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

import { METRICS, SETTINGS_SECTIONS, pinPositions, togglePinned } from '../../lib/common/settingsmodel.js';
import { sanitizeMetricList } from '../../lib/common/present.js';
import { RAPL_FIX_ARGV, RAPL_FIX_WARNING } from '../../lib/common/raplfix.js';
import { PowerSampler } from '../../lib/collectors/power.js';

function pinSubtitle(position) {
    return position > 0 ? `Position ${position} in the top bar` : 'Not pinned';
}

/**
 * Fill a preferences page.
 * @param {Adw.PreferencesPage} page
 * @param {Gio.Settings} settings
 * @param {PowerSampler} power probes whether the energy counters are blocked
 * @returns {{rows: Object, pinRows: Object, powerGroup: Adw.PreferencesGroup, dispose: function()}}
 *   rows and pinRows by settings / metric key; dispose() disconnects from the settings
 */
/**
 * The icon of a pinnable metric, as the panel shows it.
 * @param {string} key
 * @param {string} extensionPath where icons/ is
 * @returns {Gio.Icon}
 */
export function metricIcon(key, extensionPath) {
    const metric = METRICS.find(m => m.key === key);
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    if (metric.bundled && (!metric.icon || !theme.has_icon(metric.icon)))
        return Gio.icon_new_for_string(`${extensionPath}/icons/${metric.bundled}-symbolic.svg`);
    return Gio.ThemedIcon.new(metric.icon);
}

export function buildPreferences(page, settings, power = new PowerSampler(), iconFor = null) {
    const rows = {};
    const pinRows = {};
    // Rows that mirror a setting by hand (no property binding fits): each
    // entry writes the stored value into its row.
    const followers = [];
    // True while a stored value is being written into a row, so the row's
    // own change signal does not write it straight back.
    let following = false;

    const addGroup = (title, description = '') => {
        const group = new Adw.PreferencesGroup({ title, description });
        page.add(group);
        return group;
    };

    const addPins = row => {
        const group = addGroup(row.title, row.detail);
        const pinned = () => sanitizeMetricList(settings.get_strv(row.key));
        for (const { key, name } of METRICS) {
            const pinRow = new Adw.SwitchRow({ title: name });
            const gicon = iconFor?.(key);
            if (gicon) pinRow.add_prefix(new Gtk.Image({ gicon, css_classes: [`rp-c-${key}`] }));
            pinRow.connect('notify::active', () => {
                if (following || pinRow.active === pinned().includes(key)) return;
                settings.set_strv(row.key, togglePinned(pinned(), key));
            });
            group.add(pinRow);
            pinRows[key] = pinRow;
        }
        followers.push(() => {
            const positions = pinPositions(pinned());
            for (const key in pinRows) {
                pinRows[key].active = positions[key] > 0;
                pinRows[key].subtitle = pinSubtitle(positions[key]);
            }
        });
    };

    const addRow = (group, row) => {
        let widget;
        if (row.kind === 'switch') {
            widget = new Adw.SwitchRow({ title: row.title, subtitle: row.detail });
            settings.bind(row.key, widget, 'active', Gio.SettingsBindFlags.DEFAULT);
        } else if (row.kind === 'number') {
            widget = new Adw.SpinRow({
                title: row.title,
                subtitle: row.detail,
                adjustment: new Gtk.Adjustment({ lower: row.min, upper: row.max, step_increment: row.step, page_increment: row.step }),
            });
            settings.bind(row.key, widget, 'value', Gio.SettingsBindFlags.DEFAULT);
        } else {
            const values = row.choices.map(([value]) => value);
            widget = new Adw.ComboRow({
                title: row.title,
                subtitle: row.detail,
                model: Gtk.StringList.new(row.choices.map(([, , longLabel]) => longLabel)),
            });
            widget.connect('notify::selected', () => {
                if (following) return;
                const value = values[widget.selected];
                if (value !== undefined && value !== settings.get_string(row.key)) settings.set_string(row.key, value);
            });
            followers.push(() => {
                const index = values.indexOf(settings.get_string(row.key));
                if (index >= 0 && widget.selected !== index) widget.selected = index;
            });
        }
        group.add(widget);
        rows[row.key] = widget;
    };

    for (const section of SETTINGS_SECTIONS) {
        let group = null;
        for (const row of section.rows) {
            if (row.kind === 'pins') {
                addPins(row);
                continue;
            }
            group ??= addGroup(section.title, section.hint ? `${section.hint[0].toUpperCase()}${section.hint.slice(1)}` : '');
            addRow(group, row);
        }
    }

    const follow = () => {
        following = true;
        try {
            for (const write of followers) write();
        } finally {
            following = false;
        }
    };
    follow();
    const changedId = settings.connect('changed', follow);

    // The panel's size: set by dragging a bottom corner of the panel.
    const panelGroup = addGroup('Panel', 'Drag a bottom corner of the panel to resize it.');
    const sizeRow = new Adw.ActionRow({ title: 'Size' });
    const resetButton = new Gtk.Button({ label: 'Reset', valign: Gtk.Align.CENTER });
    resetButton.connect('clicked', () => {
        settings.set_int('menu-custom-width', 0);
        settings.set_int('menu-custom-height', 0);
    });
    sizeRow.add_suffix(resetButton);
    panelGroup.add(sizeRow);
    rows['panel-size'] = sizeRow;
    rows['panel-size'].resetButton = resetButton;
    followers.push(() => {
        const w = settings.get_int('menu-custom-width');
        const h = settings.get_int('menu-custom-height');
        const custom = w > 0 && h > 0;
        sizeRow.subtitle = custom ? `${w} × ${h} pixels, set by dragging` : 'Automatic';
        resetButton.sensitive = custom;
    });
    follow();

    // Offered only while the counters are blocked.
    const powerGroup = addGroup('Troubleshooting');
    powerGroup.visible = false;
    const powerRow = new Adw.ActionRow({
        title: 'CPU power is not readable',
        subtitle: `Enabling it asks for an administrator password. ${RAPL_FIX_WARNING}`,
    });
    const powerButton = new Gtk.Button({ label: 'Enable', valign: Gtk.Align.CENTER });
    powerButton.connect('clicked', () => {
        powerButton.sensitive = false;
        try {
            const proc = Gio.Subprocess.new(RAPL_FIX_ARGV, Gio.SubprocessFlags.NONE);
            proc.wait_check_async(null, (obj, res) => {
                try {
                    obj.wait_check_finish(res);
                    powerRow.title = 'CPU power is now readable';
                    powerRow.subtitle = '';
                } catch (e) {
                    powerRow.subtitle = `Failed: ${e.message}`;
                    powerButton.sensitive = true;
                }
            });
        } catch (e) {
            powerRow.subtitle = `Failed: ${e.message}`;
            powerButton.sensitive = true;
        }
    });
    powerRow.add_suffix(powerButton);
    powerGroup.add(powerRow);
    rows['power-fix'] = powerRow;
    power.sample().then(reading => {
        powerGroup.visible = !!reading.raplBlocked;
    }, e => console.error(`Resource Pulse preferences: power probe failed: ${e.message}`));

    return { rows, pinRows, powerGroup, dispose: () => settings.disconnect(changedId) };
}
