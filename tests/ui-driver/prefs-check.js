// Exercises the preferences rows (src/ui/prefs/rows.js) with real GTK widgets and
// a memory-backed copy of the schema. Started by the UI driver as a client of
// the sandboxed shell: gjs -m prefs-check.js <extension directory>
// Prints one PREFS-CHECK line per failure and a final verdict, then shows a
// freshly built window for a few seconds so the driver can screenshot it.
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';
import Gettext from 'gettext';

const root = ARGV[0];
const loop = new GLib.MainLoop(null, false);
let checks = 0;
let failures = 0;

function ok(cond, msg) {
    checks++;
    if (cond) return;
    failures++;
    print(`PREFS-CHECK FAIL: ${msg}`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function newSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(`${root}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.resource-pulse', false);
    return new Gio.Settings({ settings_schema: schema, backend: Gio.memory_settings_backend_new() });
}

async function main() {
    const prefsRows = await import(`file://${root}/ui/prefs/rows.js`);
    const { buildPreferences } = prefsRows;
    const { allSettingRows, METRICS } = await import(`file://${root}/lib/common/settingsmodel.js`);
    const { PowerSampler } = await import(`file://${root}/lib/collectors/power.js`);
    Adw.init();

    const { styleWindow: style } = await import(`file://${root}/ui/prefs/style.js`);
    const build = (settings, power) => {
        const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
        style(window);
        const page = new Adw.PreferencesPage({ title: 'Settings' });
        window.add(page);
        const { metricIcon } = prefsRows;
        return { window, page, ...buildPreferences(page, settings, power, key => metricIcon(key, root)) };
    };

    // A powercap tree without any energy domain: the fix is not offered.
    const emptyRoot = GLib.dir_make_tmp('rp-prefs-powercap-XXXXXX');
    const settings = newSettings();
    const built = build(settings, new PowerSampler(emptyRoot));
    const { rows, pinRows } = built;

    // No explanatory text on the page: group titles only, no caption under the preview.
    const groups = findAll(built.page, w => w instanceof Adw.PreferencesGroup);
    ok(groups.length >= 4 && groups.every(g => !g.description), `settings: group descriptions shown (${groups.filter(g => g.description).map(g => `${g.title}: '${g.description}'`).join('; ')})`);
    const captions = findAll(built.page, w => w instanceof Gtk.Label && /Example values|drag a metric/.test(w.label));
    ok(captions.length === 0 && /drag a metric/.test(rows.preview.tooltip_text ?? ''), `settings: preview caption '${captions[0]?.label}' shown, or its hint missing from the tooltip`);

    const model = allSettingRows().filter(row => row.kind !== 'pins');
    ok(model.every(row => rows[row.key]), `rows missing for ${model.filter(row => !rows[row.key]).map(row => row.key)}`);
    for (const row of model) {
        const widget = rows[row.key];
        if (!widget) continue;
        // No words under the row: what it does is its tooltip.
        ok(widget.title === row.title && !widget.subtitle && widget.tooltip_text === row.detail,
            `${row.key}: title '${widget.title}', subtitle '${widget.subtitle}', tooltip '${widget.tooltip_text}' (wanted the model's detail as the tooltip, no subtitle)`);
        if (row.kind === 'number') {
            const adj = widget.adjustment;
            ok(adj.lower === row.min && adj.upper === row.max && adj.step_increment === row.step,
                `${row.key}: spin range ${adj.lower}..${adj.upper} step ${adj.step_increment}`);
            ok(widget.value === settings.get_int(row.key), `${row.key}: shows ${widget.value} for a stored ${settings.get_int(row.key)}`);
            widget.value = row.min;
            ok(settings.get_int(row.key) === row.min, `${row.key}: the row did not store ${row.min}`);
            settings.set_int(row.key, row.max);
            ok(widget.value === row.max, `${row.key}: the row did not follow a stored ${row.max}`);
        } else if (row.kind === 'switch') {
            const before = settings.get_boolean(row.key);
            ok(widget.active === before, `${row.key}: shows ${widget.active} for a stored ${before}`);
            widget.active = !before;
            ok(settings.get_boolean(row.key) === !before, `${row.key}: the row did not store ${!before}`);
            settings.set_boolean(row.key, before);
            ok(widget.active === before, `${row.key}: the row did not follow the stored value`);
        } else {
            const values = row.choices.map(([value]) => value);
            ok(widget.model.get_n_items() === values.length, `${row.key}: ${widget.model.get_n_items()} entries for ${values.length} choices`);
            ok(widget.selected === values.indexOf(settings.get_string(row.key)), `${row.key}: selection ${widget.selected} for '${settings.get_string(row.key)}'`);
            for (let i = values.length - 1; i >= 0; i--) {
                widget.selected = i;
                ok(settings.get_string(row.key) === values[i], `${row.key}: entry ${i} stored '${settings.get_string(row.key)}'`);
            }
            settings.set_string(row.key, values[values.length - 1]);
            ok(widget.selected === values.length - 1, `${row.key}: the row did not follow a stored '${values[values.length - 1]}'`);
        }
    }

    // Each pinned-metric row carries the metric's tinted icon, as the panel shows it.
    const hasIcon = (widget, key) => {
        if (widget instanceof Gtk.Image && widget.has_css_class(`rp-c-${key}`) && widget.gicon) return true;
        for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) if (hasIcon(c, key)) return true;
        return false;
    };
    ok(METRICS.every(m => hasIcon(pinRows[m.key], m.key)), 'pins: every row has its metric icon');
    // Pinned metrics: chips plus the position each one has in the top bar.
    settings.reset('pinned-metrics');
    ok(Object.keys(pinRows).join() === METRICS.map(m => m.key).join(), `pin rows are ${Object.keys(pinRows)}`);
    ok(pinRows.cpu.active && pinRows.cpu.subtitle === 'Position 1 in the top bar', `pins: cpu shows '${pinRows.cpu.subtitle}'`);
    ok(!pinRows.gpu.active && pinRows.gpu.subtitle === 'Not pinned', `pins: gpu shows '${pinRows.gpu.subtitle}'`);
    pinRows.gpu.active = true;
    ok(settings.get_strv('pinned-metrics').join() === 'cpu,memory,battery,gpu' && pinRows.gpu.subtitle === 'Position 4 in the top bar',
        `pins: after pinning gpu the list is ${settings.get_strv('pinned-metrics')} ('${pinRows.gpu.subtitle}')`);
    pinRows.cpu.active = false;
    ok(settings.get_strv('pinned-metrics').join() === 'memory,battery,gpu' && pinRows.memory.subtitle === 'Position 1 in the top bar' &&
        pinRows.cpu.subtitle === 'Not pinned', `pins: after unpinning cpu the list is ${settings.get_strv('pinned-metrics')}`);
    settings.set_strv('pinned-metrics', ['disk']);
    ok(Object.keys(pinRows).filter(key => pinRows[key].active).join() === 'disk', 'pins: the rows did not follow a list stored elsewhere');
    // A stored list with an unknown key and a duplicate is cleaned when written.
    settings.set_strv('pinned-metrics', ['cpu', 'bogus', 'cpu']);
    ok(pinRows.cpu.active && pinRows.cpu.subtitle === 'Position 1 in the top bar', 'pins: a list with junk in it is not shown cleaned');
    pinRows.memory.active = true;
    ok(settings.get_strv('pinned-metrics').join() === 'cpu,memory', `pins: junk survived a write (${settings.get_strv('pinned-metrics')})`);

    // Panel size: shown, and Reset clears both keys.
    // The preview follows the pins, the formats, the unit and compact mode.
    const preview = rows.preview;
    settings.set_strv('pinned-metrics', ['cpu', 'battery', 'network', 'thermal']);
    settings.set_string('battery-top-format', 'percent-time');
    settings.set_string('network-top-format', 'both');
    settings.set_string('unit-temp', 'F');
    ok(preview.text() === 'Top bar preview: CPU 12%, Battery 85% · 2h 15m, Network ↓ 1.2 MB/s ↑ 240 KB/s, Thermal 126°F',
        `preview: '${preview.text()}'`);
    ok(pinRows.thermal.badge.label === '4' && pinRows.thermal.badge.visible && !pinRows.gpu.badge.visible, 'chips: the badge shows the position, only when pinned');
    settings.set_boolean('compact-label', true);
    ok(findAll(preview, w => w.has_css_class?.('rp-preview-value')).length === 0 && findAll(preview, w => w instanceof Gtk.Image).length === 4,
        'preview: compact shows the four icons only');
    settings.set_boolean('compact-label', false);
    // Reordering: a drop puts a metric at a place; a chip's drop pins it there.
    settings.set_strv('pinned-metrics', ['cpu', 'memory', 'battery', 'network']);
    ok(preview.dropAt('network', 0) && settings.get_strv('pinned-metrics').join() === 'network,cpu,memory,battery' && preview.text().startsWith('Top bar preview: Network'),
        `drag: network dropped at the front gives ${settings.get_strv('pinned-metrics').join()}`);
    ok(preview.dropAt('gpu', 1) && settings.get_strv('pinned-metrics').join() === 'network,gpu,cpu,memory,battery' && pinRows.gpu.active && pinRows.gpu.badge.label === '2',
        `drag: the GPU chip dropped second pins it there (${settings.get_strv('pinned-metrics').join()})`);
    ok(!preview.dropAt('not-a-metric', 0) && settings.get_strv('pinned-metrics').join() === 'network,gpu,cpu,memory,battery', 'drag: a drop of anything else changes nothing');
    // From the keyboard: Ctrl+Right moves the focused metric one place later, and it keeps the focus.
    const cpuItem = preview.items.find(item => item.key === 'cpu');
    ok(cpuItem.widget.focusable && cpuItem.widget.moveKeys.emit('key-pressed', Gdk.KEY_Right, 0, Gdk.ModifierType.CONTROL_MASK),
        'keys: Ctrl+Right is taken by a preview metric');
    ok(settings.get_strv('pinned-metrics').join() === 'network,gpu,memory,cpu,battery', `keys: cpu one place later (${settings.get_strv('pinned-metrics').join()})`);
    preview.items.find(item => item.key === 'network').widget.moveKeys.emit('key-pressed', Gdk.KEY_Left, 0, Gdk.ModifierType.CONTROL_MASK);
    ok(settings.get_strv('pinned-metrics')[0] === 'network', 'keys: Ctrl+Left on the first metric keeps it first');
    ok(!cpuItem.widget.moveKeys.emit('key-pressed', Gdk.KEY_Right, 0, 0), 'keys: Right without Ctrl is left to the window');
    settings.set_strv('pinned-metrics', []);
    ok(preview.text() === 'Top bar preview: nothing pinned', `preview with nothing pinned: '${preview.text()}'`);
    for (const key of ['pinned-metrics', 'battery-top-format', 'network-top-format', 'unit-temp', 'compact-label', 'threshold-temp']) settings.reset(key);
    ok(rows['threshold-temp'].valueLabel.label === '80°C', `slider value: '${rows['threshold-temp'].valueLabel.label}'`);
    const wheelBefore = settings.get_int('threshold-cpu');
    ok(rows['threshold-cpu'].knobOnly.wheel.emit('scroll', 0, -3) === true && settings.get_int('threshold-cpu') === wheelBefore,
        'slider: the wheel over it is taken before the slider and leaves the value alone');

    // The shortcut: nothing by default; a plain letter or a lone modifier is no
    // shortcut, Esc cancels, Backspace and the clear button clear.
    const sc = rows['panel-shortcut'];
    const press = (keyval, state = 0) => sc.keys.emit('key-pressed', keyval, 0, state);
    const CTRL_ALT = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK;
    const stored = () => settings.get_strv('panel-shortcut').join();
    ok(stored() === '' && sc.label.accelerator === '' && !sc.clear.visible && !sc.subtitle, `shortcut: none by default ('${stored()}')`);
    sc.emit('activated');
    ok(sc.listening && sc.subtitle === 'Press keys…', `shortcut: activating it listens ('${sc.subtitle}')`);
    press(Gdk.KEY_a);
    press(Gdk.KEY_a, Gdk.ModifierType.SHIFT_MASK);
    press(Gdk.KEY_Control_L, Gdk.ModifierType.CONTROL_MASK);
    ok(sc.listening && stored() === '', `shortcut: a plain letter, Shift+letter and a lone modifier are refused ('${stored()}')`);
    press(Gdk.KEY_Escape);
    ok(!sc.listening && stored() === '' && !sc.subtitle, 'shortcut: Esc cancels');
    ok(!press(Gdk.KEY_k, CTRL_ALT) && stored() === '', 'shortcut: keys are left alone when not listening');
    sc.emit('activated');
    press(Gdk.KEY_K, CTRL_ALT);
    ok(stored() === '<Control><Alt>k' && !sc.listening && sc.label.accelerator === '<Control><Alt>k' && sc.clear.visible, `shortcut: stored '${stored()}', shown '${sc.label.accelerator}'`);
    sc.emit('activated');
    press(Gdk.KEY_BackSpace);
    ok(stored() === '' && !sc.clear.visible, `shortcut: Backspace clears ('${stored()}')`);
    sc.emit('activated');
    press(Gdk.KEY_F9);
    ok(stored() === 'F9', `shortcut: a function key alone is enough ('${stored()}')`);
    sc.clear.emit('clicked');
    ok(stored() === '', 'shortcut: the clear button clears');

    const size = rows['panel-size'];
    ok(size.subtitle === 'Automatic' && !size.resetButton.sensitive, `panel size: '${size.subtitle}' by default`);
    settings.set_int('menu-custom-width', 420);
    settings.set_int('menu-custom-height', 560);
    ok(size.subtitle.startsWith('420 × 560') && size.resetButton.sensitive, `panel size: follows a dragged size ('${size.subtitle}')`);
    size.resetButton.emit('clicked');
    ok(settings.get_int('menu-custom-width') === 0 && settings.get_int('menu-custom-height') === 0 && size.subtitle === 'Automatic',
        'panel size: Reset clears the size');
    await sleep(300);
    ok(!built.powerGroup.visible, 'power: the fix is offered on a machine without energy counters');

    // After dispose() the rows no longer follow the settings.
    built.dispose();
    settings.set_string('unit-temp', 'C');
    const stale = rows['unit-temp'].selected;
    settings.set_string('unit-temp', 'F');
    ok(rows['unit-temp'].selected === stale, 'dispose: a row still follows the settings');
    built.window.destroy();
    GLib.rmdir(emptyRoot);

    // Counters that exist but may not be read: the fix is offered.
    const blockedRoot = GLib.dir_make_tmp('rp-prefs-powercap-XXXXXX');
    const zone = `${blockedRoot}/intel-rapl:0`;
    GLib.mkdir_with_parents(zone, 0o755);
    GLib.file_set_contents(`${zone}/name`, 'package-0\n');
    GLib.file_set_contents(`${zone}/energy_uj`, '1\n');
    Gio.File.new_for_path(`${zone}/energy_uj`).set_attribute_uint32('unix::mode', 0o000, Gio.FileQueryInfoFlags.NONE, null);
    const shownSettings = newSettings();
    const shown = build(shownSettings, new PowerSampler(blockedRoot));
    await sleep(300);
    if (Gio.Credentials.new().get_unix_user() === 0)
        print('PREFS-CHECK SKIP: unreadable counters cannot be simulated as root');
    else
        ok(shown.powerGroup.visible, 'power: the fix is not offered while the counters are blocked');
    for (const name of ['name', 'energy_uj']) GLib.unlink(`${zone}/${name}`);
    GLib.rmdir(zone);
    GLib.rmdir(blockedRoot);

    // The window's stylesheet parses cleanly, dark and light, in the variant
    // this libadwaita loads (CSS variables from 1.6, named colours before).
    const { windowCss, styleWindow } = await import(`file://${root}/ui/prefs/style.js`);
    const modern = Adw.get_minor_version() >= 6;
    for (const dark of [true, false]) {
        for (const variables of [modern]) {
            const provider = new Gtk.CssProvider();
            const errors = [];
            provider.connect('parsing-error', (_p, section, error) => errors.push(`${section.to_string()}: ${error.message}`));
            provider.load_from_string(windowCss(dark, variables));
            ok(errors.length === 0, `style (${dark ? 'dark' : 'light'}, ${variables ? 'variables' : 'named colours'}): ${errors.join('; ')}`);
        }
    }

    const battery = await batteryPages(styleWindow);
    await entryPoints();
    await backup();

    // What the window really shows, read back from its rendering: the test
    // shell carries a third-party theme as the user stylesheet (dev.sh), which
    // GTK ranks above application stylesheets, so a look that only holds
    // without it fails here.
    if (Gdk.Display.get_default()) await renderedLook(shown, battery);
    else print('PREFS-CHECK SKIP: no display, the rendered look is not checked');

    print(`PREFS-CHECK ${failures === 0 ? 'DONE' : 'FAILED'}: ${checks - failures} of ${checks} checks passed`);
    // Leave windows up for the driver's screenshots, one page at a time; the
    // driver shoots on each SHOW line.
    const linger = Number(ARGV[1] ?? 0);
    if (linger > 0) {
        shown.window.set_default_size(640, 660);
        battery.window.set_default_size(720, 680);
        // Each tab from top to bottom, in both variants.
        const manager = Adw.StyleManager.get_default();
        const pages = [[shown.window, 'settings'], [battery.window, 'tracking'], [battery.window, 'diagnostics']];
        for (const [variant, scheme] of [['light', Adw.ColorScheme.FORCE_LIGHT], ['dark', Adw.ColorScheme.FORCE_DARK]]) {
            manager.color_scheme = scheme;
            for (const [window, name] of pages) {
                for (const other of [shown.window, battery.window]) if (other !== window) other.hide();
                window.present();
                if (window === battery.window) window.set_visible_page_name(name);
                const adj = findScrolled(window.get_visible_page())?.get_vadjustment();
                for (let part = 0, done = false; !done && part < 6; part++) {
                    await sleep(300);
                    if (adj) {
                        adj.value = Math.min(part * (adj.page_size - 60), adj.upper - adj.page_size);
                        done = adj.value >= adj.upper - adj.page_size - 1;
                    } else {
                        done = true;
                    }
                    print(`PREFS-CHECK SHOW ${variant}-${name}-${part + 1}`);
                    await sleep(linger);
                }
            }
        }
        // One window titled Resource Pulse at a time: the driver clicks into that one.
        battery.window.hide();
        await settingsClicks(shown.window, shown, shownSettings);
        shown.window.hide();
        await agentClicks(battery.window, battery.settings, battery.diagnostics, battery.fake);
        await findingClicks(battery.window, battery.diagnostics);
        await componentClicks(battery.window, battery.tracking.rows);
        shown.window.destroy();
    }
    shown.dispose();
    battery.dispose();
    battery.window.destroy();
}

// Where the window was opened from: the Extensions app (no prefs-page)
// gets the settings only; the panel (prefs-page set) also gets Tracking and
// Diagnostics, also when it asks while a settings-only window is open.
// Settings saved to a file and restored, a file with bad values, and reset,
// on memory-backed settings; the group itself on the Settings page.
async function backup() {
    const { exportSettings, importSettings, resetSettings, buildBackupGroup } = await import(`file://${root}/ui/prefs/backup.js`);
    const { BackupError } = await import(`file://${root}/lib/common/backup.js`);
    const dir = GLib.dir_make_tmp('rp-prefs-backup-XXXXXX');
    const file = Gio.File.new_for_path(`${dir}/settings.json`);
    const settings = newSettings();
    settings.set_int('poll-interval', 5);
    settings.set_string('unit-temp', 'F');
    settings.set_strv('pinned-metrics', ['gpu', 'cpu']);
    settings.set_string('prefs-page', 'tracking');
    await exportSettings(settings, file);
    const [, saved] = file.load_contents(null);
    const doc = JSON.parse(new TextDecoder().decode(saved));
    ok(doc.settings['poll-interval'] === 5 && !('prefs-page' in doc.settings), `backup: saved ${JSON.stringify(doc.settings).slice(0, 120)}`);

    resetSettings(settings);
    ok(settings.get_int('poll-interval') === 2 && settings.get_string('unit-temp') === 'C' && settings.get_string('prefs-page') === 'tracking',
        'backup: reset restores the defaults and leaves the window\'s signals');
    const restored = await importSettings(settings, file);
    ok(settings.get_int('poll-interval') === 5 && settings.get_string('unit-temp') === 'F' && settings.get_strv('pinned-metrics').join() === 'gpu,cpu' &&
        restored.rejected.length === 0, `backup: restored ${restored.applied} settings, rejected ${JSON.stringify(restored.rejected)}`);

    GLib.file_set_contents(`${dir}/settings.json`, JSON.stringify({ format: 'resource-pulse-settings', version: 1,
        settings: { 'poll-interval': 99, 'unit-mem': 'GiB', 'made-up': true } }));
    const partly = await importSettings(settings, file);
    ok(partly.applied === 1 && settings.get_string('unit-mem') === 'GiB' && settings.get_int('poll-interval') === 5 &&
        partly.rejected.map(r => r.key).join() === 'poll-interval,made-up', `backup: a file with bad values: ${JSON.stringify(partly)}`);

    GLib.file_set_contents(`${dir}/settings.json`, 'not a settings file');
    let refused = null;
    try {
        await importSettings(settings, file);
    } catch (e) {
        refused = e;
    }
    ok(refused instanceof BackupError, `backup: a file that is not a backup is refused (${refused?.message})`);

    const page = new Adw.PreferencesPage();
    const built = buildBackupGroup(page, settings);
    ok(built.rows.save && built.rows.restore && built.rows.reset && built.buttons.reset.has_css_class('destructive-action'),
        'backup: the group has Save, Open and a destructive Reset');
    GLib.unlink(`${dir}/settings.json`);
    GLib.rmdir(dir);
}

async function entryPoints() {
    const { fillWindow } = await import(`file://${root}/ui/prefs/window.js`);
    const dir = GLib.dir_make_tmp('rp-prefs-entry-XXXXXX');
    const stubs = {
        historyPath: `${dir}/battery-history.json`,
        diagnostics: {
            readState: () => Promise.resolve({ battery: null, onBattery: false, backlight: null, powerProfile: null, energyReadable: true }),
            switchProfile: () => Promise.resolve(),
            launch: () => {},
        },
    };
    const open = settings => {
        const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
        const filled = fillWindow(window, { settings, path: root, ...stubs });
        return { window, filled };
    };
    // The tabs in the order shown.
    const tabs = window => findAll(window, w => w instanceof Adw.PreferencesPage && w.name).map(page => page.name).join();

    // The Extensions app: settings only.
    const settings = newSettings();
    const app = open(settings);
    await sleep(200);
    ok(!app.filled.panelPages() && tabs(app.window) === 'settings', `entry: from the Extensions app the window has ${tabs(app.window)}`);
    // The panel asks while it is open: its tabs are added and the page shown.
    settings.set_string('prefs-page', 'diagnostics');
    await sleep(200);
    ok(app.filled.panelPages() && app.window.visible_page_name === 'diagnostics', `entry: a panel request on an open window shows ${app.window.visible_page_name}`);
    ok(settings.get_string('prefs-page') === '', 'entry: the request is cleared once taken');
    ok(tabs(app.window) === 'settings,tracking,diagnostics', `entry: then the window has ${tabs(app.window)}`);
    app.filled.dispose();
    app.window.destroy();

    // The panel: all three tabs, on the page it asked for.
    const fromPanel = newSettings();
    fromPanel.set_string('prefs-page', 'tracking');
    const panel = open(fromPanel);
    await sleep(200);
    ok(panel.filled.panelPages() && panel.window.visible_page_name === 'tracking', `entry: from the panel the window opens on ${panel.window.visible_page_name}`);
    ok(fromPanel.get_string('prefs-page') === '' && tabs(panel.window) === 'settings,tracking,diagnostics', `entry: from the panel the window has ${tabs(panel.window)}`);
    panel.filled.dispose();
    panel.window.destroy();

    GLib.rmdir(dir);
}

function findAll(widget, test, out = []) {
    if (test(widget)) out.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) findAll(child, test, out);
    return out;
}

