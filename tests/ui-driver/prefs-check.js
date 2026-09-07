// Exercises the preferences rows (ui/prefsrows.js) with real GTK widgets and
// a memory-backed copy of the schema. Started by the UI driver as a client of
// the sandboxed shell: gjs -m prefs-check.js <extension directory>
// Prints one PREFS-CHECK line per failure and a final verdict, then shows a
// freshly built window for a few seconds so the driver can screenshot it.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import 'gi://Gtk?version=4.0';
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
    const { buildPreferences } = await import(`file://${root}/ui/prefsrows.js`);
    const { allSettingRows, METRICS } = await import(`file://${root}/lib/settingsmodel.js`);
    const { PowerSampler } = await import(`file://${root}/lib/power.js`);
    Adw.init();

    const build = (settings, power) => {
        const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
        const page = new Adw.PreferencesPage({ title: 'Settings' });
        window.add(page);
        return { window, page, ...buildPreferences(page, settings, power) };
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

    const battery = await batteryPages();

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
        battery.window.set_default_size(720, 900);
        battery.window.present();
        for (const name of ['tracking', 'diagnostics']) {
            battery.window.set_visible_page_name(name);
            print(`PREFS-CHECK SHOW ${name}`);
            await sleep(linger);
        }
    }
    shown.dispose();
    battery.dispose();
    battery.window.destroy();
}

// The Tracking and Diagnostics pages on a fixture history: two hours on
// battery with a chat app working in the background and an editor in use.
async function batteryPages() {
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
            packageW: 9,
            battery: { present: true, onBattery: true, energyWh: 40 - i * 9.5 * 30 / 3600 },
            focusUsec: { editor: 30e6 },
        });
    }
    await saveLedger(path, ledger);

    const settings = newSettings();
    const history = new HistorySource(settings, path);
    const window = new Adw.PreferencesWindow({ title: 'Resource Pulse' });
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
    ok(r.drain.value.label === '9.5 W' && r.runtime.value.label === 'about 4h 12m' && r.used.value.label.includes('% of a full charge'),
        `tracking: summary '${r.used.value.label}', '${r.drain.value.label}', '${r.runtime.value.label}'`);
    ok(r.rest.visible && r.idle.value.label !== 'not measured', 'tracking: the unmeasured rest and the idle share are shown');

    r.batteryOnly.active = false;
    ok(r.time.title === 'Time recorded' && !r.drain.visible, 'tracking: the AC-and-battery view drops the battery figures');
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
