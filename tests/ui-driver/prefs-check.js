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

    const model = allSettingRows().filter(row => row.kind !== 'pins');
    ok(model.every(row => rows[row.key]), `rows missing for ${model.filter(row => !rows[row.key]).map(row => row.key)}`);
    for (const row of model) {
        const widget = rows[row.key];
        if (!widget) continue;
        ok(widget.title === row.title && widget.subtitle === row.detail, `${row.key}: title '${widget.title}' / subtitle differ from the model`);
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
    // Pinned metrics: switches plus the position each one has in the top bar.
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
    const shown = build(newSettings(), new PowerSampler(blockedRoot));
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

    // What the window really shows, read back from its rendering: the test
    // shell carries a third-party theme as the user stylesheet (dev.sh), which
    // GTK ranks above application stylesheets, so a look that only holds
    // without it fails here.
    if (Gdk.Display.get_default()) await renderedLook(shown);
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
                for (let part = 0, done = false; !done && part < 4; part++) {
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
        shown.window.destroy();
    }
    shown.dispose();
    battery.dispose();
    battery.window.destroy();
}

// Where the window was opened from: the Extensions app (no prefs-page)
// gets the settings only; the panel (prefs-page set) also gets Tracking and
// Diagnostics, also when it asks while a settings-only window is open.
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
    const tabs = window => ['settings', 'tracking', 'diagnostics'].filter(name => {
        window.set_visible_page_name(name);
        return window.visible_page_name === name;
    }).join();

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
    return { width, height, at: (x, y) => Array.from(data.slice(Math.round(y) * stride + Math.round(x) * 4, Math.round(y) * stride + Math.round(x) * 4 + 4)) };
}