// RGBA bytes of a widget as drawn on its own (its background and children).
function render(widget) {
    const width = widget.get_width();
    const height = widget.get_height();
    const snapshot = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({ widget }).snapshot(snapshot, width, height);
    const node = snapshot.to_node();
    if (!node) return null;
    const texture = widget.get_native().get_renderer().render_texture(node, new Graphene.Rect().init(0, 0, width, height));
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
    const [bytes, stride] = downloader.download_bytes();
    const data = bytes.toArray();
    return { width, height, texture, at: (x, y) => Array.from(data.slice(Math.round(y) * stride + Math.round(x) * 4, Math.round(y) * stride + Math.round(x) * 4 + 4)) };
}

const hex = colour => [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
const near = (rgb, colour, tolerance = 14) => hex(colour).every((v, i) => Math.abs(v - rgb[i]) <= tolerance);
const show = rgb => `rgb(${rgb.slice(0, 3).join(', ')})`;

/**
 * An open dropdown (Adw.ComboRow) in `window`: its current value on the card,
 * its options on the popover's colour, text readable.
 */
async function dropdownLook(window, combo, variant, p, pageName) {
    window.present();
    window.set_visible_page_name(pageName);
    await sleep(400);
    const lum = c => (c[0] + c[1] + c[2]) / 3;
    // The last opaque pixel a widget draws: its text's ink.
    const inkOf = widget => {
        const drawn = widget && render(widget);
        let last = null;
        for (let y = 0; drawn && y < drawn.height; y++) {
            for (let x = 0; x < drawn.width; x++) {
                const px = drawn.at(x, y);
                if (px[3] > 200) last = px;
            }
        }
        return last;
    };

    // Its current value, in the row: on the card, readable. The
    // stand-in theme paints every list white, as some themes do (Orchis
    // exempts this one), which left white boxes behind the values.
    const scrolled = findScrolled(window.get_visible_page());
    const adj = scrolled?.get_vadjustment();
    const [okTop, top] = scrolled ? combo.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0)) : [false, null];
    // (top is where it shows now, so relative to the current scroll)
    if (adj && okTop) adj.value = Math.min(Math.max(0, adj.value + top.y - 40), adj.upper - adj.page_size);
    await sleep(300);
    const inline = findAll(combo, w => w.get_css_name() === 'listview' && !w.get_ancestor(Gtk.Popover.$gtype))[0];
    const rowShot = render(window);
    const [okValue, edge] = inline ? inline.compute_point(window, new Graphene.Point().init(1, inline.get_height() / 2)) : [false, null];
    const valueBg = okValue && rowShot ? rowShot.at(edge.x, edge.y) : null;
    ok(valueBg && near(valueBg, p.card), `look (${variant}): a dropdown's current value sits on ${valueBg ? show(valueBg) : 'nothing'}, not the card ${p.card}`);
    const valueInk = inkOf(inline && findAll(inline, w => w instanceof Gtk.Label)[0]);
    ok(valueInk && valueBg && Math.abs(lum(valueInk) - lum(valueBg)) > 110,
        `look (${variant}): a dropdown's current value ${valueInk ? show(valueInk) : 'not drawn'} on ${valueBg ? show(valueBg) : 'nothing'} is not readable`);

    // Open: its options on the popover's colour, text readable.
    const popover = findAll(combo, w => w instanceof Gtk.Popover)[0];
    popover.popup();
    // Rendered from its contents node, which paints the surface: the
    // popover itself is a native surface and renders nothing this way
    // on GTK 4.18 (GNOME 48). Waited for until it has drawn with its
    // options laid out. On GTK 4.18 a popover opened from code (no user
    // input) in a window that has been up a while is sometimes never
    // painted, although the compositor configures it and frames tick;
    // opened again, it paints at once. So it is reopened after each
    // second without a drawing.
    let options = [];
    let option = null;
    let surface = popover;
    let popShot = null;
    for (let waited = 0; waited < 5000 && !popShot; waited += 100) {
        await sleep(100);
        options = findAll(popover, w => w.get_css_name() === 'row');
        option = options[1] ?? options[0];
        surface = findAll(popover, w => w.get_css_name() === 'contents')[0] ?? popover;
        if (popover.get_mapped() && option?.get_width() > 0) popShot = render(surface);
        if (!popShot && waited % 1000 === 900) {
            popover.popdown();
            await sleep(200);
            popover.popup();
        }
    }
    const [okOption, at] = option ? option.compute_point(surface, new Graphene.Point().init(option.get_width() - 4, option.get_height() / 2)) : [false, null];
    const listBg = okOption && popShot ? popShot.at(at.x, at.y) : null;
    ok(listBg && near(listBg, p.popover), listBg
        ? `look (${variant}): an open dropdown's list is ${show(listBg)}, not ${p.popover}`
        : `look (${variant}): the dropdown's list was not on screen after 5 s (mapped ${popover.get_mapped()}, ${options.length} options)`);
    const optionInk = inkOf(option && findAll(option, w => w instanceof Gtk.Label)[0]);
    ok(optionInk && listBg && Math.abs(lum(optionInk) - lum(listBg)) > 110,
        `look (${variant}): dropdown text ${optionInk ? show(optionInk) : 'not drawn'} on ${listBg ? show(listBg) : 'no list'} is not readable`);
    popover.popdown();
    // Back to the top, where the next variant's checks look.
    if (adj) adj.value = 0;
    await sleep(200);
}

