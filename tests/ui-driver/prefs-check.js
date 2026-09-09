// Exercises the preferences rows (ui/prefsrows.js) with real GTK widgets and
// a memory-backed copy of the schema. Started by the UI driver as a client of
// the sandboxed shell: gjs -m prefs-check.js <extension directory>
// Prints one PREFS-CHECK line per failure and a final verdict, then shows a
// freshly built window for a few seconds so the driver can screenshot it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
    const prefsRows = await import(`file://${root}/ui/prefsrows.js`);
    const { buildPreferences } = prefsRows;
    const { allSettingRows, METRICS } = await import(`file://${root}/lib/settingsmodel.js`);
    const { PowerSampler } = await import(`file://${root}/lib/power.js`);
    Adw.init();

    const { styleWindow: style } = await import(`file://${root}/ui/prefsstyle.js`);
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
    const { windowCss, styleWindow } = await import(`file://${root}/ui/prefsstyle.js`);
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

    print(`PREFS-CHECK ${failures === 0 ? 'DONE' : 'FAILED'}: ${checks - failures} of ${checks} checks passed`);
    // Leave windows up for the driver's screenshots, one page at a time; the
    // driver shoots on each SHOW line.
    const linger = Number(ARGV[1] ?? 0);
    if (linger > 0) {
        shown.window.set_default_size(640, 660);
        shown.window.present();
        print('PREFS-CHECK SHOW settings');
        await sleep(linger);
        shown.window.destroy();
        battery.window.set_default_size(720, 680);
        battery.window.present();
        // Each tab from top to bottom, in both variants.
        const manager = Adw.StyleManager.get_default();
        for (const [variant, scheme] of [['light', Adw.ColorScheme.FORCE_LIGHT], ['dark', Adw.ColorScheme.FORCE_DARK]]) {
            manager.color_scheme = scheme;
            for (const name of ['tracking', 'diagnostics']) {
                battery.window.set_visible_page_name(name);
                const adj = findScrolled(battery.window.get_visible_page())?.get_vadjustment();
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
    }
    shown.dispose();
    battery.dispose();
    battery.window.destroy();
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
    const { HistorySource, buildTrackingPage } = await import(`file://${root}/ui/prefsbattery.js`);
    const { buildDiagnosticsPage } = await import(`file://${root}/ui/prefsdiagnostics.js`);
    const { BatteryLedger, saveLedger } = await import(`file://${root}/lib/batteryledger.js`);

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

    // The file changes (the extension saved): both pages follow.
    ok(r.summary.visible, 'tracking: the summary is shown when there are figures');
    await saveLedger(path, new BatteryLedger());
    for (let i = 0; i < 30 && r.appRows.length > 0; i++) await sleep(100);
    ok(r.appRows.length === 0, `tracking: did not follow the file (${r.appRows.length} rows left)`);
    ok(!r.summary.visible, 'tracking: no summary of zeros without figures');
    await saveLedger(path, ledger);
    for (let i = 0; i < 30 && r.appRows.length === 0; i++) await sleep(100);
    ok(r.appRows.length === 4, `tracking: did not pick up the restored file (${r.appRows.length} rows)`);

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
