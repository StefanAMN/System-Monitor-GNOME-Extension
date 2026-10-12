// The preferences window's Settings page, built from the settings model
// (settingsmodel.js): a live preview of the top bar and the metrics as chips,
// sliders for the limits, segmented buttons for the choices. GTK side: this module runs in the preferences
// process and must never be imported by the shell (and must not import St,
// Clutter or shell modules itself).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';
import Pango from 'gi://Pango';
import Graphene from 'gi://Graphene';

import { METRICS, SETTINGS_SECTIONS, pinPositions, togglePinned, movePinned, formatSettingValue } from '../../lib/common/settingsmodel.js';
import { formatTemp } from '../../lib/common/format.js';
import { sanitizeMetricList } from '../../lib/common/present.js';
import { RAPL_FIX_COMMANDS, raplFixWarning } from '../../lib/common/raplfix.js';
import { PowerSampler } from '../../lib/collectors/power.js';
import { _, N_, fill } from '../../lib/common/i18n.js';

function pinSubtitle(position) {
    return position > 0 ? fill(_('Position {n} in the top bar'), { n: position }) : _('Not pinned');
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
    if (metric.bundled && (metric.bundledFirst || !metric.icon || !theme.has_icon(metric.icon)))
        return Gio.icon_new_for_string(`${extensionPath}/icons/${metric.bundled}-symbolic.svg`);
    return Gio.ThemedIcon.new(metric.icon);
}

// Example values for the top-bar preview: what a laptop at rest shows.
const PREVIEW_VALUES = {
    cpu: () => '12%', memory: () => '48%', power: () => '9.3 W', disk: () => '45%', gpu: () => '18%',
    battery: s => (s.get_string('battery-top-format') === 'percent-time' ? '85% · 2h 15m' : '85%'),
    network: s => ({ upload: '↑ 240 KB/s', both: '↓ 1.2 MB/s ↑ 240 KB/s' })[s.get_string('network-top-format')] ?? '↓ 1.2 MB/s',
    thermal: s => formatTemp(52, s.get_string('unit-temp') || 'C'),
};

/** A metric key carried by a drag: from the preview (a move) or a chip (a pin). */
function dragSource(widget, key, onBegin = () => {}, onEnd = () => {}) {
    const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
    source.connect('prepare', () => Gdk.ContentProvider.new_for_value(key));
    source.connect('drag-begin', (src) => {
        src.set_icon(new Gtk.WidgetPaintable({ widget }), widget.get_width() / 2, widget.get_height() / 2);
        onBegin();
    });
    source.connect('drag-end', () => onEnd());
    widget.add_controller(source);
    return source;
}

/**
 * The top bar as the pinned metrics, the compact switch, the formats and the
 * temperature unit make it, with example values: dark, as GNOME's is. Its
 * metrics can be dragged along it to change their order, or moved with
 * Ctrl+Left / Ctrl+Right; a chip dropped on it pins that metric there.
 * @returns {Gtk.Widget & {update: function(), text: function(): string, items: Array, dropAt: function(string, number): boolean}}
 */