/**
 * The Settings page's parts as rendered: the preview bar dark in both
 * variants, a pinned chip in its metric's tint and an unpinned one on the
 * card, the checked segment and the slider's highlight in the accent, the
 * slider's knob white.
 */
async function settingsPartsLook(window, shown, variant, p) {
    const { TINTS } = await import(`file://${root}/ui/prefs/style.js`);
    const scrolled = findScrolled(window.get_visible_page());
    const adj = scrolled?.get_vadjustment();
    const at = async (widget, x, y) => {
        const [okTop, top] = scrolled ? widget.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0)) : [false, null];
        if (adj && okTop) adj.value = Math.min(Math.max(0, adj.value + top.y - 60), adj.upper - adj.page_size);
        await painted(window);
        const shot = render(window);
        const [okPoint, out] = widget.compute_point(window, new Graphene.Point().init(x, y));
        return okPoint && shot ? shot.at(out.x, out.y) : [0, 0, 0, 0];
    };
    const bar = findAll(shown.rows.preview, w => w.has_css_class?.('rp-preview-bar'))[0];
    // Widget coordinates start at the content box: a few pixels left is the padding.
    const barBg = await at(bar, -6, bar.get_height() / 2);
    ok(near(barBg, '#0b0c0f'), `look (${variant}): the top-bar preview is ${show(barBg)}, not dark`);
    const pinned = shown.pinRows.cpu;
    const tint = TINTS.cpu[variant === 'dark' ? 0 : 1][0];
    const pinnedBg = await at(pinned, -5, pinned.get_height() / 2);
    ok(pinned.active && near(pinnedBg, tint), `look (${variant}): a pinned chip is ${show(pinnedBg)}, not the CPU tint ${tint}`);
    const loose = Object.values(shown.pinRows).find(chip => !chip.active);
    const looseBg = await at(loose, -5, loose.get_height() / 2);
    ok(near(looseBg, p.card), `look (${variant}): an unpinned chip is ${show(looseBg)}, not the card ${p.card}`);
    const segmented = shown.rows['unit-temp'];
    const checked = segmented.buttons[segmented.selected];
    const segmentBg = await at(checked, -6, checked.get_height() / 2);
    ok(near(segmentBg, '#3584e4', 20), `look (${variant}): the checked segment is ${show(segmentBg)}, not the accent`);
    const slider = shown.rows['threshold-cpu'].scale;
    const knob = findAll(slider, w => w.get_css_name() === 'slider')[0];
    const knobPx = await at(knob, knob.get_width() / 2, knob.get_height() / 2);
    ok((knobPx[0] + knobPx[1] + knobPx[2]) / 3 > 235, `look (${variant}): the slider's knob is ${show(knobPx)}, not white`);
    const highlight = findAll(slider, w => w.get_css_name() === 'highlight')[0];
    const lit = await at(highlight, Math.min(20, highlight.get_width() / 2), highlight.get_height() / 2);
    ok(near(lit, '#3584e4', 20), `look (${variant}): the slider's filled part is ${show(lit)}, not the accent`);
    if (adj) adj.value = 0;
    await painted(window);
}

async function renderedLook(shown, battery) {
    const { palette } = await import(`file://${root}/ui/prefs/style.js`);
    const manager = Adw.StyleManager.get_default();
    const window = shown.window;
    window.set_default_size(640, 660);
    window.present();
    // A switch row that is on by default: its card, its switch, its title.
    const row = shown.rows['show-tooltips'];
    const toggle = findAll(row, w => w instanceof Gtk.Switch)[0];
    const title = findAll(row, w => w instanceof Gtk.Label && w.label === row.title)[0];
    ok(row.active && toggle && title, 'look: the Tooltips row, its switch and title were not found');
    for (const [variant, scheme] of [['dark', Adw.ColorScheme.FORCE_DARK], ['light', Adw.ColorScheme.FORCE_LIGHT]]) {
        manager.color_scheme = scheme;
        await sleep(600);
        const p = palette(variant === 'dark');
        const shot = render(window);
        if (!shot) {
            ok(false, `look (${variant}): the window rendered nothing`);
            continue;
        }
        const point = (widget, x, y) => {
            const [okPoint, out] = widget.compute_point(window, new Graphene.Point().init(x, y));
            return okPoint ? shot.at(out.x, out.y) : [0, 0, 0, 0];
        };
        // Beside the page's column, the window's own background.
        const bg = shot.at(8, shot.height / 2);
        ok(near(bg, p.window), `look (${variant}): window background is ${show(bg)}, not ${p.window}`);
        const header = findAll(window, w => w instanceof Adw.HeaderBar)[0];
        const headerBg = header ? point(header, header.get_width() * 0.3, 3) : bg;
        ok(near(headerBg, p.header), `look (${variant}): header is ${show(headerBg)}, not ${p.header}`);
        // Inside the row's left padding: the card surface.
        const card = point(row, 5, row.get_height() / 2);
        ok(near(card, p.card), `look (${variant}): card is ${show(card)}, not ${p.card}`);
        // The checked switch's track: the extension's blue. Searched over
        // the whole switch, since themes draw it in different shapes
        // (Orchis: a thin 32 x 14 track that a fixed point can miss).
        const sw = render(toggle);
        let blue = null;
        let seen = null;
        for (let y = 0; sw && y < sw.height && !blue; y++) {
            for (let x = 0; x < sw.width && !blue; x++) {
                const px = sw.at(x, y);
                if (px[3] > 200) seen ??= px;
                if (px[3] > 200 && near(px, '#3584e4', 30)) blue = px;
            }
        }
        ok(blue, `look (${variant}): a checked switch has no pixel of the extension's blue (first opaque ${seen ? show(seen) : 'none'})`);
        // The row title's ink: light on dark, dark on light.
        const text = render(title);
        let ink = null;
        for (let y = 0; text && y < text.height; y++) {
            for (let x = 0; x < text.width; x++) {
                const px = text.at(x, y);
                if (px[3] > 200) ink = px;
            }
        }
        const lightness = ink ? (ink[0] + ink[1] + ink[2]) / 3 : -1;
        ok(variant === 'dark' ? lightness > 200 : lightness >= 0 && lightness < 90,
            `look (${variant}): row text is ${ink ? show(ink) : 'not drawn'}`);

        // The Settings page's own parts, as rendered.
        await settingsPartsLook(window, shown, variant, p);
        // An open dropdown: the Settings and Tracking pages have none left,
        // so the agent's (the same widget as every dropdown in the window).
        await dropdownLook(battery.window, battery.diagnostics.agent.agentRow, variant, p, 'diagnostics');
        window.present();
        await sleep(300);
    }
    manager.color_scheme = Adw.ColorScheme.DEFAULT;
    window.hide();
}

function findScrolled(widget) {
    if (!widget) return null;
    if (widget instanceof Gtk.ScrolledWindow) return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findScrolled(child);
        if (found) return found;
    }
    return null;
}

// The Tracking and Diagnostics pages on a fixture history: two hours on
// battery with a chat app working in the background and an editor in use,
// the machine swapping, and data moving while the user is away.
/**
 * A battery history of two hours on battery with two apps (chat, editor), saved
 * to a temporary file: the Tracking and Diagnostics pages' fixture.
 */
async function fixtureHistory() {
    const { BatteryLedger, saveLedger } = await import(`file://${root}/lib/engine/batteryledger.js`);
    const dir = GLib.dir_make_tmp('rp-prefs-history-XXXXXX');
    const path = `${dir}/battery-history.json`;
    const ledger = new BatteryLedger();
    const start = Date.now() - 2 * 3600 * 1000;
    const c = { chat: 0, editor: 0, sys: 0, total: 0 };
    for (let i = 0; i < 240; i++) {
        c.chat += 0.4e6;
        c.editor += 0.3e6;
        c.sys += 0.1e6;
        c.total += 0.9e6;
        ledger.ingest({
            mono: 1e9 + i * 30e6, wall: start + i * 30000,
            usage: { total: c.total, system: c.sys, units: [
                { unit: 'app-gnome-chat-1.scope', id: 'chat', kind: 'app', label: 'chat', usec: c.chat, memory: 1536 * 2 ** 20 },
                { unit: 'app-gnome-editor-2.scope', id: 'editor', kind: 'app', label: 'editor', usec: c.editor, memory: 300 * 2 ** 20 },
            ] },
            // Varies like a real machine, so an idle level below the mean is learnt.
            packageW: 5 + (i % 7),
            battery: { present: true, onBattery: true, energyWh: 40 - i * 9.5 * 30 / 3600 },
            focusUsec: { editor: 30e6 },
            uncoreW: 3,
            gpu: new Map([['app-gnome-chat-1.scope', i * 2e9], ['app-gnome-editor-2.scope', i * 0.5e9]]),
            // 150 MiB of swap traffic an hour; 50 kB/s while away.
            machine: { memTotal: 8 * 2 ** 30, memUsed: 6 * 2 ** 30, swapTotal: 2 * 2 ** 30, swapUsed: 2 ** 30,
                swapInBytes: i * 1.25 * 2 ** 20, swapOutBytes: 0, pressure: { cpu: 0, memory: 0, memoryFull: 0, io: 0 },
                disks: [{ name: 'nvme0n1', readBytes: i * 1e6, writtenBytes: i * 4e6 }] },
            // The editor writes 2 MB per sample; the chat reads 0.5 MB.
            appIo: new Map([['app-gnome-editor-2.scope', { read: 0, write: 2e6 }], ['app-gnome-chat-1.scope', { read: 5e5, write: 0 }]]),
            temp: i % 2 ? 50 : 60,
            net: [{ iface: 'wlan0', rxBytes: i * 1.5e6, txBytes: 0 }],
            idle: true,
        });
    }
    // Battery health: a few days of wear.
    for (let i = 0; i < 5; i++) {
        const d = new Date(Date.now() - (4 - i) * 86400e3);
        ledger.noteHealth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, { health: 88 - i * 0.5, cycles: 210 + i, fullWh: 39.5 - i * 0.2 });
    }
    await saveLedger(path, ledger);
    return { dir, path, ledger };
}

