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

    print(`PREFS-CHECK ${failures === 0 ? 'DONE' : 'FAILED'}: ${checks - failures} of ${checks} checks passed`);
    // Leave the default-state window up for the driver's screenshot.
    const linger = Number(ARGV[1] ?? 0);
    if (linger > 0) {
        shown.window.set_default_size(640, 660);
        shown.window.present();
        await sleep(linger);
    }
    shown.dispose();
    shown.window.destroy();
}

main().catch(e => {
    failures++;
    print(`PREFS-CHECK FAIL: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
System.exit(failures === 0 ? 0 : 1);