function topBarPreview(settings, iconFor) {
    const frame = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, css_classes: ['rp-preview'] });
    const bar = new Gtk.Box({ spacing: 0, halign: Gtk.Align.CENTER, css_classes: ['rp-preview-bar'], accessible_role: Gtk.AccessibleRole.LIST });
    const caption = new Gtk.Label({ label: _('Example values · drag a metric to move it'), css_classes: ['rp-preview-caption'], halign: Gtk.Align.CENTER });
    frame.append(bar);
    frame.append(caption);
    let spoken = '';
    let focusKey = null;
    frame.items = [];
    const pinnedNow = () => sanitizeMetricList(settings.get_strv('pinned-metrics'));
    const place = (key, index) => {
        const next = movePinned(pinnedNow(), key, index);
        if (next.join() !== pinnedNow().join()) settings.set_strv('pinned-metrics', next);
    };

    // Where a drop at x (in the bar) lands: before the first metric whose
    // middle is right of x, the dragged one not counted.
    const indexAt = (x, key) => {
        let index = 0;
        for (const item of frame.items) {
            if (item.key === key) continue;
            const [, middle] = item.widget.compute_point(bar, new Graphene.Point().init(item.widget.get_width() / 2, 0));
            if (middle.x < x) index++;
        }
        return index;
    };
    // The line where it will land: before a metric, or after the last.
    const mark = (index, key) => {
        const others = frame.items.filter(item => item.key !== key);
        for (const item of frame.items) {
            item.widget.remove_css_class('rp-drop-before');
            item.widget.remove_css_class('rp-drop-after');
        }
        if (index < 0 || others.length === 0) return;
        if (index < others.length) others[index].widget.add_css_class('rp-drop-before');
        else others[others.length - 1].widget.add_css_class('rp-drop-after');
    };
    const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
    target.set_preload(true);
    target.connect('motion', (t, x) => {
        // Preloaded: the dragged metric's key, so it is not counted where it was.
        const value = t.get_value();
        const key = typeof value === 'string' ? value : null;
        mark(indexAt(x, key), key);
        return Gdk.DragAction.MOVE;
    });
    target.connect('leave', () => mark(-1));
    target.connect('drop', (t, value, x) => {
        mark(-1);
        return frame.dropAt(String(value), indexAt(x, String(value)));
    });
    bar.add_controller(target);
    // Also what a test or an assistive tool does: put `key` at `index`.
    frame.dropAt = (key, index) => {
        if (!METRICS.some(m => m.key === key)) return false;
        place(key, index);
        return true;
    };

    frame.update = () => {
        for (let child = bar.get_first_child(); child;) {
            const next = child.get_next_sibling();
            bar.remove(child);
            child = next;
        }
        frame.items = [];
        const pinned = pinnedNow();
        const compact = settings.get_boolean('compact-label');
        const parts = [];
        pinned.forEach((key, i) => {
            if (i > 0) bar.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL, css_classes: ['rp-preview-divider'] }));
            const name = _(METRICS.find(m => m.key === key).name);
            const item = new Gtk.Box({ spacing: 6, css_classes: ['rp-preview-item'], focusable: true, accessible_role: Gtk.AccessibleRole.LIST_ITEM });
            item.set_cursor_from_name('grab');
            const gicon = iconFor?.(key);
            if (gicon) item.append(new Gtk.Image({ gicon, pixel_size: 16, css_classes: [`rp-c-${key}`] }));
            const value = PREVIEW_VALUES[key](settings);
            if (!compact) item.append(new Gtk.Label({ label: value, css_classes: ['rp-preview-value'] }));
            item.update_property([Gtk.AccessibleProperty.LABEL, Gtk.AccessibleProperty.DESCRIPTION],
                [fill(_('{metric}, {n} of {count} in the top bar'), { metric: name, n: i + 1, count: pinned.length }),
                    _('Drag, or press Ctrl+Left or Ctrl+Right, to move it')]);
            dragSource(item, key, () => item.add_css_class('rp-dragging'), () => item.remove_css_class('rp-dragging'));
            const keys = new Gtk.EventControllerKey();
            keys.connect('key-pressed', (_c, keyval, _code, state) => {
                if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false;
                const step = keyval === Gdk.KEY_Left ? -1 : keyval === Gdk.KEY_Right ? 1 : 0;
                if (!step) return false;
                focusKey = key;
                place(key, i + step);
                return true;
            });
            item.add_controller(keys);
            item.moveKeys = keys;
            bar.append(item);
            frame.items.push({ key, widget: item });
            parts.push(`${name} ${value}`);
        });
        if (pinned.length === 0)
            bar.append(new Gtk.Label({ label: _('Nothing pinned: only the Resource Pulse icon'), css_classes: ['rp-preview-value'] }));
        spoken = pinned.length > 0 ? fill(_('Top bar preview: {items}'), { items: parts.join(', ') }) : _('Top bar preview: nothing pinned');
        frame.update_property([Gtk.AccessibleProperty.LABEL], [spoken]);
        // A metric moved from the keyboard keeps the focus in its new place.
        if (focusKey) {
            frame.items.find(item => item.key === focusKey)?.widget.grab_focus();
            focusKey = null;
        }
    };
    frame.text = () => spoken;
    return frame;
}

/**
 * A segmented control for a `choice` row, as the row's suffix. The row keeps
 * `selected` and `model` (the long labels), as a combo row has them.
 */