async function batteryPages(styleWindow) {
    const { HistorySource, buildTrackingPage } = await import(`file://${root}/ui/prefs/tracking.js`);
    const { buildDiagnosticsPage } = await import(`file://${root}/ui/prefs/diagnostics.js`);
    const { BatteryLedger, saveLedger } = await import(`file://${root}/lib/engine/batteryledger.js`);

    const { dir, path, ledger } = await fixtureHistory();

    const settings = newSettings();
    const history = new HistorySource(settings, path);
    const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
    const style = styleWindow(window);
    ok(window.has_css_class('rp-window') && style.css().includes('#3584e4'), 'style: the window carries the extension\'s look and accent');
    const { metricIcon } = await import(`file://${root}/ui/prefs/rows.js`);
    const tracking = buildTrackingPage(settings, history, { fullWh: () => 40, iconFor: key => metricIcon(key, root) });
    window.add(tracking.page);
    const profileCalls = [];
    const launched = [];
    let profile = 'performance';
    const fake = fakeAgentBin();
    const confirmAnswers = [];
    // A real process stands in for the running "chat" app, for its finding's Pause and Lower priority.
    const chatProc = Gio.Subprocess.new(['sleep', '600'], Gio.SubprocessFlags.NONE);
    const chatPid = Number(chatProc.get_identifier());
    const { processIdentity } = await import(`file://${root}/lib/collectors/process.js`);
    const chatMembers = [{ pid: chatPid, start: processIdentity(chatPid).start }];
    const diagnostics = buildDiagnosticsPage(history, {
        settings,
        iconFor: key => metricIcon(key, root),
        appProcesses: async () => new Map([['chat', chatMembers]]),
        agent: {
            dir: fake.agentDir,
            which: fake.which,
            spawn: fake.spawn,
            // Driven by the shell (linger), the real dialog is clicked with the
            // pointer; alone, the answers are given here.
            ...(driven ? {} : { confirm: () => Promise.resolve(confirmAnswers.shift() ?? 'cancel') }),
        },
        readState: () => Promise.resolve({
            battery: { healthPct: 72, cycles: 610, fullWh: 40, chargeLimit: 'off' },
            onBattery: true, backlight: 0.95, powerProfile: profile, energyReadable: true,
        }),
        switchProfile: value => {
            profileCalls.push(value);
            profile = value;
            return Promise.resolve();
        },
        launch: argv => launched.push(argv.join(' ')),
    });
    window.add(diagnostics.page);
    await sleep(300);

    const r = tracking.rows;
    ok(!r.tracking.active && r.status.subtitle.startsWith('Off'), `tracking: off by default, status '${r.status.subtitle}'`);
    // 0.1 s per sample is not in any named unit: kernel and other users.
    ok(r.appRows.map(row => row.appId).join() === 'chat,editor,@system,@other',
        `tracking: apps ranked ${r.appRows.map(row => row.appId).join()}, expected chat,editor,@system,@other`);
    ok(r.appRows[0].share > r.appRows[1].share && r.appRows[0].subtitle.includes('100 % background') &&
        r.appRows[1].subtitle.includes('0 % background'), `tracking: shares and background split ('${r.appRows[0].subtitle}' / '${r.appRows[1].subtitle}')`);
    ok(r.drain.value.label === '9.5 W' && r.runtime.value.label === '4h 12m' && r.used.detail.label.includes('% of a full charge'),
        `tracking: summary '${r.used.value.label}' (${r.used.detail.label}), '${r.drain.value.label}', '${r.runtime.value.label}'`);
    // Two hours on battery, one bar per hour: the chart has them, battery above processor.
    // (The fixture's power is constant, so once the idle level is learnt the processor part is 0.)
    const filled = r.chart.points.filter(p => p.battery > 0);
    ok(r.chart.box.visible && filled.length >= 2 && filled.length <= 3 && filled.some(p => p.processor > 0) && filled.every(p => p.processor <= p.battery),
        `tracking: chart bars ${filled.map(p => `${p.battery.toFixed(2)}/${p.processor.toFixed(2)}`).join(' ')}`);
    ok(Math.abs(filled.reduce((t, p) => t + p.battery, 0) - parseFloat(r.used.value.label)) < 0.1, 'tracking: the bars add up to the battery used');
    ok(r.rest.visible && r.idle.value.label !== 'not measured', 'tracking: the unmeasured rest and the idle share are shown');
    ok(r.graphics.visible && / GPU/.test(r.appRows[1].subtitle), `tracking: graphics share and time shown ('${r.appRows[1].subtitle}')`);

    r.batteryOnly.active = false;
    ok(r.time.title === 'Time recorded' && !r.drain.visible && !r.chart.box.visible, 'tracking: the AC-and-battery view drops the battery figures');
    r.batteryOnly.active = true;
    r.period.selected = 1; // today: may or may not include the fixture, but must not fail
    r.period.selected = 3;
    ok(r.appRows.length === 4, 'tracking: the 14-day view has the same apps');

    // Battery health on the Battery tab, whatever the period: the figures and the bars.
    ok(r.healthGroup.visible && r.healthNow.value.label === '86.0 %' && r.healthChange.value.label === '-2.0 %' &&
        r.healthFull.value.label === '38.7 Wh' && r.healthCycles.value.label === '214',
    `battery health: ${r.healthNow.value.label}, ${r.healthChange.value.label}, ${r.healthFull.value.label}, ${r.healthCycles.value.label}`);
    ok(/^since \d{4}-\d{2}-\d{2}$/.test(r.healthChange.detail.label), `battery health: change reads '${r.healthChange.detail.label}'`);
    ok(r.health.box.visible && r.health.chart.points.length === 5 && r.health.chart.floor === 80 && r.health.hover.details(4).lines[0][2] === '86.0 %',
        `battery health: chart of ${r.health.chart.points.length} bars from ${r.health.chart.floor}`);
    r.health.hover.set(4);
    ok(/health 86\.0 %/.test(r.health.hover.text()), `battery health: a bar reads '${r.health.hover.text()}'`);
    r.health.hover.set(-1);

    await componentChecks(r, window);

    r.tracking.active = true;
    ok(settings.get_boolean('battery-tracking'), 'tracking: the switch writes the setting');
    ok(settings.get_boolean('action-flush-history'), 'tracking: switching on asks the extension for current figures');
    settings.set_boolean('action-flush-history', false);
    ok(r.status.subtitle.startsWith('Recording'), `tracking: status while on is '${r.status.subtitle}'`);

    // Diagnostics on the stubbed state.
    for (let i = 0; i < 20 && diagnostics.state.running; i++) await sleep(100);
    const found = () => diagnostics.rows;
    const ids = found().map(row => row.findingId);
    ok(['wear', 'background:chat', 'power-profile', 'brightness', 'charge-limit'].every(id => ids.includes(id)) && !ids.includes('background:editor'),
        `diagnostics: findings ${ids.join(', ')}`);
    const inArea = area => found().filter(row => row.area === area).map(row => row.findingId);
    const batteryIds = inArea('battery');
    ok(batteryIds[0] === 'wear' && batteryIds.includes('charge-limit') && batteryIds.includes('background:chat'),
        `diagnostics: battery findings ${batteryIds.join()}, the warning first`);
    ok(inArea('memory').join() === 'swapping' && inArea('network').join() === 'traffic-away',
        `diagnostics: memory ${inArea('memory').join()}, network ${inArea('network').join()}`);
    ok(!diagnostics.nothing.get_parent(), 'diagnostics: no "nothing found" row with findings');
    // One list, warnings first; each row's area is its icon, its severity its edge.
    const order = { warning: 0, suggestion: 1, info: 2 };
    const sevs = found().map(row => order[row.severity]);
    ok(sevs.every((v, i) => i === 0 || v >= sevs[i - 1]) && found()[0].severity === 'warning',
        `diagnostics: one list, warnings first (${found().map(row => `${row.findingId}:${row.severity}`).join(', ')})`);
    ok(found().every(row => row.has_css_class(`rp-edge-${row.severity}`)), 'diagnostics: each row carries its severity edge');
    // Its own class kept: without 'expander' themes style the header as a plain list (Orchis: white).
    ok(found().every(row => row.has_css_class('expander')), `diagnostics: a finding row lost its 'expander' class (${found()[0]?.get_css_classes().join('.')})`);
    // The strip: counts per area, orange with a warning, a ✓ for none.
    const t = diagnostics.tiles;
    ok(t.memory.count.label === '1' && t.memory.count.has_css_class('rp-finding-warning') && t.network.count.label === '1' &&
        t.network.count.has_css_class('rp-finding-suggestion') && t.cpu.count.label === '✓' && Number(t.battery.count.label) >= 3,
        `diagnostics: tile counts cpu ${t.cpu.count.label}, memory ${t.memory.count.label}, battery ${t.battery.count.label}, network ${t.network.count.label}`);
    // Pressing a tile shows only its area; pressing it again shows all.
    t.battery.active = true;
    const shown = () => found().filter(row => row.visible).map(row => row.area);
    ok(shown().length === inArea('battery').length && shown().every(a => a === 'battery') && t.battery.has_css_class('rp-tint-battery'),
        `diagnostics: the battery tile shows only battery (${shown().join()})`);
    t.memory.active = true;
    ok(!t.battery.active && shown().every(a => a === 'memory'), `diagnostics: another tile takes over (${shown().join()})`);
    t.memory.active = false;
    ok(shown().length === found().length && diagnostics.state.filter === null, 'diagnostics: pressed again, every finding is shown');
    // As rendered, both variants: a warning's edge is orange, a suggestion's blue.
    if (Gdk.Display.get_default()) {
        const manager = Adw.StyleManager.get_default();
        window.present();
        window.set_visible_page_name('diagnostics');
        for (const scheme of [Adw.ColorScheme.FORCE_DARK, Adw.ColorScheme.FORCE_LIGHT]) {
            manager.color_scheme = scheme;
            await sleep(300);
            await painted(window);
            // Each row rendered on its own: what it paints, its edge included.
            const edgeOf = row => {
                const drawn = render(row);
                return drawn ? drawn.at(1, Math.min(25, drawn.height / 2)) : null;
            };
            // RP_SHOT_DIR=<dir>: the strip and the list as PNGs, to look at.
            const shotDir = GLib.getenv('RP_SHOT_DIR');
            if (shotDir) {
                const v = scheme === Adw.ColorScheme.FORCE_DARK ? 'dark' : 'light';
                render(diagnostics.tiles.cpu.get_parent())?.texture.save_to_png(`${shotDir}/diag-strip-${v}.png`);
                render(diagnostics.list)?.texture.save_to_png(`${shotDir}/diag-list-${v}.png`);
            }
            const warning = found().find(row => row.severity === 'warning');
            const suggestion = found().find(row => row.severity === 'suggestion');
            const [w, s] = [edgeOf(warning), edgeOf(suggestion)];
            const variant = scheme === Adw.ColorScheme.FORCE_DARK ? 'dark' : 'light';
            ok(w && near(w, '#ff7800', 40) && s && near(s, '#3584e4', 40),
                `diagnostics (${variant}): severity edges warning ${w ? show(w) : 'not drawn'}, suggestion ${s ? show(s) : 'not drawn'}`);
            // Readable: a row's title against its own background (a theme
            // can paint the header white under off-white text).
            const lum = c => (c[0] + c[1] + c[2]) / 3;
            // The card behind the row is the list's: sampled from the list, beside the title.
            const drawnList = render(diagnostics.list);
            const [okBg, spot] = warning.compute_point(diagnostics.list, new Graphene.Point().init(Math.round(warning.get_width() * 0.7), 10));
            const bg = okBg && drawnList ? drawnList.at(spot.x, spot.y) : null;
            const titleLabel = findAll(warning, x => x instanceof Gtk.Label && x.label === warning.title)[0];
            const text = titleLabel && render(titleLabel);
            let ink = null;
            for (let y = 0; text && y < text.height; y++) {
                for (let x = 0; x < text.width; x++) {
                    const px = text.at(x, y);
                    if (px[3] > 200 && (!ink || Math.abs(lum(px) - lum(bg ?? px)) > Math.abs(lum(ink) - lum(bg ?? ink)))) ink = px;
                }
            }
            ok(bg && ink && Math.abs(lum(ink) - lum(bg)) > 110 && (variant === 'dark' ? lum(bg) < 90 : true),
                `diagnostics (${variant}): a finding's title ${ink ? show(ink) : 'not drawn'} on ${bg ? show(bg) : 'nothing'} is not readable`);
        }
        manager.color_scheme = Adw.ColorScheme.DEFAULT;
    }
    const chat = found().find(row => row.findingId === 'background:chat');
    ok(/^≈[\d.]+ W · \+\d+ min per charge$/.test(chat.subtitle), `diagnostics: the saving is the subtitle ('${chat.subtitle}')`);
    ok(chat instanceof Adw.ExpanderRow && !chat.expanded && /without focus/.test(chat.detailLabel.label),
        `diagnostics: the detail and evidence open beneath ('${chat.detailLabel.label.split('\n').pop()}')`);
    // The app is running: pause it, resume it, lower its priority from its finding.
    ok(chat.pauseButton?.label === 'Pause' && chat.lowerButton?.visible, `diagnostics: chat's finding offers '${chat.pauseButton?.label}' and Lower priority (${chat.lowerButton?.visible})`);
    ok(!found().find(row => row.findingId === 'swapping').pauseButton, 'diagnostics: a finding about no app offers no process action');
    chat.pauseButton.emit('clicked');
    ok(await until(() => processIdentity(chatPid)?.state === 'T' && chat.pauseButton.label === 'Resume'), `diagnostics: Pause stopped chat (${processIdentity(chatPid)?.state}), the button reads '${chat.pauseButton.label}'`);
    chat.pauseButton.emit('clicked');
    ok(await until(() => processIdentity(chatPid)?.state !== 'T' && chat.pauseButton.label === 'Pause'), `diagnostics: Resume continued chat (${processIdentity(chatPid)?.state})`);
    chat.lowerButton.emit('clicked');
    ok(await until(() => processIdentity(chatPid)?.nice === 10 && !chat.lowerButton.visible), `diagnostics: Lower priority set niceness ${processIdentity(chatPid)?.nice}, and is not offered again`);
    found().find(row => row.findingId === 'charge-limit').actionButton.emit('clicked');
    await sleep(300);
    ok(launched.join() === 'gnome-control-center power', `diagnostics: the charge-limit action opens Power settings (${launched.join()})`);
    found().find(row => row.findingId === 'power-profile').actionButton.emit('clicked');
    for (let i = 0; i < 20 && (profileCalls.length === 0 || diagnostics.state.running); i++) await sleep(100);
    await sleep(200);
    ok(profileCalls.join() === 'balanced' && !found().some(row => row.findingId === 'power-profile'),
        `diagnostics: switching to Balanced (${profileCalls.join()}) removes the finding`);

    // Copy report: the findings and the state, as text on the clipboard.
    diagnostics.copy.emit('clicked');
    const copied = await new Promise(resolve => diagnostics.copy.get_clipboard().read_text_async(null, (cb, res) => {
        try {
            resolve(cb.read_text_finish(res));
        } catch (e) {
            resolve(`(clipboard: ${e.message})`);
        }
    }));
    ok(/^Resource Pulse diagnostics, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\nSystem: on battery, .*battery holds 72 % of its design capacity after 610 cycles, charge limit off/.test(copied ?? ''),
        `copy report: header and system line ('${(copied ?? '').split('\n').slice(0, 2).join(' / ')}')`);
    ok(/\nBattery\n- \[\w+\] The battery is worn: /.test(copied ?? '') && /\nMemory\n- \[warning\] The machine swaps: /.test(copied ?? '') &&
        /\n- \[\w+\] chat works in the background: /.test(copied ?? '') && /\nNetwork\n/.test(copied ?? ''),
        'copy report: findings grouped by area');
    ok(diagnostics.copy.icon_name === 'object-select-symbolic' && diagnostics.copy.tooltip_text === 'Copied', `copy report: the button shows ${diagnostics.copy.icon_name} '${diagnostics.copy.tooltip_text}'`);

    // The file changes (the extension saved): both pages follow.
    ok(r.summary.visible, 'tracking: the summary is shown when there are figures');
    // File monitor + debounce + asynchronous load: well under a second with
    // inotify. When the user has run out of inotify instances (128 by
    // default; IDEs and language servers use many) GLib falls back to
    // polling the file every few seconds, so allow 10 s.
    await saveLedger(path, new BatteryLedger());
    const savedAt = GLib.get_monotonic_time();
    for (let i = 0; i < 100 && r.appRows.length > 0; i++) await sleep(100);
    ok(r.appRows.length === 0, `tracking: did not follow the file within 10 s (${r.appRows.length} rows left)`);
    print(`PREFS-CHECK INFO: the Tracking page followed the file in ${((GLib.get_monotonic_time() - savedAt) / 1000).toFixed(0)} ms`);
    ok(!r.summary.visible, 'tracking: no summary of zeros without figures');
    ok(!r.healthGroup.visible, 'battery health: nothing shown without entries');
    await saveLedger(path, ledger);
    for (let i = 0; i < 100 && r.appRows.length === 0; i++) await sleep(100);
    ok(r.appRows.length === 4, `tracking: did not pick up the restored file within 10 s (${r.appRows.length} rows)`);

    await agentSection(window, settings, diagnostics, fake, confirmAnswers);

    return {
        window,
        diagnostics,
        tracking,
        settings,
        fake,
        dispose: () => {
            tracking.dispose();
            diagnostics.dispose();
            history.dispose();
            chatProc.force_exit();
            fake.remove();
            GLib.unlink(path);
            GLib.rmdir(dir);
        },
    };
}

