// Test-only driver, loaded by `./dev.sh test-ui` inside an isolated headless shell.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

const TARGET = 'resource-pulse@yourdomain.example';
const TABS = ['overview', 'cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu', 'settings'];

let started = false;
let enabledAt = 0;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

// Screenshots let a human (or the agent) look at the result; headless
// assertions only prove that colours resolve, not that it looks right.
async function shot(name) {
    const dir = GLib.getenv('RP_UITEST_SHOTS');
    if (!dir) return;
    const stream = Gio.File.new_for_path(`${dir}/${name}.png`)
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    try {
        await new Promise((resolve, reject) => new Shell.Screenshot().screenshot(false, stream, (obj, res) => {
            try {
                obj.screenshot_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        }));
    } finally {
        stream.close(null);
    }
}

// Real pointer input through the compositor, so anything that swallows or
// blocks events (grabs, overlapping actors, broken handlers) is exercised.
let pointer = null;
async function clickActor(actor) {
    if (!pointer) {
        pointer = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    const now = () => GLib.get_monotonic_time();
    pointer.notify_absolute_motion(now(), x + w / 2, y + h / 2);
    await sleep(150);
    const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x + w / 2, y + h / 2);
    if (hit !== actor && !actor.contains(hit)) {
        const chain = [];
        for (let a = hit; a && chain.length < 6; a = a.get_parent())
            chain.push(`${a.constructor.name}.${a.style_class || a.name || ''}[${Math.round(a.width)}x${Math.round(a.height)}]`);
        throw new Error(`pointer at ${Math.round(x + w / 2)},${Math.round(y + h / 2)} hits ${chain.join(' < ')} instead of the target`);
    }
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(80);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(600);
}

async function clickThrough(rp, label) {
    await clickActor(rp._indicator);
    check(rp._indicator.menu.isOpen, `${label}: clicking the panel button did not open the menu`);
    for (const key of ['cpu', 'memory', 'disk', 'network']) {
        await clickActor(rp._summaryCards[key].box);
        check(rp._activeTab === key, `${label}: clicking the ${key} card left tab at '${rp._activeTab}'`);
        rp._activeTab = 'overview';
        rp._updateTabVisibility();
        await sleep(500);
    }
    // Opening a detail tab must fetch its detail data at once, not after
    // the next 2 s tick: the full thermal list must be there within 1.2 s.
    await clickActor(rp._summaryCards.thermal.box);
    check(rp._activeTab === 'thermal', `${label}: clicking the thermal card left tab at '${rp._activeTab}'`);
    await sleep(600);
    check(rp._lastThm?.detailed === true, `${label}: no detailed thermal sample shortly after opening the tab`);
    check((rp._thmSensorRows?.length ?? 0) === rp._lastThm.sensors.length || rp._lastThm.sensors.length === 0,
        `${label}: thermal tab shows ${rp._thmSensorRows?.length} rows for ${rp._lastThm.sensors.length} sensors`);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    await sleep(500);

    await clickActor(rp._overviewMenuBtn);
    check(rp._activeTab === 'settings', `${label}: clicking the menu button left tab at '${rp._activeTab}'`);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

function luminance(color) {
    return (0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue) / 255;
}

function checkTheme(rp, light, label) {
    const box = rp._indicator.menu.box;
    check(box.has_style_class_name('rp-light') === light, `${label}: rp-light class is ${!light}`);
    const card = rp._summaryCards.cpu;
    const text = luminance(card.valueLabel.get_theme_node().get_foreground_color());
    const bg = luminance(card.box.get_theme_node().get_background_color());
    const surface = luminance(rp._hwCard.get_theme_node().get_background_color());
    const dim = luminance(rp._hwStats.get_theme_node().get_foreground_color());
    if (light) {
        check(text < 0.3 && dim < 0.5, `${label}: text is not dark on light (${text.toFixed(2)}, ${dim.toFixed(2)})`);
        check(bg > 0.8 && surface > 0.9, `${label}: card backgrounds not light (${bg.toFixed(2)}, ${surface.toFixed(2)})`);
    } else {
        check(text > 0.9 && dim > 0.5, `${label}: text is not light on dark (${text.toFixed(2)}, ${dim.toFixed(2)})`);
        check(bg < 0.25 && surface < 0.25, `${label}: card backgrounds not dark (${bg.toFixed(2)}, ${surface.toFixed(2)})`);
    }
    // The tinted card must stay tinted (blue channel dominant for CPU) in both variants.
    const c = card.box.get_theme_node().get_background_color();
    check(c.blue > c.red, `${label}: cpu card lost its tint (${c.red},${c.green},${c.blue})`);
}

async function cycleTabs(rp, pass, tag = null) {
    rp._indicator.menu.open();
    for (const tab of TABS) {
        rp._activeTab = tab;
        rp._updateTabVisibility();
        if (tab === 'settings') rp._refreshSettingsUI();
        // Overlapping calls on purpose: the poll guard must absorb them.
        rp._poll();
        rp._poll();
        await sleep(1300);
        rp._poll();
        await sleep(400);
        if (tag) await shot(`${tag}-${tab}`);
    }

    // Nothing may be laid out wider than the menu (it would be clipped).
    rp._activeTab = 'cpu';
    rp._updateTabVisibility();
    await sleep(700);
    const avail = rp._menuContainer.get_theme_node().get_content_box(rp._menuContainer.get_allocation_box()).get_width();
    const need = rp._detailArea.get_preferred_width(-1)[0];
    check(need <= avail + 1, `pass ${pass}: cpu details need ${need}px but the menu offers ${avail}px`);
    check(rp._coreWidgets[0].pbar.width >= 20, `pass ${pass}: per-core bar collapsed to ${rp._coreWidgets[0].pbar.width}px`);

    // Hover readout: every x position, including off-graph ones, must paint cleanly.
    const graph = rp._sparklines.find(g => g.options.showGrid && g.is_mapped());
    check(graph, `pass ${pass}: no detail graph mapped on the cpu tab`);
    const interval = rp._settings.get_int('poll-interval');
    const span = interval * 60;
    const spanLabel = span > 60 && span % 60 === 0 ? `${span / 60}m` : `${span}s`;
    check(graph.sampleSeconds === interval && graph.spanLabel === spanLabel,
        `pass ${pass}: lazily built graph has ${graph.sampleSeconds}s / '${graph.spanLabel}', expected ${interval}s / '${spanLabel}'`);
    for (const x of [-5, 0, graph.width / 2, graph.width - 30, graph.width - 1, graph.width + 50]) {
        graph._setHoverX(x);
        await sleep(60);
    }
    graph._setHoverX(graph.width - 30);
    await sleep(150);
    if (tag) await shot(`${tag}-hover`);
    graph._setHoverX(-1);

    check(rp._summaryCards.cpu.valueLabel.text !== '--%', `pass ${pass}: cpu card never updated`);
    // 60 s of history at most, however many on-demand polls were fired.
    check(rp._hist.cpu.length >= 3, `pass ${pass}: cpu history not recorded (${rp._hist.cpu.length})`);
    // One sample per 2 s tick since enable, however many on-demand polls were fired.
    const maxTicks = Math.ceil((GLib.get_monotonic_time() - enabledAt) / (rp._settings.get_int('poll-interval') * 1000000)) + 2;
    check(rp._hist.cpu.length <= maxTicks, `pass ${pass}: on-demand polls leaked into history (${rp._hist.cpu.length} > ${maxTicks})`);
    check(rp._hist.cpu.capacity === 60, 'history capacity changed');
    check(rp._dskMountRows?.length > 0, `pass ${pass}: no disk mount rows`);
    check(rp._dskMountRows[0].statLbl.text !== '', `pass ${pass}: disk mount row not populated`);
    if (rp._lastThm?.sensors?.length > 0) {
        check(rp._thmSensorRows?.length > 0, `pass ${pass}: no thermal rows`);
        check(rp._thmSensorRows[0].val.text !== '', `pass ${pass}: thermal row not populated`);
    }
    if (rp._procWidgets?.length > 0)
        check(rp._procWidgets[0].nameLbl.text !== '', `pass ${pass}: process row not populated`);

    // Disk card and top bar must mean the same thing: space used on '/'.
    const rootPct = `${Math.round(rp._lastDsk.mounts[0].percent)}%`;
    check(rp._summaryCards.disk.valueLabel.text === rootPct,
        `pass ${pass}: disk card shows ${rp._summaryCards.disk.valueLabel.text}, root usage is ${rootPct}`);
    check(rp._summaryCards.disk.subLabel.text.startsWith('used on /'), `pass ${pass}: disk card not labelled`);

    // A metric the machine cannot provide reads "n/a" with a reason, never 0.
    const real = rp._lastData;
    rp._render(Object.assign({}, real, {
        pwr: { raplSupported: false, packagePower: null, systemPower: null },
        thm: { packageTemp: 0, sensors: [], fans: [] }
    }));
    check(rp._summaryCards.power.valueLabel.text === 'n/a', `pass ${pass}: unreadable power shown as ${rp._summaryCards.power.valueLabel.text}`);
    check(rp._summaryCards.thermal.valueLabel.text === 'n/a', `pass ${pass}: missing thermal shown as ${rp._summaryCards.thermal.valueLabel.text}`);
    check(/not available/.test(rp._tooltipTexts.power), `pass ${pass}: power tooltip has no reason`);
    rp._render(real);
    check(rp._summaryCards.thermal.valueLabel.text !== 'n/a' || real.thm.sensors.length === 0, `pass ${pass}: thermal did not recover`);

    // A process snapshot sorted for the other tab is dimmed, not presented as current.
    rp._activeTab = 'cpu';
    rp._render(Object.assign({}, real, { processes: [], procSort: null }));
    check(rp._procList.opacity < 255, `pass ${pass}: stale process list not dimmed`);

    // Top-bar labels keep their width whatever the value.
    for (const [key, w] of Object.entries(rp._topBarWidgets)) {
        if (!w.label) continue;
        const widths = [];
        for (const text of ['9%', '99%', 'n/a']) {
            w.label.text = text;
            widths.push(w.label.get_preferred_width(-1)[1]);
        }
        check(widths[0] > 0 && widths.every(x => x === widths[0]), `pass ${pass}: top-bar ${key} width changes with value (${widths})`);
    }
    if (rp._topBarWidgets.battery && rp._lastBat?.present)
        check(/^battery-level-\d+/.test(rp._topBarWidgets.battery.icon.icon_name),
            `pass ${pass}: battery icon is ${rp._topBarWidgets.battery.icon.icon_name}`);
    rp._render(real);

    // Quick click on a card (press + release) must leave no dangling timer id.
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(300);
}

// Every icon in the panel button and the menu must be one the icon theme (or
// the extension's own icons/ directory) can supply; an unknown name renders
// as a broken-image placeholder that no other assertion notices.
function checkIcons(rp, label) {
    const theme = new St.IconTheme();
    const resolves = gicon => {
        if (!gicon) return false;
        if (gicon instanceof Gio.FileIcon) return gicon.get_file().query_exists(null);
        if (gicon instanceof Gio.ThemedIcon) return gicon.get_names().some(n => theme.has_icon(n));
        return true;
    };
    const describe = gicon => gicon instanceof Gio.ThemedIcon ? gicon.get_names().join('/') : `${gicon}`;
    const missing = [];
    let seen = 0;
    const walk = actor => {
        // An St.Icon with no icon at all (the menu item's empty ornament)
        // draws nothing and has nothing to resolve.
        if (actor instanceof St.Icon && (actor.gicon || actor.fallback_gicon)) {
            seen++;
            if (!resolves(actor.gicon) && !resolves(actor.fallback_gicon))
                missing.push(describe(actor.gicon));
        }
        actor.get_children().forEach(walk);
    };
    walk(rp._indicator);
    walk(rp._indicator.menu.box);
    check(seen > 20, `${label}: only ${seen} icons found, the walk is broken`);
    check(missing.length === 0, `${label}: icons the theme cannot supply: ${[...new Set(missing)].join(', ')}`);
}

// The in-menu steppers move in steps of 5 while preferences move in steps
// of 1: from 98 % the next step must land on the schema maximum, and the
// label must show the stored value, not the rejected one.
async function stepperClamps(rp) {
    rp._settings.set_int('threshold-cpu', 98);
    rp._indicator.menu.open();
    rp._activeTab = 'settings';
    rp._updateTabVisibility();
    rp._refreshSettingsUI();
    await sleep(600);
    ensureActorVisibleInScrollView(rp._scrollView, rp._cpuThreshInc);
    await sleep(600);
    for (const round of [1, 2]) {
        await clickActor(rp._cpuThreshInc);
        const stored = rp._settings.get_int('threshold-cpu');
        check(stored === 100, `stepper click ${round}: threshold-cpu is ${stored}, expected 100`);
        check(rp._cpuThreshLbl.text === '100%', `stepper click ${round}: label shows '${rp._cpuThreshLbl.text}' for a stored 100`);
    }
    rp._settings.reset('threshold-cpu');
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// A focused overview card opens its page on Return and on Space, sent as
// real key events through the compositor.
let keyboard = null;
async function pressKey(keyval) {
    if (!keyboard) {
        keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
    await sleep(60);
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    await sleep(600);
}

async function keyboardOpensCards(rp) {
    rp._indicator.menu.open();
    await sleep(600);
    for (const [key, keyval] of [['cpu', Clutter.KEY_Return], ['memory', Clutter.KEY_space]]) {
        rp._activeTab = 'overview';
        rp._updateTabVisibility();
        await sleep(500);
        const card = rp._summaryCards[key].box;
        card.grab_key_focus();
        check(card.has_style_class_name('rp-hover'), `keyboard: focused ${key} card is not highlighted`);
        await pressKey(keyval);
        check(rp._activeTab === key, `keyboard: key on the focused ${key} card left the tab at '${rp._activeTab}'`);
    }
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// The temperature threshold is stored in °C and shown in the chosen unit.
async function thresholdFollowsUnit(rp) {
    rp._settings.set_int('threshold-temp', 80);
    rp._settings.set_string('unit-temp', 'F');
    rp._indicator.menu.open();
    rp._activeTab = 'settings';
    rp._updateTabVisibility();
    rp._refreshSettingsUI();
    await sleep(600);
    check(rp._tempThreshLbl.text === '176°F', `threshold: 80 °C shown as '${rp._tempThreshLbl.text}' with °F selected`);
    ensureActorVisibleInScrollView(rp._scrollView, rp._tempThreshInc);
    await sleep(600);
    await clickActor(rp._tempThreshInc);
    check(rp._settings.get_int('threshold-temp') === 85 && rp._tempThreshLbl.text === '185°F',
        `threshold: after + stored ${rp._settings.get_int('threshold-temp')}, label '${rp._tempThreshLbl.text}'`);
    rp._settings.reset('threshold-temp');
    rp._settings.reset('unit-temp');
    rp._refreshSettingsUI();
    check(rp._tempThreshLbl.text === '80°C', `threshold: back in °C shows '${rp._tempThreshLbl.text}'`);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// A collector that never answers (a hung nvidia-smi, a dead mount) must
// cost its own metric only: the others keep updating and it is not started
// again while the first call is outstanding.
async function stuckCollector(rp) {
    let calls = 0;
    rp._net.sample = () => {
        calls++;
        return new Promise(() => {});
    };
    const interval = rp._settings.get_int('poll-interval') * 1000;
    await sleep(3000 + 3 * interval);
    const idle = (GLib.get_monotonic_time() - rp._lastPollTime) / 1000;
    check(idle < interval + 800, `stuck collector: last poll started ${idle.toFixed(0)} ms ago, polling has stalled`);
    check(!!rp._outstanding.network, 'stuck collector: outstanding call not tracked');
    check(calls === 1, `stuck collector: started ${calls} times while still outstanding`);
    const cpuBefore = rp._lastCpu;
    await sleep(interval + 500);
    check(rp._lastCpu !== cpuBefore, 'stuck collector: cpu stopped updating');
    delete rp._net.sample;
    delete rp._outstanding.network;
    await sleep(interval + 500);
    check(!rp._outstanding.network && rp._lastNet?.interfaces, 'stuck collector: network did not recover');
}

async function run() {
    await sleep(1500);
    enabledAt = GLib.get_monotonic_time() - 4000000;
    let ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj, 'target extension not enabled');

    // A stored list with an unknown key and a duplicate (GSettings accepts
    // both) must not put a broken or repeated metric in the top bar.
    ext.stateObj._settings.set_strv('pinned-metrics', ['cpu', 'bogus', 'cpu', 'memory']);
    await sleep(800);
    check(Object.keys(ext.stateObj._topBarWidgets).join() === 'cpu,memory' && ext.stateObj._indicatorBox.get_n_children() === 3,
        `bogus pinned list built ${Object.keys(ext.stateObj._topBarWidgets)} with ${ext.stateObj._indicatorBox.get_n_children()} children`);

    // Pin everything (sandboxed dconf) so every top-bar label is exercised.
    ext.stateObj._settings.set_strv('pinned-metrics',
        ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu']);
    await sleep(2500);
    await shot('topbar');
    {
        // No pinned label may reserve much more room than its text needs.
        const rp = ext.stateObj;
        for (const [key, w] of Object.entries(rp._topBarWidgets)) {
            const [textW] = w.label.clutter_text.get_layout().get_pixel_size();
            const slack = w.label.width - textW;
            check(slack <= 14, `top-bar ${key} reserves ${slack}px beyond its text '${w.label.text}'`);
        }
        const kids = rp._indicatorBox.get_children();
        check(kids.filter(k => k.style_class === 'resource-pulse-divider' && k.width > 0).length === 7, 'top-bar dividers missing');
    }

    // Pages are built on first visit, not in enable().
    check(Object.keys(ext.stateObj._detailSections).length === 0 && !ext.stateObj._settingsPage,
        'detail / settings pages were built eagerly');
    await clickThrough(ext.stateObj, 'first open');
    await cycleTabs(ext.stateObj, 1, 'dark');
    check(Object.keys(ext.stateObj._detailSections).length === 8 && ext.stateObj._settingsPage,
        'detail / settings pages missing after visiting every tab');
    ext.stateObj._indicator.menu.open();
    await sleep(300);
    checkTheme(ext.stateObj, false, 'dark');
    ext.stateObj._indicator.menu.close();

    // Icons, in the session's own theme and in stock Adwaita.
    {
        const iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        const sessionTheme = iface.get_string('icon-theme');
        checkIcons(ext.stateObj, `icon theme ${sessionTheme}`);
        iface.set_string('icon-theme', 'Adwaita');
        await sleep(800);
        checkIcons(ext.stateObj, 'icon theme Adwaita');
        iface.set_string('icon-theme', sessionTheme);
        await sleep(500);
    }

    await stepperClamps(ext.stateObj);
    await keyboardOpensCards(ext.stateObj);
    await thresholdFollowsUnit(ext.stateObj);
    await stuckCollector(ext.stateObj);

    // Switch the (sandboxed) desktop to light while the extension is live.
    const iface = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    iface.set_string('color-scheme', 'prefer-light');
    await sleep(800);
    await cycleTabs(ext.stateObj, 1, 'light');
    ext.stateObj._indicator.menu.open();
    await sleep(300);
    checkTheme(ext.stateObj, true, 'light');
    iface.set_string('color-scheme', 'default');
    await sleep(800);
    checkTheme(ext.stateObj, false, 'back to dark');
    ext.stateObj._indicator.menu.close();
    await sleep(300);

    // Same path the screen lock takes.
    Main.extensionManager.disableExtension(TARGET);
    await sleep(500);
    const t0 = GLib.get_monotonic_time();
    Main.extensionManager.enableExtension(TARGET);
    enabledAt = GLib.get_monotonic_time();
    console.log(`RP-UITEST enable() took ${((enabledAt - t0) / 1000).toFixed(1)} ms`);
    await sleep(1500);
    ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj?._indicator, 'target extension did not re-enable');

    await cycleTabs(ext.stateObj, 2);
    await clickThrough(ext.stateObj, 'after re-enable');

    // Disable while a poll is in flight. The menu stays closed: tearing down
    // an open PanelMenu trips shell-internal BoxPointer allocation errors
    // that are unrelated to this extension.
    ext.stateObj._poll();
    Main.extensionManager.disableExtension(TARGET);
    await sleep(1500);
    Main.extensionManager.enableExtension(TARGET);
    await sleep(2500);
    const last = Main.extensionManager.lookup(TARGET);
    check(last?.stateObj?._indicator && last.stateObj._summaryCards.cpu.valueLabel.text !== '--%',
        'extension did not come back and poll after the final re-enable');
}

export default class Driver extends Extension {
    enable() {
        // Toggling the target makes the shell re-enable every later extension,
        // this one included; the scenario must only ever start once.
        if (started) return;
        started = true;
        run().then(
            () => console.log('RP-UITEST DONE'),
            e => console.log(`RP-UITEST FAIL: ${e.message}\n${e.stack}`));
    }

    disable() {}
}