function segmentedRow(row, settings, isFollowing) {
    const widget = new Adw.ActionRow({ title: _(row.title), subtitle: _(row.detail) });
    const values = row.choices.map(([value]) => value);
    const box = new Gtk.Box({ css_classes: ['linked', 'rp-segmented'], valign: Gtk.Align.CENTER });
    const buttons = row.choices.map(([value, , longLabel, segment], i) => {
        const button = new Gtk.ToggleButton({ label: _(segment ?? longLabel), tooltip_text: _(longLabel) });
        if (i > 0) button.set_group(box.get_first_child());
        button.connect('toggled', () => {
            if (!button.active || isFollowing()) return;
            if (settings.get_string(row.key) !== value) settings.set_string(row.key, value);
        });
        box.append(button);
        return button;
    });
    widget.add_suffix(box);
    widget.model = Gtk.StringList.new(row.choices.map(([, , longLabel]) => _(longLabel)));
    widget.buttons = buttons;
    Object.defineProperty(widget, 'selected', {
        get: () => buttons.findIndex(b => b.active),
        set: i => {
            if (buttons[i]) buttons[i].active = true;
        },
    });
    widget.follow = () => {
        const index = values.indexOf(settings.get_string(row.key));
        if (index >= 0 && !buttons[index].active) buttons[index].active = true;
    };
    return widget;
}

/**
 * A slider for a `number` row, with its value beside it. The row keeps
 * `value`, as a spin row has it.
 */