const driven = Number(ARGV[1] ?? 0) > 0;

/**
 * The Tracking charts read by the pointer: the bar under it, its period and
 * values; Left / Right / Escape from the keyboard; the box as rendered.
 */
async function chartHover(r, window) {
    const { barAt, barPeriod } = await import(`file://${root}/ui/prefs/tracking.js`);
    ok(barAt(44, 344, 44, 3) === 0 && barAt(343, 344, 44, 3) === 2 && barAt(150, 344, 44, 3) === 1 && barAt(10, 344, 44, 3) === -1 && barAt(100, 344, 44, 0) === -1,
        'hover: the bar under x, none left of the bars or with no bars');
    const h14 = new Date(2026, 9, 23, 14).getTime();
    ok(barPeriod([{ t: h14 }, { t: h14 + 3600e3 }], 0) === '14:00–15:00', `hover: an hour bar reads '${barPeriod([{ t: h14 }, { t: h14 + 3600e3 }], 0)}'`);
    const day = barPeriod([{ t: h14 }, { t: h14 + 86400e3 }], 1);
    ok(/24/.test(day) && !day.includes(':'), `hover: a day bar reads '${day}'`);

    // The battery chart: the fixture's two hours on battery.
    const drain = r.chart.hover;
    const points = r.chart.points;
    const full = points.findIndex(p => p.battery > 0);
    drain.set(full);
    ok(drain.index === full && drain.text().startsWith(barPeriod(points, full)) && /battery \d/.test(drain.text()) && /processor \d/.test(drain.text()),
        `hover battery: '${drain.text()}'`);
    drain.keys.emit('key-pressed', Gdk.KEY_Left, 0, 0);
    ok(drain.index === Math.max(0, full - 1), `hover battery: Left steps back (${drain.index})`);
    ok(drain.keys.emit('key-pressed', Gdk.KEY_Escape, 0, 0) && drain.index === -1 && drain.text() === '', 'hover battery: Escape clears');
    drain.keys.emit('key-pressed', Gdk.KEY_Right, 0, 0);
    ok(drain.index === points.length - 1, 'hover battery: Right with nothing chosen starts at the last bar');
    drain.set(-1);
    ok(r.chart.area.focusable, 'hover battery: the chart takes the keyboard focus');

    // A component's chart: memory, highest and average.
    r.component.selected = COMPONENTS_FOR_HOVER.indexOf('memory');
    const bars = r.bars.hover;
    const filled = r.bars.chart.points.findIndex(p => p.highest > 0);
    bars.set(filled);
    ok(/highest \d/.test(bars.text()) && /average \d/.test(bars.text()), `hover memory: '${bars.text()}'`);
    r.component.selected = COMPONENTS_FOR_HOVER.indexOf('disk');
    ok(bars.index === -1, 'hover: switching component clears the highlight');

    // As rendered: the box is dark in both variants.
    if (Gdk.Display.get_default()) {
        const manager = Adw.StyleManager.get_default();
        window.present();
        window.set_visible_page_name('tracking');
        r.component.selected = 0;
        r.batteryOnly.active = true;
        const scrolled = findScrolled(window.get_visible_page());
        // The battery view was just put back: let it be laid out before measuring it.
        await sleep(300);
        await painted(window);
        for (const scheme of [Adw.ColorScheme.FORCE_DARK, Adw.ColorScheme.FORCE_LIGHT]) {
            manager.color_scheme = scheme;
            const area = r.chart.area;
            const adj = scrolled.get_vadjustment();
            const [, top] = area.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0));
            adj.value = Math.min(Math.max(0, adj.value + top.y - 40), adj.upper - adj.page_size);
            drain.set(0);
            await painted(window);
            const shot = render(window);
            // The box sits right of the first bar, 4 px down: a point inside it.
            const [okBox, at] = area.compute_point(window, new Graphene.Point().init(44 + (area.get_width() - 44) / points.length + 30, 12));
            const px = okBox && shot ? shot.at(at.x, at.y) : [0, 0, 0, 0];
            ok(px.length === 4 && (px[0] + px[1] + px[2]) / 3 < 40,
                `hover (${scheme === Adw.ColorScheme.FORCE_DARK ? 'dark' : 'light'}): the details box is ${show(px)}, not dark (at ${at?.x?.toFixed(0)},${at?.y?.toFixed(0)} of ${shot?.width}x${shot?.height}; chart ${area.get_width()}x${area.get_height()})`);
            drain.set(-1);
        }
        manager.color_scheme = Adw.ColorScheme.DEFAULT;
        scrolled.get_vadjustment().value = 0;
    }
    r.component.selected = 0;
}
const COMPONENTS_FOR_HOVER = ['battery', 'cpu', 'memory', 'disk', 'network', 'gpu', 'thermal'];

/**
 * Zoom on the Tracking charts: into the fixture's last two hours (five-minute
 * bars, each one hoverable), out again, from the keyboard, and back to the
 * period on Reset or a new period.
 */
async function chartZoom(r) {
    const { barPeriod } = await import(`file://${root}/ui/prefs/tracking.js`);
    const chart = r.chart;
    const periodBefore = r.period.selected;
    r.period.selected = 0;
    const [lo, hi] = chart.bounds;
    ok(!chart.view && chart.points.length >= 24 && chart.points[1].t - chart.points[0].t === 3600e3 && !chart.zoomLine.reset.visible,
        `zoom: the day starts unzoomed in ${chart.points.length} hourly bars, no Reset`);
    ok(!chart.zoomLine.visible && chart.zoomLine.label.label === '', `zoom: no zoom line until zoomed ('${chart.zoomLine.label.label}')`);
    chart.zoomTo(hi - 2 * 3600e3, hi);
    ok(chart.view && chart.points.length >= 24 && chart.points.every(p => p.step === 300e3), `zoom: two hours in ${chart.points.length} five-minute bars`);
    const filled = chart.points.filter(p => p.battery > 0).length;
    ok(filled >= 20, `zoom: ${filled} of the five-minute bars carry battery figures`);
    const i = chart.points.findIndex(p => p.battery > 0) + 3;
    chart.hover.set(i);
    const t0 = GLib.DateTime.new_from_unix_local(Math.floor(chart.points[i].t / 1000));
    const period = `${t0.format('%H:%M')}–${t0.add_minutes(5).format('%H:%M')}`;
    ok(barPeriod(chart.points, i) === period && chart.hover.text().startsWith(period) && /battery \d/.test(chart.hover.text()),
        `zoom: any five-minute bar reads its own period ('${chart.hover.text()}', wanted ${period})`);
    chart.hover.set(-1);
    ok(chart.zoomLine.reset.visible && /^\d.*–.* · 5-minute bars$/.test(chart.zoomLine.label.label), `zoom: the line reads '${chart.zoomLine.label.label}', Reset shown`);
    // Not past the period, and not narrower than half an hour.
    chart.zoomTo(hi - 60e3, hi + 60e3);
    // Each render takes a new "now": the period ends a few ms after `hi`.
    ok(chart.view && chart.view.to <= chart.bounds[1] && chart.view.to - chart.view.from === 30 * 60e3,`zoom: clamped to [${(chart.view?.from - lo) / 60e3}, ${(chart.view?.to - lo) / 60e3}] min of the period`);
    const keys = chart.zoomControllers.keys;
    keys.emit('key-pressed', Gdk.KEY_minus, 0, 0);
    ok(chart.view && Math.abs(chart.view.to - chart.view.from - 3600e3) < 1000, `zoom: '-' doubles the span (${(chart.view?.to - chart.view?.from) / 60e3} min)`);
    keys.emit('key-pressed', Gdk.KEY_plus, 0, 0);
    ok(chart.view && Math.abs(chart.view.to - chart.view.from - 1800e3) < 1000, `zoom: '+' halves it (${(chart.view?.to - chart.view?.from) / 60e3} min)`);
    keys.emit('key-pressed', Gdk.KEY_0, 0, 0);
    ok(!chart.view && chart.points[1].t - chart.points[0].t === 3600e3, 'zoom: 0 goes back to the whole period');
    chart.zoomBy(0.5);
    chart.zoomLine.reset.emit('clicked');
    ok(!chart.view && !chart.zoomLine.reset.visible, 'zoom: Reset zoom goes back to the whole period');
    for (let k = 0; k < 6; k++) chart.zoomBy(2);
    ok(!chart.view, 'zoom: zooming out stops at the period');

    // A component's chart zooms on its own; tiles keep the whole period.
    r.component.selected = COMPONENTS_FOR_HOVER.indexOf('memory');
    const tilesBefore = r.componentTiles?.map(t => t.value.label).join('|');
    r.bars.zoomTo(r.bars.bounds[1] - 3600e3, r.bars.bounds[1]);
    const shown = r.bars.chart.points;
    ok(r.bars.view && (shown.length === 12 || shown.length === 13),`zoom memory: the last hour in ${shown.length} five-minute bars`);
    ok(shown.some(p => p.highest > 0) && r.bars.zoomLine.reset.visible, 'zoom memory: the bars have figures, Reset shown');
    ok(r.componentTiles?.map(t => t.value.label).join('|') === tilesBefore, 'zoom memory: the tiles still cover the whole period');
    ok(!chart.view, 'zoom: the battery chart was left as it was');
    r.period.selected = 2;
    ok(!r.bars.view && !chart.view, 'zoom: a new period drops the zoom');
    r.period.selected = periodBefore;
    r.component.selected = 0;
}