const hex = colour => [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
const near = (rgb, colour, tolerance = 14) => hex(colour).every((v, i) => Math.abs(v - rgb[i]) <= tolerance);
const show = rgb => `rgb(${rgb.slice(0, 3).join(', ')})`;

async function renderedLook(shown) {
    const { palette } = await import(`file://${root}/ui/prefs/style.js`);
    const manager = Adw.StyleManager.get_default();
    const window = shown.window;
    window.set_default_size(640, 660);
    window.present();
    const row = shown.pinRows.cpu;
    const toggle = findAll(row, w => w instanceof Gtk.Switch)[0];
    const title = findAll(row, w => w instanceof Gtk.Label && w.label === row.title)[0];
    ok(row.active && toggle && title, 'look: the CPU pin row, its switch and title were not found');
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

        // An open dropdown (the Temperature row; Tracking › Period is the
        // same widget): its options on the popover's colour, text readable.
        const combo = shown.rows['unit-temp'];
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
// battery with a chat app working in the background and an editor in use.
async function batteryPages(styleWindow) {
    const { HistorySource, buildTrackingPage } = await import(`file://${root}/ui/prefs/tracking.js`);
    const { buildDiagnosticsPage } = await import(`file://${root}/ui/prefs/diagnostics.js`);
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
                { unit: 'app-gnome-chat-1.scope', id: 'chat', kind: 'app', label: 'chat', usec: c.chat },
                { unit: 'app-gnome-editor-2.scope', id: 'editor', kind: 'app', label: 'editor', usec: c.editor },
            ] },
            // Varies like a real machine, so an idle level below the mean is learnt.
            packageW: 5 + (i % 7),
            battery: { present: true, onBattery: true, energyWh: 40 - i * 9.5 * 30 / 3600 },
            focusUsec: { editor: 30e6 },
            uncoreW: 3,
            gpu: new Map([['app-gnome-chat-1.scope', i * 2e9], ['app-gnome-editor-2.scope', i * 0.5e9]]),
        });
    }
    await saveLedger(path, ledger);

    const settings = newSettings();
    const history = new HistorySource(settings, path);
    const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
    const style = styleWindow(window);
    ok(window.has_css_class('rp-window') && style.css().includes('#3584e4'), 'style: the window carries the extension\'s look and accent');
    const tracking = buildTrackingPage(settings, history, { fullWh: () => 40 });
    window.add(tracking.page);
    const profileCalls = [];
    const launched = [];
    let profile = 'performance';
    const diagnostics = buildDiagnosticsPage(history, {
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
    ok(r.appRows[0].share > r.appRows[1].share && r.appRows[0].subtitle.includes('100 % in the background') &&
        r.appRows[1].subtitle.includes('0 % in the background'), `tracking: shares and background split ('${r.appRows[0].subtitle}' / '${r.appRows[1].subtitle}')`);
    ok(r.drain.value.label === '9.5 W' && r.runtime.value.label === '4h 12m' && r.used.detail.label.includes('% of a full charge'),
        `tracking: summary '${r.used.value.label}' (${r.used.detail.label}), '${r.drain.value.label}', '${r.runtime.value.label}'`);
    // Two hours on battery, one bar per hour: the chart has them, battery above processor.
    // (The fixture's power is constant, so once the idle level is learnt the processor part is 0.)
    const filled = r.chart.points.filter(p => p.battery > 0);
    ok(r.chart.box.visible && filled.length >= 2 && filled.length <= 3 && filled.some(p => p.processor > 0) && filled.every(p => p.processor <= p.battery),
        `tracking: chart bars ${filled.map(p => `${p.battery.toFixed(2)}/${p.processor.toFixed(2)}`).join(' ')}`);
    ok(Math.abs(filled.reduce((t, p) => t + p.battery, 0) - parseFloat(r.used.value.label)) < 0.1, 'tracking: the bars add up to the battery used');
    ok(r.rest.visible && r.idle.value.label !== 'not measured', 'tracking: the unmeasured rest and the idle share are shown');
    ok(r.graphics.visible && r.appRows[1].subtitle.includes('of graphics time'), `tracking: graphics share and time shown ('${r.appRows[1].subtitle}')`);

    r.batteryOnly.active = false;
    ok(r.time.title === 'Time recorded' && !r.drain.visible && !r.chart.box.visible, 'tracking: the AC-and-battery view drops the battery figures');
    r.batteryOnly.active = true;
    r.period.selected = 1; // today: may or may not include the fixture, but must not fail
    r.period.selected = 3;
    ok(r.appRows.length === 4, 'tracking: the 14-day view has the same apps');

    r.tracking.active = true;
    ok(settings.get_boolean('battery-tracking'), 'tracking: the switch writes the setting');
    ok(settings.get_boolean('action-flush-history'), 'tracking: switching on asks the extension for current figures');
    settings.set_boolean('action-flush-history', false);
    ok(r.status.subtitle.startsWith('Recording'), `tracking: status while on is '${r.status.subtitle}'`);

    // Diagnostics on the stubbed state.
    for (let i = 0; i < 20 && diagnostics.state.running; i++) await sleep(100);
    const found = () => Object.values(diagnostics.lists).flatMap(list => {
        const out = [];
        for (let row = list.get_first_child(); row; row = row.get_next_sibling()) if (row.findingId) out.push(row);
        return out;
    });
    const ids = found().map(row => row.findingId);
    ok(['wear', 'background:chat', 'power-profile', 'brightness', 'charge-limit'].every(id => ids.includes(id)) && !ids.includes('background:editor'),
        `diagnostics: findings ${ids.join(', ')}`);
    const lifespan = [];
    for (let row = diagnostics.lists.lifespan.get_first_child(); row; row = row.get_next_sibling()) lifespan.push(row.findingId);
    ok(lifespan.join() === 'wear,charge-limit', `diagnostics: battery-life findings ${lifespan.join()}, the warning first`);
    const chat = found().find(row => row.findingId === 'background:chat');
    ok(/Saves about [\d.]+ W, about \d+ min more per full charge/.test(chat.subtitle), `diagnostics: estimate shown ('${chat.subtitle.split('\n').pop()}')`);
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
    ok(/\nLonger runtime per charge\n- \[\w+\] chat works in the background: /.test(copied ?? '') && /\nLonger battery life\n/.test(copied ?? ''),
        'copy report: findings grouped by goal');
    ok(diagnostics.copy.label === 'Copied', `copy report: the button says '${diagnostics.copy.label}'`);

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
    await saveLedger(path, ledger);
    for (let i = 0; i < 100 && r.appRows.length === 0; i++) await sleep(100);
    ok(r.appRows.length === 4, `tracking: did not pick up the restored file within 10 s (${r.appRows.length} rows)`);

    return {
        window,
        dispose: () => {
            tracking.dispose();
            diagnostics.dispose();
            history.dispose();
            GLib.unlink(path);
            GLib.rmdir(dir);
        },
    };
}

main().catch(e => {
    failures++;
    print(`PREFS-CHECK FAIL: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
System.exit(failures === 0 ? 0 : 1);