function sliderRow(row, settings, iconFor) {
    const widget = new Adw.ActionRow({ title: _(row.title), subtitle: _(row.detail) });
    const gicon = row.metric ? iconFor?.(row.metric) : null;
    if (gicon) widget.add_prefix(new Gtk.Image({ gicon, css_classes: [`rp-c-${row.metric}`] }));
    const adjustment = new Gtk.Adjustment({ lower: row.min, upper: row.max, step_increment: row.step, page_increment: row.step });
    const scale = new Gtk.Scale({ adjustment, draw_value: false, digits: 0, round_digits: 0, width_request: 180, valign: Gtk.Align.CENTER, css_classes: ['rp-slider'] });
    scale.update_property([Gtk.AccessibleProperty.LABEL], [_(row.title)]);
    const label = new Gtk.Label({ width_chars: 6, xalign: 1, css_classes: ['rp-slider-value', 'numeric'] });
    widget.add_suffix(scale);
    widget.add_suffix(label);
    settings.bind(row.key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const show = () => {
        label.label = formatSettingValue(row, Math.round(adjustment.value), settings.get_string('unit-temp') || 'C');
    };
    adjustment.connect('value-changed', show);
    show();
    widget.scale = scale;
    widget.adjustment = adjustment;
    widget.valueLabel = label;
    widget.follow = show;
    Object.defineProperty(widget, 'value', { get: () => adjustment.value, set: v => { adjustment.value = v; } });
    return widget;
}

export function buildPreferences(page, settings, power = new PowerSampler(), iconFor = null) {
    const rows = {};
    const pinRows = {};
    // Widgets that mirror a setting by hand (no property binding fits): each
    // entry writes the stored value into its widget.
    const followers = [];
    // True while a stored value is being written into a widget, so the
    // widget's own change signal does not write it straight back.
    let following = false;
    const isFollowing = () => following;

    const addGroup = (title, description = '') => {
        const group = new Adw.PreferencesGroup({ title, description });
        page.add(group);
        return group;
    };

    // The top bar: the preview, the metrics to pin, then how they show.
    const addPins = (group, row) => {
        const preview = topBarPreview(settings, iconFor);
        group.add(preview);
        rows.preview = preview;
        const pinned = () => sanitizeMetricList(settings.get_strv(row.key));
        const chips = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 4, max_children_per_line: 4,
            column_spacing: 8, row_spacing: 8, margin_top: 12, margin_bottom: 6,
        });
        for (const { key, name } of METRICS) {
            const chip = new Gtk.ToggleButton({ css_classes: ['rp-pin-chip'] });
            const content = new Gtk.Box({ spacing: 6 });
            const gicon = iconFor?.(key);
            if (gicon) content.append(new Gtk.Image({ gicon, css_classes: [`rp-c-${key}`] }));
            // Whole names: a chip's width follows its name, not the other way round.
            const label = new Gtk.Label({ label: _(name), xalign: 0, hexpand: true });
            content.append(label);
            const badge = new Gtk.Label({ css_classes: ['rp-pin-badge', 'numeric'], valign: Gtk.Align.CENTER });
            content.append(badge);
            chip.set_child(content);
            chip.title = _(name);
            chip.subtitle = '';
            chip.connect('toggled', () => {
                if (following || chip.active === pinned().includes(key)) return;
                settings.set_strv(row.key, togglePinned(pinned(), key));
            });
            chips.append(chip);
            chip.get_parent().can_focus = false;
            chip.badge = badge;
            // Dragged onto the preview, a chip pins its metric at that place.
            dragSource(chip, key);
            pinRows[key] = chip;
        }
        group.add(chips);
        followers.push(() => {
            const positions = pinPositions(pinned());
            for (const [key, chip] of Object.entries(pinRows)) {
                const position = positions[key];
                chip.active = position > 0;
                chip.subtitle = pinSubtitle(position);
                chip.badge.label = position > 0 ? String(position) : '';
                chip.badge.visible = position > 0;
                chip.tooltip_text = chip.subtitle;
                chip.update_property([Gtk.AccessibleProperty.DESCRIPTION], [chip.subtitle]);
                if (position > 0) chip.add_css_class(`rp-tint-${key}`);
                else chip.remove_css_class(`rp-tint-${key}`);
            }
            preview.update();
        });
    };

    const addRow = (group, row) => {
        let widget;
        if (row.kind === 'switch') {
            widget = new Adw.SwitchRow({ title: _(row.title), subtitle: _(row.detail) });
            settings.bind(row.key, widget, 'active', Gio.SettingsBindFlags.DEFAULT);
        } else if (row.kind === 'number') {
            widget = sliderRow(row, settings, iconFor);
            followers.push(widget.follow);
        } else {
            widget = segmentedRow(row, settings, isFollowing);
            followers.push(widget.follow);
        }
        group.add(widget);
        rows[row.key] = widget;
    };

    const SECTION_TEXT = {
        topbar: [N_('Top bar'), N_('Click a metric to pin it next to the clock. Pinned last shows last, and loses its value first when space runs out.')],
        units: [N_('Readings'), N_('How often values are read, and in which units.')],
    };
    for (const section of SETTINGS_SECTIONS) {
        const [title, description] = SECTION_TEXT[section.id] ?? [section.title, section.hint ?? ''];
        const group = addGroup(_(title), description ? `${_(description)[0].toUpperCase()}${_(description).slice(1)}` : '');
        if (section.id === 'topbar') group.add_css_class('rp-topbar-group');
        let list = null;
        for (const row of section.rows) {
            if (row.kind === 'pins') {
                addPins(group, row);
                continue;
            }
            // The other rows in one boxed list under the chips.
            if (!list) {
                list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'], margin_top: section.id === 'topbar' ? 6 : 0 });
                group.add(list);
            }
            addRow({ add: w => list.append(w) }, row);
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
    const panelGroup = addGroup(_('Panel'), _('Drag a bottom corner of the panel to resize it.'));
    const sizeRow = new Adw.ActionRow({ title: _('Size') });
    const resetButton = new Gtk.Button({ label: _('Reset'), valign: Gtk.Align.CENTER });
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
        sizeRow.subtitle = custom ? fill(_('{width} × {height} pixels, set by dragging'), { width: w, height: h }) : _('Automatic');
        resetButton.sensitive = custom;
    });
    follow();

    // Offered only while the counters are blocked.
    const powerGroup = addGroup(_('Troubleshooting'));
    powerGroup.visible = false;
    const powerRow = new Adw.ActionRow({
        title: _('CPU power is not readable'),
        subtitle: `${_('Run these two commands in a terminal to make it readable; they ask for your password.')} ${raplFixWarning()}`,
    });
    const copyButton = new Gtk.Button({ label: _('Copy commands'), valign: Gtk.Align.CENTER });
    copyButton.connect('clicked', () => {
        const bytes = new GLib.Bytes(new TextEncoder().encode(`${RAPL_FIX_COMMANDS}\n`));
        copyButton.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
        copyButton.label = _('Copied');
    });
    const checkButton = new Gtk.Button({ label: _('Check again'), valign: Gtk.Align.CENTER });
    powerRow.add_suffix(copyButton);
    powerRow.add_suffix(checkButton);
    powerGroup.add(powerRow);
    const commands = new Gtk.Label({
        label: RAPL_FIX_COMMANDS, selectable: true, wrap: true, wrap_mode: Pango.WrapMode.CHAR, xalign: 0,
        css_classes: ['monospace'], margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
    });
    powerGroup.add(commands);
    rows['power-fix'] = powerRow;
    const probe = () => power.sample().then(reading => {
        if (!reading.raplBlocked && powerGroup.visible) {
            powerRow.title = _('CPU power is now readable');
            powerRow.subtitle = '';
            copyButton.visible = checkButton.visible = commands.visible = false;
        } else {
            powerGroup.visible = !!reading.raplBlocked;
        }
    }, e => console.error(`Resource Pulse preferences: power probe failed: ${e.message}`));
    checkButton.connect('clicked', probe);
    probe();

    return { rows, pinRows, powerGroup, dispose: () => settings.disconnect(changedId) };
}