/**
 * The Tracking tab per component on the fixture (two hours: 0.4 + 0.3 + 0.1
 * s of CPU per 30 s sample, the editor writing 2 MB a sample, 55 °C).
 */
async function componentChecks(r, window) {
    const { COMPONENTS } = await import(`file://${root}/lib/engine/trackingview.js`);
    const names = [];
    for (let i = 0; i < r.component.model.get_n_items(); i++) names.push(r.component.model.get_string(i));
    ok(names.join() === 'Battery,Processor,Memory,Disk,Network,Graphics,Temperature', `components: offered ${names.join()}`);
    ok(r.component.selected === 0 && r.summary.visible && !r.componentGroup.visible, 'components: the battery view first');
    await chartHover(r, window);
    await chartZoom(r);
    const expect = {
        cpu: { tile: 'Average load', apps: 'chat,editor,@system,@other' },
        memory: { tile: 'Average in use', apps: 'chat,editor' },
        disk: { tile: 'Read', apps: 'editor,chat' },
        network: { tile: 'Received', apps: null },
        gpu: { tile: 'Graphics busy', apps: 'chat,editor' },
        thermal: { tile: 'Average', apps: null },
    };
    for (const [component, want] of Object.entries(expect)) {
        r.component.selected = COMPONENTS.indexOf(component);
        await sleep(100);
        const first = r.componentTiles[0];
        const shown = r.componentTiles.filter(t => t.visible);
        ok(r.componentGroup.visible && !r.summary.visible && !r.batteryOnly.visible && !r.healthGroup.visible, `components ${component}: its own view, the battery's hidden`);
        ok(first.title === want.tile && first.value.label !== '—' && shown.every(t => t.value.label), `components ${component}: '${first.title}' reads '${first.value.label}'`);
        ok(r.bars.box.visible && r.bars.chart.points.some(p => r.bars.chart.series.some(k => p[k] > 0)), `components ${component}: the chart has bars`);
        const ids = r.appRows.map(row => row.appId).join();
        if (want.apps) ok(ids === want.apps, `components ${component}: apps ${ids}, expected ${want.apps}`);
        else ok(r.appRows.length === 0 && r.list.get_first_child()?.title === 'No figures per app', `components ${component}: no per-app list, and it says why`);
    }
    r.component.selected = COMPONENTS.indexOf('thermal');
    ok(r.componentTiles[0].value.label === '55°C' && r.componentTiles[1].value.label === '60°C', `components thermal: average ${r.componentTiles[0].value.label}, highest ${r.componentTiles[1].value.label}`);
    r.component.selected = COMPONENTS.indexOf('disk');
    ok(r.appRows[0].value === '478.0 MB', `components disk: the editor wrote ${r.appRows[0].value} (2 MB in each of 239 intervals)`);

    // As rendered, each component's tiles in its own tint, in both variants.
    if (Gdk.Display.get_default()) {
        const { TINTS } = await import(`file://${root}/ui/prefs/style.js`);
        const manager = Adw.StyleManager.get_default();
        window.present();
        window.set_visible_page_name('tracking');
        const scrolled = findScrolled(window.get_visible_page());
        for (const [variant, scheme] of [['dark', Adw.ColorScheme.FORCE_DARK], ['light', Adw.ColorScheme.FORCE_LIGHT]]) {
            manager.color_scheme = scheme;
            for (const component of Object.keys(expect)) {
                r.component.selected = COMPONENTS.indexOf(component);
                await sleep(300);
                const tile = r.componentTiles[0];
                // The tiles are below the fold: scroll them into the rendered part.
                const adj = scrolled?.get_vadjustment();
                const [okTop, top] = scrolled ? tile.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0)) : [false, null];
                if (adj && okTop) adj.value = Math.min(Math.max(0, adj.value + top.y - 40), adj.upper - adj.page_size);
                // Read only after the window has painted the new view: a
                // snapshot taken before reuses what was drawn last.
                ok(await painted(window), `components ${component} (${variant}): the window did not paint within 3 s`);
                const shot = render(window);
                if (!shot) {
                    ok(false, `components ${component} (${variant}): the window rendered nothing`);
                    continue;
                }
                // Widget coordinates start at the content box: -7 is inside the tile's 14 px padding.
                const [okPoint, at] = tile.compute_point(window, new Graphene.Point().init(-7, tile.get_height() / 2));
                const bg = okPoint ? shot.at(at.x, at.y) : [0, 0, 0, 0];
                const want = TINTS[component][variant === 'dark' ? 0 : 1][0];
                ok(near(bg, want), `components ${component} (${variant}): tile is ${show(bg)}, not ${want} (at ${at?.x?.toFixed(0)},${at?.y?.toFixed(0)}; tile ${tile.get_width()}x${tile.get_height()} '${tile.title}' visible ${tile.get_mapped()}; window ${shot.width}x${shot.height})`);
                // Its tab, tinted the same way.
                const tab = r.component.buttons[COMPONENTS.indexOf(component)];
                const tAdj = scrolled?.get_vadjustment();
                const [okTabTop, tabTop] = scrolled ? tab.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0)) : [false, null];
                if (tAdj && okTabTop) tAdj.value = Math.min(Math.max(0, tAdj.value + tabTop.y - 40), tAdj.upper - tAdj.page_size);
                await painted(window);
                const tabShot = render(window);
                const [okTab, tabAt] = tab.compute_point(window, new Graphene.Point().init(-2, tab.get_height() / 2));
                const tabBg = okTab && tabShot ? tabShot.at(tabAt.x, tabAt.y) : [0, 0, 0, 0];
                ok(near(tabBg, want), `components ${component} (${variant}): its tab is ${show(tabBg)}, not ${want}`);
            }
        }
        manager.color_scheme = Adw.ColorScheme.DEFAULT;
        if (scrolled) scrolled.get_vadjustment().value = 0;
    }
    r.component.selected = 0;
    ok(r.summary.visible && !r.componentGroup.visible && r.batteryOnly.visible && r.appRows.map(row => row.appId).join() === 'chat,editor,@system,@other',
        'components: back to the battery view, as before');
}

/**
 * A terminal and agents that only record what they were given, on a PATH of
 * their own: nothing real is started. Arguments are kept NUL-separated, so a
 * prompt with newlines and quotes reads back exactly.
 */
function fakeAgentBin() {
    const base = GLib.dir_make_tmp('rp-agent-XXXXXX');
    const bin = `${base}/bin`;
    const agentDir = `${base}/agent`;
    GLib.mkdir_with_parents(bin, 0o755);
    const script = (name, body) => {
        GLib.file_set_contents(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
        GLib.chmod(`${bin}/${name}`, 0o755);
    };
    const record = name => `pwd > "$RP_FAKE_DIR/${name}-cwd"; printf '%s\\0' "$@" > "$RP_FAKE_DIR/${name}-args"`;
    script('xdg-terminal-exec', `${record('terminal')}\nwhile [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"`);
    script('claude', record('claude'));
    script('fake-agent', record('custom'));
    const read = name => {
        try {
            const [, bytes] = GLib.file_get_contents(`${base}/${name}`);
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    };
    return {
        base, bin, agentDir,
        which: program => (GLib.file_test(`${bin}/${program}`, GLib.FileTest.IS_EXECUTABLE) ? `${bin}/${program}` : null),
        spawn: (argv, cwd) => {
            // Programs are looked up on this PATH, not the test's: the real
            // terminal and agents are never reached.
            const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.SEARCH_PATH_FROM_ENVP });
            launcher.set_cwd(cwd);
            launcher.setenv('PATH', `${bin}:/usr/bin:/bin`, true);
            launcher.setenv('RP_FAKE_DIR', base, true);
            return launcher.spawnv(argv);
        },
        args: name => read(`${name}-args`)?.split('\0').slice(0, -1) ?? null,
        cwd: name => read(`${name}-cwd`)?.trim() ?? null,
        clear: () => {
            for (const name of ['terminal', 'claude', 'custom'])
                for (const what of ['args', 'cwd']) if (GLib.file_test(`${base}/${name}-${what}`, GLib.FileTest.EXISTS)) GLib.unlink(`${base}/${name}-${what}`);
        },
        remove: () => GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(base)}`),
    };
}

/** The window's next paint (true), or false after 3 s without one. */
function painted(window) {
    return new Promise(resolve => {
        const clock = window.get_frame_clock();
        if (!clock) {
            resolve(false);
            return;
        }
        let id = 0;
        const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            clock.disconnect(id);
            resolve(false);
            return GLib.SOURCE_REMOVE;
        });
        id = clock.connect('after-paint', () => {
            clock.disconnect(id);
            GLib.source_remove(timeout);
            resolve(true);
        });
        window.queue_draw();
    });
}

/**
 * Ask the driver for a pointer action (a CLICK, DRAG or SCROLL line) and wait
 * until it has finished it: the driver acknowledges each action by writing a
 * file in RP_ACK_DIR. Without the wait the checks ran while the driver was
 * still busy with an earlier action, a second or more behind.
 */
let actions = 0;
async function act(line) {
    const dir = GLib.getenv('RP_ACK_DIR');
    const id = `${++actions}`;
    print(`${line} ack=${id}`);
    if (!dir) return;
    const file = `${dir}/${id}`;
    ok(await until(() => GLib.file_test(file, GLib.FileTest.EXISTS), 20000), `driver: action ${id} (${line.split(' ').slice(1, 3).join(' ')}) not acknowledged within 20 s`);
    if (GLib.file_test(file, GLib.FileTest.EXISTS)) GLib.unlink(file);
}

/** Wait until `cond()` holds, up to `ms`. */
async function until(cond, ms = 5000) {
    for (let t = 0; t < ms && !cond(); t += 100) await sleep(100);
    return cond();
}

/** The agent section: rows, preview, consent, the launch, a hostile custom command. */
async function agentSection(window, settings, diagnostics, fake, confirmAnswers) {
    const a = diagnostics.agent;
    ok(a, 'agent: the Diagnostics page has the agent section when it has the settings');
    const names = [];
    for (let i = 0; i < a.agentRow.model.get_n_items(); i++) names.push(a.agentRow.model.get_string(i));
    ok(names.join() === 'Claude Code,Custom command', `agent: offered ${names.join()} (only the installed one, and a custom command)`);
    ok(a.open.label === 'Open Claude Code' && !a.commandRow.visible, `agent: '${a.open.label}', no command row for a preset`);
    ok(a.promptView.buffer.text.includes('report.md') && settings.get_string('agent-prompt') === '', 'agent: the built-in prompt is shown and not stored');

    const report = await diagnostics.makeReport();
    ok(report.startsWith('# Resource Pulse report') && report.includes('### Memory') && report.includes('`swapping`') && report.includes('| `chat` | `chat` |'),
        'agent: the report has the findings by area and the apps');
    if (driven) return;

    a.preview.emit('clicked');
    ok(await until(() => a.state.preview), 'agent: Preview report shows the report');
    ok(a.state.preview?.reportView.buffer.text === report.replace(/^# Resource Pulse report, [^\n]*/, a.state.preview.reportView.buffer.text.split('\n')[0]),
        'agent: the preview is the report that will be sent');
    a.state.preview?.force_close();

    // Cancelled first: nothing is written or started, and no consent is kept.
    confirmAnswers.push('cancel');
    a.open.emit('clicked');
    await sleep(500);
    ok(!fake.args('terminal') && settings.get_strv('agent-consent').length === 0 && !GLib.file_test(`${fake.agentDir}/report.md`, GLib.FileTest.EXISTS),
        'agent: cancelling starts nothing, writes nothing, keeps no consent');
    confirmAnswers.push('open');
    a.open.emit('clicked');
    await checkLaunch(settings, a, fake, 'the button');

    // A custom command is split, never run by a shell.
    fake.clear();
    a.agentRow.selected = 1;
    ok(a.commandRow.visible && settings.get_string('agent') === 'custom', 'agent: a custom command shows its row');
    settings.set_string('agent-command', 'fake-agent --flag "$(touch PWNED)" ; --prompt={prompt}');
    settings.set_strv('agent-consent', ['claude', 'custom']);
    a.open.emit('clicked');
    ok(await until(() => fake.args('custom')), 'agent: the custom command was started');
    const custom = fake.args('custom') ?? [];
    ok(custom[0] === '--flag' && custom[1] === '$(touch PWNED)' && custom[2] === ';' && custom[3] === `--prompt=${a.promptView.buffer.text}`,
        `agent: the custom command's arguments arrive literally (${JSON.stringify(custom.slice(0, 3))})`);
    ok(!GLib.file_test(`${fake.agentDir}/PWNED`, GLib.FileTest.EXISTS) && !GLib.file_test(`${GLib.get_current_dir()}/PWNED`, GLib.FileTest.EXISTS),
        'agent: nothing in the command was run by a shell');
    settings.set_string('agent-command', 'not-installed-agent {prompt}');
    a.open.emit('clicked');
    await sleep(300);
    ok(a.status.visible && a.status.label.includes('"not-installed-agent" was not found'), `agent: a missing program is reported ('${a.status.label}')`);
    a.agentRow.selected = 0;
    settings.reset('agent-command');
}

/** After the open button: the terminal ran the agent in the agent's folder with the prompt, and report.md is there, private. */
async function checkLaunch(settings, a, fake, how) {
    ok(await until(() => fake.args('claude')), `agent (${how}): the agent was started through the terminal`);
    const prompt = a.promptView.buffer.text;
    const terminal = fake.args('terminal') ?? [];
    ok(terminal.join('\n') === [`--dir=${fake.agentDir}`, '--', 'claude', prompt].join('\n'),
        `agent (${how}): the terminal got ${JSON.stringify(terminal.slice(0, 3))}`);
    ok(JSON.stringify(fake.args('claude')) === JSON.stringify([prompt]) && fake.cwd('claude') === fake.agentDir,
        `agent (${how}): the agent got the prompt as one argument, in ${fake.cwd('claude')}`);
    ok(settings.get_strv('agent-consent').includes('claude'), `agent (${how}): the consent is kept for this agent`);
    const info = Gio.File.new_for_path(`${fake.agentDir}/report.md`).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    const dirInfo = Gio.File.new_for_path(fake.agentDir).query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    ok((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600 && (dirInfo.get_attribute_uint32('unix::mode') & 0o777) === 0o700,
        `agent (${how}): report.md is private (${(info.get_attribute_uint32('unix::mode') & 0o777).toString(8)}, folder ${(dirInfo.get_attribute_uint32('unix::mode') & 0o777).toString(8)})`);
    ok(a.status.label.startsWith('Started in a terminal'), `agent (${how}): status '${a.status.label}'`);
}

/**
 * Driven by the shell: on the Settings page, an unpinned metric's chip and
 * the °F segment clicked with the real pointer.
 */
async function settingsClicks(window, shown, settings) {
    const pointAt = widget => {
        const [, p] = widget.compute_point(window, new Graphene.Point().init(widget.get_width() / 2, widget.get_height() / 2));
        const [sx, sy] = window.get_surface_transform();
        return `${Math.round(p.x + sx)} ${Math.round(p.y + sy)}`;
    };
    const scrollTo = async widget => {
        const scrolled = findScrolled(window.get_visible_page());
        const adj = scrolled.get_vadjustment();
        const [, top] = widget.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0));
        adj.value = Math.min(Math.max(0, adj.value + top.y - 80), adj.upper - adj.page_size);
        await sleep(500);
    };
    window.present();
    await sleep(400);
    const chip = shown.pinRows.gpu;
    const before = settings.get_strv('pinned-metrics').join();
    await scrollTo(chip);
    await act(`PREFS-CHECK CLICK chip-gpu ${pointAt(chip)}`);
    ok(await until(() => settings.get_strv('pinned-metrics').includes('gpu')) && chip.badge.visible,
        `settings (pointer): clicking the GPU chip pinned it (${before} -> ${settings.get_strv('pinned-metrics').join()})`);
    ok(shown.rows.preview.text().endsWith('GPU 18%'), `settings (pointer): the preview shows it last ('${shown.rows.preview.text()}')`);
    // Drag and drop in the preview: Network to the front, then the Disk chip onto the end.
    settings.set_strv('pinned-metrics', ['cpu', 'memory', 'battery', 'network']);
    await sleep(300);
    const preview = shown.rows.preview;
    await scrollTo(preview);
    const item = key => preview.items.find(i => i.key === key).widget;
    const pointIn = (widget, fx, fy) => {
        const [, p] = widget.compute_point(window, new Graphene.Point().init(widget.get_width() * fx, widget.get_height() * fy));
        const [sx, sy] = window.get_surface_transform();
        return `${Math.round(p.x + sx)} ${Math.round(p.y + sy)}`;
    };
    await act(`PREFS-CHECK DRAG network-front ${pointIn(item('network'), 0.5, 0.5)} ${pointIn(item('cpu'), 0.15, 0.5)}`);
    ok(await until(() => settings.get_strv('pinned-metrics')[0] === 'network'),
        `drag (pointer): Network dragged to the front gives ${settings.get_strv('pinned-metrics').join()}`);
    ok(preview.text().startsWith('Top bar preview: Network'), `drag (pointer): the preview starts with Network ('${preview.text()}')`);
    await sleep(300);
    const disk = shown.pinRows.disk;
    const last = preview.items.at(-1).widget;
    await act(`PREFS-CHECK DRAG chip-disk ${pointIn(disk, 0.5, 0.5)} ${pointIn(last, 0.9, 0.5)}`);
    ok(await until(() => settings.get_strv('pinned-metrics').at(-1) === 'disk'),
        `drag (pointer): the Disk chip dropped on the end pins it last (${settings.get_strv('pinned-metrics').join()})`);
    // A slider: the wheel scrolls the page, a click on its track does nothing, dragging its knob moves it.
    const sliderRowW = shown.rows['threshold-cpu'];
    const scale = sliderRowW.scale;
    const trough = findAll(scale, w => w.get_css_name() === 'trough')[0];
    const knobOf = () => findAll(scale, w => w.get_css_name() === 'slider')[0];
    await scrollTo(sliderRowW);
    const valueBefore = settings.get_int('threshold-cpu');
    const pageAdj = findScrolled(window.get_visible_page()).get_vadjustment();
    const pageBefore = pageAdj.value;
    await act(`PREFS-CHECK SCROLL slider-wheel ${pointIn(trough, 0.3, 0.5)} down`);
    ok(pageAdj.value !== pageBefore && settings.get_int('threshold-cpu') === valueBefore,
        `slider (pointer): the wheel over it scrolled the page (${pageBefore} -> ${pageAdj.value}) and left ${valueBefore} (now ${settings.get_int('threshold-cpu')})`);
    await scrollTo(sliderRowW);
    await act(`PREFS-CHECK CLICK slider-track ${pointIn(trough, 0.05, 0.5)}`);
    ok(settings.get_int('threshold-cpu') === valueBefore, `slider (pointer): a click on its track left ${valueBefore} (now ${settings.get_int('threshold-cpu')})`);
    await scrollTo(sliderRowW);
    await act(`PREFS-CHECK DRAG slider-knob ${pointIn(knobOf(), 0.5, 0.5)} ${pointIn(trough, 0.02, 0.5)}`);
    ok(settings.get_int('threshold-cpu') < valueBefore, `slider (pointer): dragging its knob moved it (${valueBefore} -> ${settings.get_int('threshold-cpu')})`);
    settings.reset('threshold-cpu');
    // The shortcut row: a real click, then real keys through the compositor.
    const shortcut = shown.rows['panel-shortcut'];
    await scrollTo(shortcut);
    await act(`PREFS-CHECK CLICK shortcut-row ${pointIn(shortcut, 0.3, 0.5)}`);
    ok(await until(() => shortcut.listening), 'shortcut (pointer): clicking the row listens');
    await act('PREFS-CHECK KEY shortcut-keys Control_L,Alt_L,k');
    ok(await until(() => settings.get_strv('panel-shortcut').join() === '<Control><Alt>k'), `shortcut (keys): stored '${settings.get_strv('panel-shortcut').join()}'`);
    settings.reset('panel-shortcut');
    await sleep(200);
    const fahrenheit = shown.rows['unit-temp'].buttons[1];
    await scrollTo(fahrenheit);
    await act(`PREFS-CHECK CLICK segment-f ${pointAt(fahrenheit)}`);
    ok(await until(() => settings.get_string('unit-temp') === 'F'), `settings (pointer): clicking °F stored '${settings.get_string('unit-temp')}'`);
    ok(shown.rows['threshold-temp'].valueLabel.label.endsWith('°F'), `settings (pointer): the temperature limit reads ${shown.rows['threshold-temp'].valueLabel.label}`);
    settings.reset('pinned-metrics');
    settings.reset('unit-temp');
}

/**
 * Driven by the shell: a component tab of the Tracking page clicked with
 * the real pointer.
 */
async function componentClicks(window, r) {
    window.present();
    window.set_visible_page_name('tracking');
    const adj = findScrolled(window.get_visible_page())?.get_vadjustment();
    if (adj) adj.value = 0;
    r.component.selected = 0;
    // The last 24 hours: hourly bars, the fixture's two hours in the last ones.
    r.period.selected = 0;
    await sleep(600);
    // Battery health's chart under the real pointer.
    {
        const scrolledHealth = findScrolled(window.get_visible_page()).get_vadjustment();
        const healthArea = r.health.area;
        const [, top] = healthArea.compute_point(findScrolled(window.get_visible_page()).get_child(), new Graphene.Point().init(0, 0));
        scrolledHealth.value = Math.min(Math.max(0, scrolledHealth.value + top.y - 60), scrolledHealth.upper - scrolledHealth.page_size);
        await sleep(500);
        const count = r.health.chart.points.length;
        const slot = (healthArea.get_width() - 52) / count;
        const [, q] = healthArea.compute_point(window, new Graphene.Point().init(52 + slot * (count - 0.5), healthArea.get_height() / 2));
        const [hx, hy] = window.get_surface_transform();
        await act(`PREFS-CHECK HOVER health-bar ${Math.round(q.x + hx)} ${Math.round(q.y + hy)}`);
        ok(r.health.hover.index === count - 1 && /health 86\.0 %/.test(r.health.hover.text()), `battery health (pointer): the last bar under the pointer (${r.health.hover.index}): '${r.health.hover.text()}'`);
        scrolledHealth.value = 0;
        await sleep(300);
    }
    // The battery chart under the real pointer: the bar under it is chosen.
    const area = r.chart.area;
    const scrolled = findScrolled(window.get_visible_page());
    const sAdj = scrolled.get_vadjustment();
    const [, areaTop] = area.compute_point(scrolled.get_child(), new Graphene.Point().init(0, 0));
    sAdj.value = Math.min(Math.max(0, sAdj.value + areaTop.y - 60), sAdj.upper - sAdj.page_size);
    await sleep(400);
    const n = r.chart.points.length;
    const want = r.chart.points.findIndex(p => p.battery > 0);
    const slotW = (area.get_width() - 44) / n;
    const [, hp] = area.compute_point(window, new Graphene.Point().init(44 + slotW * (want + 0.5), area.get_height() / 2));
    const [hsx, hsy] = window.get_surface_transform();
    await act(`PREFS-CHECK HOVER chart-bar ${Math.round(hp.x + hsx)} ${Math.round(hp.y + hsy)}`);
    ok(r.chart.hover.index === want && r.chart.hover.text().includes('battery'),
        `hover (pointer): the bar under the pointer is chosen (${r.chart.hover.index}, wanted ${want}): '${r.chart.hover.text()}'`);
    // Dragged across the last two hours: those, in five-minute bars.
    const at = (x, y) => {
        const [, q] = area.compute_point(window, new Graphene.Point().init(x, y));
        return `${Math.round(q.x + hsx)} ${Math.round(q.y + hsy)}`;
    };
    const y = area.get_height() / 2;
    await act(`PREFS-CHECK DRAG chart-zoom ${at(44 + slotW * (n - 2) + 1, y)} ${at(area.get_width() - 2, y)}`);
    ok(await until(() => r.chart.view) && r.chart.points.every(p => p.step === 300e3) && r.chart.points.length >= 12,
        `zoom (pointer): dragging across the last two hours zoomed into ${r.chart.points.length} bars of ${r.chart.points[0]?.step / 60e3} min`);
    const span = () => (r.chart.view ? r.chart.view.to - r.chart.view.from : r.chart.bounds[1] - r.chart.bounds[0]);
    // The plain wheel scrolls the page; with Ctrl it zooms about the pointer.
    const zoomed = span();
    await act(`PREFS-CHECK SCROLL chart-wheel ${at(area.get_width() * 0.6, y)} down ctrl`);
    ok(await until(() => span() > zoomed * 1.5), `zoom (pointer): Ctrl+wheel down zoomed out (${zoomed / 60e3} -> ${span() / 60e3} min)`);
    const wider = span();
    const page = sAdj.value;
    await act(`PREFS-CHECK SCROLL chart-wheel ${at(area.get_width() * 0.6, y)} down`);
    ok(span() === wider && sAdj.value !== page, `zoom (pointer): the plain wheel scrolled the page (${page} -> ${sAdj.value}) and left the zoom`);
    r.chart.reset();
    // Back to the top, held until the wheel's scrolling has settled: set
    // while it still moves, the value does not stick.
    for (let t = 0, still = 0; t < 3000 && still < 3; t += 100) {
        still = sAdj.value === 0 ? still + 1 : 0;
        sAdj.value = 0;
        await sleep(100);
    }
    const tab = r.component.buttons[2];
    const [, p] = tab.compute_point(window, new Graphene.Point().init(tab.get_width() / 2, tab.get_height() / 2));
    const [sx, sy] = window.get_surface_transform();
    await act(`PREFS-CHECK CLICK tab-memory ${Math.round(p.x + sx)} ${Math.round(p.y + sy)}`);
    ok(await until(() => r.component.selected === 2), `components (pointer): clicking the Memory tab shows it (selected ${r.component.selected})`);
    ok(r.componentGroup.visible && r.componentGroup.title === 'Memory' && tab.has_css_class('rp-tint-memory'), 'components (pointer): the Memory view is on the page, its tab tinted');
    r.component.selected = 0;
    await sleep(300);
    // The period's segments and the battery filter, clicked.
    const clickOn = async (widget, name) => {
        const [, q] = widget.compute_point(window, new Graphene.Point().init(widget.get_width() / 2, widget.get_height() / 2));
        await act(`PREFS-CHECK CLICK ${name} ${Math.round(q.x + sx)} ${Math.round(q.y + sy)}`);
    };
    await clickOn(r.period.buttons[2], 'period-week');
    ok(await until(() => r.period.selected === 2) && r.period.buttons[2].label === '7 days', `period (pointer): clicking '7 days' chose it (selected ${r.period.selected})`);
    await clickOn(r.batteryOnly, 'battery-filter');
    ok(await until(() => !r.batteryOnly.active) && r.time.title === 'Time recorded', `period (pointer): clicking On battery let the charger time in ('${r.time.title}')`);
    await clickOn(r.batteryOnly, 'battery-filter');
    ok(await until(() => r.batteryOnly.active) && r.time.title === 'Time on battery', 'period (pointer): clicking it again leaves the charger time out');
    await clickOn(r.period.buttons[0], 'period-day');
    ok(await until(() => r.period.selected === 0), 'period (pointer): back to 24 h');
}

/**
 * Driven by the shell: on Diagnostics, a finding opened to its detail and
 * Copy report, both clicked with the real pointer.
 */
async function findingClicks(window, diagnostics) {
    window.present();
    window.set_visible_page_name('diagnostics');
    const adj = findScrolled(window.get_visible_page())?.get_vadjustment();
    if (adj) adj.value = 0;
    await sleep(600);
    const [sx, sy] = window.get_surface_transform();
    const at = (widget, fx, fy) => {
        const [, q] = widget.compute_point(window, new Graphene.Point().init(widget.get_width() * fx, widget.get_height() * fy));
        return `${Math.round(q.x + sx)} ${Math.round(q.y + sy)}`;
    };
    // The battery tile pressed: only battery findings; pressed again: all.
    const tile = diagnostics.tiles.battery;
    await act(`PREFS-CHECK CLICK tile-battery ${at(tile, 0.5, 0.5)}`);
    ok(await until(() => tile.active) && diagnostics.rows.filter(r => r.visible).every(r => r.area === 'battery'),
        `findings (pointer): the battery tile filtered the list (${diagnostics.rows.filter(r => r.visible).map(r => r.area).join()})`);
    await act(`PREFS-CHECK CLICK tile-battery ${at(tile, 0.5, 0.5)}`);
    ok(await until(() => !tile.active) && diagnostics.rows.every(r => r.visible), 'findings (pointer): pressed again, every finding shows');
    const first = diagnostics.rows[0];
    ok(first instanceof Adw.ExpanderRow && !first.expanded, 'findings (pointer): the first finding starts closed');
    // Its header: the title's middle, left of any button.
    await act(`PREFS-CHECK CLICK finding ${at(first, 0.4, 0.5 * 56 / Math.max(56, first.get_height()))}`);
    ok(await until(() => first.expanded) && first.detailLabel.get_mapped(), `findings (pointer): clicking it opened its detail (expanded ${first.expanded})`);
    // An app's finding: Pause and Resume with the real pointer.
    const { processIdentity } = await import(`file://${root}/lib/collectors/process.js`);
    const chat = diagnostics.rows.find(r => r.findingId === 'background:chat');
    const chatPid = diagnostics.state.apps.get('chat')?.[0]?.pid;
    if (chat?.pauseButton && chatPid) {
        await act(`PREFS-CHECK CLICK finding-pause ${at(chat.pauseButton, 0.5, 0.5)}`);
        ok(await until(() => processIdentity(chatPid)?.state === 'T'), `findings (pointer): Pause stopped the app (${processIdentity(chatPid)?.state})`);
        await act(`PREFS-CHECK CLICK finding-resume ${at(chat.pauseButton, 0.5, 0.5)}`);
        ok(await until(() => processIdentity(chatPid)?.state !== 'T'), 'findings (pointer): Resume continued the app');
    } else {
        ok(false, `findings (pointer): no Pause on chat's finding (${chat ? 'row' : 'no row'}, pid ${chatPid})`);
    }
    await act(`PREFS-CHECK CLICK copy-report ${at(diagnostics.copy, 0.5, 0.5)}`);
    ok(await until(() => diagnostics.copy.icon_name === 'object-select-symbolic'), `findings (pointer): Copy report shows ${diagnostics.copy.icon_name}`);
    first.expanded = false;
}

/**
 * Driven by the shell: the agent's buttons and the confirmation, clicked with
 * the real pointer. A CLICK line gives the point in the window's surface; the
 * driver adds where the surface is and clicks there.
 */
async function agentClicks(window, settings, diagnostics, fake) {
    const a = diagnostics.agent;
    const clickAt = async (widget, name) => {
        const [, p] = widget.compute_point(window, new Graphene.Point().init(widget.get_width() / 2, widget.get_height() / 2));
        const [sx, sy] = window.get_surface_transform();
        await act(`PREFS-CHECK CLICK ${name} ${Math.round(p.x + sx)} ${Math.round(p.y + sy)}`);
    };
    window.present();
    window.set_visible_page_name('diagnostics');
    const adj = findScrolled(window.get_visible_page())?.get_vadjustment();
    await sleep(400);
    adj.value = adj.upper - adj.page_size;
    await sleep(600);
    fake.clear();
    settings.set_strv('agent-consent', []);

    await clickAt(a.preview, 'preview');
    ok(await until(() => a.state.preview), 'agent (pointer): Preview report opened the report');
    a.state.preview?.force_close();
    await sleep(600);

    await clickAt(a.open, 'open');
    let dialog = null;
    ok(await until(() => (dialog = findAll(window, w => w instanceof Adw.AlertDialog)[0])), 'agent (pointer): the first hand-off asks first');
    if (!dialog) return;
    await sleep(600);
    const look = render(window);
    const sheet = findAll(dialog, w => w.get_css_name() === 'sheet')[0];
    if (look && sheet) {
        const { palette } = await import(`file://${root}/ui/prefs/style.js`);
        const p = palette(Adw.StyleManager.get_default().dark);
        const [, at] = sheet.compute_point(window, new Graphene.Point().init(sheet.get_width() / 2, 8));
        const bg = look.at(at.x, at.y);
        ok(near(bg, p.card), `agent (pointer): the confirmation is ${show(bg)}, not ${p.card}`);
    }
    const openButton = findAll(dialog, w => w instanceof Gtk.Button && w.label === 'Open')[0];
    await clickAt(openButton, 'confirm-open');
    await checkLaunch(settings, a, fake, 'pointer');
}

/**
 * The pseudo-language run (gjs -m prefs-check.js <root> coverage, LANGUAGE=xx
 * from ./scripts/dev.sh test-i18n): the window as the panel opens it, all
 * three pages, with the fixture history and a stub machine state. Every
 * shown label, tooltip and dropdown choice must read ⟦…⟧.
 */
async function coverage() {
    const { untranslated } = await import('./i18n-coverage.js');
    const domain = 'resource-pulse';
    // As ExtensionPreferences does for the real window.
    Gettext.setlocale(Gettext.LocaleCategory.ALL, '');
    Gettext.bindtextdomain(domain, `${root}/locale`);
    const { setTranslations } = await import(`file://${root}/lib/common/i18n.js`);
    setTranslations(str => Gettext.dgettext(domain, str), (str, plural, n) => Gettext.dngettext(domain, str, plural, n));
    ok(Gettext.dgettext(domain, 'Settings') === '⟦Settings⟧', `coverage: the pseudo-language is not loaded ('${Gettext.dgettext(domain, 'Settings')}')`);
    Adw.init();

    const { fillWindow } = await import(`file://${root}/ui/prefs/window.js`);
    const { dir, path } = await fixtureHistory();
    const settings = newSettings();
    // A panel request: the window gets all three pages.
    settings.set_string('prefs-page', 'tracking');
    const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
    const filled = fillWindow(window, {
        settings, path: root, historyPath: path,
        diagnostics: {
            readState: () => Promise.resolve({
                battery: { healthPct: 72, cycles: 610, fullWh: 40, chargeLimit: 'off' },
                onBattery: true, backlight: 0.95, powerProfile: 'performance', energyReadable: false,
            }),
            switchProfile: () => Promise.resolve(),
            launch: () => {},
        },
    });
    window.present();
    // The fixture's app ids are its data; the profile name comes from the
    // system; shell commands are the same in every language.
    const { RAPL_FIX_COMMANDS } = await import(`file://${root}/lib/common/raplfix.js`);
    // Agents and terminals found on this machine go by their product names.
    const { AGENTS, TERMINALS } = await import(`file://${root}/lib/common/agentlaunch.js`);
    const data = ['chat', 'editor', 'performance', ...RAPL_FIX_COMMANDS.split('\n'), ...AGENTS.map(a => a.name), 'Ptyxis', 'kitty'];
    ok(TERMINALS.some(t => t.name === 'Ptyxis'), 'coverage: the terminal names left out are the ones offered');
    const seen = new Set();
    for (const name of ['settings', 'tracking', 'diagnostics']) {
        window.set_visible_page_name(name);
        await sleep(800);
        const texts = [];
        for (const w of findAll(window.get_visible_page(), () => true)) {
            if (!w.get_mapped()) continue;
            if (w instanceof Gtk.Label) texts.push(w.label);
            if (w.tooltip_text) texts.push(w.tooltip_text);
            if (w instanceof Adw.ComboRow) {
                for (let i = 0; i < w.model.get_n_items(); i++) texts.push(w.model.get_string(i));
            }
        }
        ok(texts.length > 10, `coverage: only ${texts.length} texts on the ${name} page`);
        for (const text of texts) {
            const rest = untranslated(text, data);
            if (rest && !seen.has(text)) {
                seen.add(text);
                ok(false, `coverage: untranslated on the ${name} page: '${text}'`);
            }
        }
        print(`PREFS-CHECK INFO: coverage of the ${name} page: ${texts.length} texts`);
    }
    window.destroy();
    filled.dispose();
    GLib.unlink(path);
    GLib.rmdir(dir);
    print(`PREFS-CHECK ${failures === 0 ? 'DONE' : 'FAILED'}: ${checks - failures} of ${checks} checks passed`);
}

(ARGV[1] === 'coverage' ? coverage() : main()).catch(e => {
    failures++;
    print(`PREFS-CHECK FAIL: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
System.exit(failures === 0 ? 0 : 1);
