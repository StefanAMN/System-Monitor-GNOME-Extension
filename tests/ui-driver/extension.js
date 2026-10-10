// Test-only driver, loaded by `./dev.sh test-ui` inside an isolated headless shell.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

const TARGET = 'resource-pulse@stefanamn.github.io';
const TABS = ['overview', 'cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu'];

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

// The overview is a grid: every visible card has the same size, whatever it
// has to say, and every bar sits on the same line of its card.
function overviewGrid(rp, label) {
    const cards = Object.entries(rp._summaryCards).filter(([, card]) => card.box.visible);
    check(cards.length >= 6, `${label}: only ${cards.length} overview cards are visible`);
    const size = card => `${Math.round(card.box.width)}x${Math.round(card.box.height)}`;
    const sizes = new Set(cards.map(([, card]) => size(card)));
    check(sizes.size === 1, `${label}: overview cards differ in size (${cards.map(([key, card]) => `${key} ${size(card)}`).join(', ')})`);
    const barLine = card => Math.round(card.pbar.get_transformed_position()[1] - card.box.get_transformed_position()[1]);
    const lines = new Set(cards.map(([, card]) => barLine(card)));
    check(lines.size === 1, `${label}: bars sit at different heights (${cards.map(([key, card]) => `${key} ${barLine(card)}`).join(', ')})`);
    console.log(`RP-UITEST ${label}: ${cards.length} overview cards of ${[...sizes][0]}, bar at ${[...lines][0]}px`);
}

// No row of the GPU page may show a placeholder: what the GPU does not
// report is left out.
function gpuPlaceholders(rp) {
    const found = [];
    eachDescendant(rp._detailSections.gpu, actor => {
        if (actor instanceof St.Label && actor.is_mapped() && /(^|\s)--$/.test(actor.text)) {
            const row = actor.get_parent().get_children().map(child => child.text).filter(Boolean).join(' ');
            found.push(row);
        }
    });
    return found;
}

// Texts of the mapped labels below `root` that are cut off with an ellipsis.
function cutOffLabels(root) {
    const cut = [];
    eachDescendant(root, actor => {
        if (actor instanceof St.Label && actor.is_mapped() && actor.clutter_text.get_layout().is_ellipsized()) cut.push(actor.text);
    });
    return cut;
}

async function cycleTabs(rp, pass, tag = null) {
    rp._indicator.menu.open();
    for (const tab of TABS) {
        rp._activeTab = tab;
        rp._updateTabVisibility();
        // Overlapping calls on purpose: the poll guard must absorb them.
        rp._poll();
        rp._poll();
        await sleep(1300);
        rp._poll();
        await sleep(400);
        if (tag) await shot(`${tag}-${tab}`);
        if (tab === 'overview') overviewGrid(rp, `pass ${pass}${tag ? ` ${tag}` : ''}`);
        if (tab === 'gpu' && rp._lastGpu?.present) {
            const placeholders = gpuPlaceholders(rp);
            check(placeholders.length === 0, `pass ${pass}: the GPU page shows placeholders (${placeholders.join(' | ')})`);
            const cut = cutOffLabels(rp._detailSections.gpu);
            check(cut.length === 0, `pass ${pass}: cut-off text on the GPU page: ${cut.join(' | ')}`);
        }
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

// Whether the keyboard focus is on `root` or something inside it (there may
// be no focused actor at all).
function focusWithin(root) {
    const focus = global.stage.get_key_focus();
    return !!focus && root.contains(focus);
}

function eachDescendant(actor, visit) {
    visit(actor);
    actor.get_children().forEach(child => eachDescendant(child, visit));
}

// Real key events through the compositor.
let keyboard = null;
async function pressKey(keyval, settle = 600) {
    if (!keyboard) {
        keyboard = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
    await sleep(60);
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    await sleep(settle);
}

// The keyboard in the panel: Down and Tab from the top-bar button get in,
// Backspace goes back from a page with the focus kept inside, Escape closes.
async function panelKeyboard(rp) {
    await clickActor(rp._indicator);
    check(rp._indicator.menu.isOpen, 'keyboard: the panel button did not open the menu');
    await pressKey(Clutter.KEY_Down);
    const entered = global.stage.get_key_focus();
    check(entered !== rp._menuSection && focusWithin(rp._menuContainer),
        `keyboard: Down from the panel button focused ${entered?.constructor.name}.${entered?.style_class}, not something in the panel`);
    await pressKey(Clutter.KEY_Tab);
    const next = global.stage.get_key_focus();
    check(next !== entered && focusWithin(rp._menuContainer), 'keyboard: Tab did not move on inside the panel');

    const card = rp._summaryCards.cpu.box;
    card.grab_key_focus();
    await pressKey(Clutter.KEY_Return);
    check(rp._activeTab === 'cpu' && focusWithin(rp._detailArea), `keyboard: Return on the CPU card gave '${rp._activeTab}' with the focus elsewhere`);
    await pressKey(Clutter.KEY_BackSpace);
    check(rp._activeTab === 'overview' && rp._indicator.menu.isOpen && focusWithin(rp._overviewPage),
        `keyboard: Backspace left the tab at '${rp._activeTab}', focus ${focusWithin(rp._overviewPage) ? 'kept' : 'lost'}`);
    await pressKey(Clutter.KEY_Escape);
    check(!rp._indicator.menu.isOpen, 'keyboard: Escape did not close the menu');
    await sleep(400);
}

// The panel size is reset from the preferences window, which only writes
// the settings: the open panel must follow.
async function panelSizeFollows(rp) {
    const s = rp._settings;
    rp._indicator.menu.open();
    await sleep(600);
    const auto = Math.round(rp._menuViewport.width);
    s.set_int('menu-custom-width', 460);
    s.set_int('menu-custom-height', 600);
    await sleep(800);
    check(Math.round(rp._menuViewport.width) === 460, `panel size: ${Math.round(rp._menuViewport.width)} px wide after a stored 460`);
    s.set_int('menu-custom-width', 0);
    s.set_int('menu-custom-height', 0);
    await sleep(800);
    check(Math.round(rp._menuViewport.width) === auto, `panel size: ${Math.round(rp._menuViewport.width)} px after a reset, ${auto} before`);
    rp._indicator.menu.close();
    await sleep(400);
}

// A focused overview card opens its page on Return and on Space, sent as
// real key events through the compositor.
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

// Eight pinned metrics do not fit a 1280 px panel next to the clock. The
// panel must stay inside its room without ellipsizing: trailing metrics drop
// to their icon, and get their label back once there is room again.
async function topBarFits(rp) {
    const right = Main.panel._rightBox;
    const state = () => {
        const labels = Object.entries(rp._topBarWidgets).map(([key, w]) => ({ key, label: w.label }));
        return {
            labels,
            wanted: right.get_preferred_width(-1)[1],
            got: right.allocation.get_width(),
            shown: labels.filter(l => l.label.visible).map(l => l.key),
            ellipsized: labels.filter(l => l.label.visible && l.label.clutter_text.get_layout().is_ellipsized()).map(l => l.key)
        };
    };
    let s = state();
    check(s.wanted <= s.got + 1, `top bar: the panel's right side wants ${s.wanted}px and gets ${s.got}px with all 8 pinned`);
    check(s.ellipsized.length === 0, `top bar: ellipsized labels: ${s.ellipsized.map(k => `${k} '${rp._topBarWidgets[k].label.text}'`).join(', ')}`);
    check(right.get_transformed_position()[0] + right.width <= global.stage.width + 1, 'top bar: the right side runs off the screen');
    check(s.shown.length > 0 && s.shown.length < 8, `top bar: expected some labels collapsed at 1280px, ${s.shown.length} of 8 shown`);
    check(s.shown.join() === s.labels.slice(0, s.shown.length).map(l => l.key).join(),
        `top bar: collapsed out of order, shown: ${s.shown.join()}`);
    const collapsedKey = s.labels[s.shown.length].key;

    // A collapsed metric still tells its value: on hover, in the tooltip.
    pointer ??= Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const box = rp._topBarWidgets[collapsedKey].box;
    const [bx, by] = box.get_transformed_position();
    // The tooltip is composed when the pointer enters; a poll may change
    // the value right after, so compare with the value at that moment.
    // Two motions: the first event of a just-created virtual pointer only
    // places it, and enters nothing on shells before 50.
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 300, 400);
    await sleep(300);
    const values = [rp._topBarWidgets[collapsedKey].label.text];
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), bx + box.width / 2, by + box.height / 2);
    await sleep(150);
    values.push(rp._topBarWidgets[collapsedKey].label.text);
    await sleep(550);
    const firstLine = rp._tooltip?.text.split('\n')[0];
    check(rp._tooltip?.visible && values.some(v => firstLine.endsWith(`: ${v}`)),
        `top bar: tooltip of collapsed ${collapsedKey} starts '${firstLine}', value was '${values.join("' / '")}'`);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), 300, 400);
    await sleep(400);

    // Room returns: every label comes back.
    rp._settings.set_strv('pinned-metrics', ['cpu', 'memory', 'thermal']);
    await sleep(1500);
    s = state();
    check(s.shown.length === 3 && rp._topBarCollapsed === 0, `top bar: with 3 pinned, labels shown: ${s.shown.join() || 'none'}`);

    rp._settings.set_strv('pinned-metrics', ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu']);
    await sleep(1500);
    s = state();
    check(s.wanted <= s.got + 1 && s.ellipsized.length === 0, `top bar: after re-pinning all 8 wants ${s.wanted}px, gets ${s.got}px (${s.shown.length} labels shown, ${rp._topBarCollapsed} collapsed, fit ${rp._fitIdleId ? 'pending' : 'idle'})`);
}

// A collector that never answers (a hung nvidia-smi, a dead mount) must
// cost its own metric only: the others keep updating and it is not started
// again while the first call is outstanding.
// The preferences window. Its pages are checked by prefs-check.js, a GTK
// client of this shell working on a memory-backed copy of the settings and a
// fixture history; it prints a SHOW line for each page it puts on screen and
// the driver screenshots it. Then the real window is opened from the panel,
// with the pointer.
async function prefsWindow(rp) {
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const root = Main.extensionManager.lookup(TARGET).path;
    const runtime = Gio.File.new_for_path(GLib.get_user_runtime_dir());
    const listing = runtime.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let socket = null;
    for (let info = listing.next_file(null); info; info = listing.next_file(null)) {
        if (/^wayland-\d+$/.test(info.get_name())) socket = info.get_name();
    }
    listing.close(null);
    check(socket, 'prefs: no Wayland socket of this shell found');

    const titled = () => global.get_window_actors().map(a => a.meta_window).find(w => w.title === 'Resource Pulse');
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
    launcher.setenv('WAYLAND_DISPLAY', socket, true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    const proc = launcher.spawnv(['gjs', '-m', `${here}/prefs-check.js`, root, '1200']);
    const lines = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
    const readLine = () => new Promise((resolve, reject) => lines.read_line_async(GLib.PRIORITY_DEFAULT, null, (obj, res) => {
        try {
            const [line] = obj.read_line_finish_utf8(res);
            resolve(line);
        } catch (e) {
            reject(e);
        }
    }));
    const verdict = [];
    for (let line = await readLine(); line !== null; line = await readLine()) {
        if (!line.startsWith('PREFS-CHECK')) continue;
        const show = /^PREFS-CHECK SHOW ([\w-]+)/.exec(line);
        if (show) {
            await sleep(700);
            check(titled(), `prefs: no window on screen for the ${show[1]} page`);
            await shot(`prefs-${show[1]}`);
        } else {
            verdict.push(line);
        }
    }
    await new Promise(resolve => proc.wait_async(null, () => resolve()));
    check(proc.get_successful() && verdict.some(line => line.startsWith('PREFS-CHECK DONE')),
        `prefs: ${verdict.join(' | ') || `no verdict (exit ${proc.get_exit_status()})`}`);
    console.log(`RP-UITEST ${verdict.join(' | ')}`);
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);

    // The real window, from the overview's menu button: all settings live there.
    rp._indicator.menu.open();
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    await sleep(600);
    await clickActor(rp._overviewMenuBtn);
    for (let i = 0; i < 40 && !titled(); i++) await sleep(250);
    check(titled(), 'prefs: the menu button did not open the window');
    check(!rp._indicator.menu.isOpen, 'prefs: the menu stayed open over the window');
    for (let i = 0; i < 20 && rp._settings.get_string('prefs-page') !== ''; i++) await sleep(150);
    check(rp._settings.get_string('prefs-page') === '', `prefs: the window did not take the Settings page ('${rp._settings.get_string('prefs-page')}')`);
    await sleep(1500);
    await shot('prefs-window');
    titled().delete(global.get_current_time());
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);

    // The battery page's line opens the window on the Tracking page.
    rp._indicator.menu.open();
    rp._activeTab = 'battery';
    rp._updateTabVisibility();
    await sleep(1500);
    check(rp._batTopAppLabel.text.includes('tracking is off'), `battery line: '${rp._batTopAppLabel.text}' with tracking off`);
    ensureActorVisibleInScrollView(rp._scrollView, rp._batTopApp);
    await sleep(600);
    await shot('battery-top-app');
    await clickActor(rp._batTopApp);
    for (let i = 0; i < 40 && !titled(); i++) await sleep(250);
    check(titled(), 'prefs: the battery line did not open the window');
    for (let i = 0; i < 20 && rp._settings.get_string('prefs-page') !== ''; i++) await sleep(150);
    check(rp._settings.get_string('prefs-page') === '', `prefs: the window did not take the page it was asked for ('${rp._settings.get_string('prefs-page')}')`);
    await sleep(1200);
    await shot('prefs-window-tracking');
    titled().delete(global.get_current_time());
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
}

// The GPU page with three kinds of reading, fed through the real poll: a GPU
// that reports everything, one that reports only its load, and none at all.
async function gpuPageFollowsReadings(rp) {
    rp._indicator.menu.open();
    rp._activeTab = 'gpu';
    rp._updateTabVisibility();
    const wait = rp._settings.get_int('poll-interval') * 1000 + 1500;
    const feed = async reading => {
        rp._gpu.sample = () => Promise.resolve(reading);
        await sleep(wait);
    };
    const rows = () => [rp._gpuCoreClock, rp._gpuTemp, rp._gpuFan, rp._gpuPower].map(row => row.row.visible).join();
    const fields = () => ['clock', 'temp', 'power'].map(key => rp._gpuHwFields[key].visible).join();

    const full = {
        present: true, brand: 'NVIDIA', model: 'NVIDIA GeForce RTX 4070 Laptop GPU with Max-Q Design', driver: 'NVIDIA 550.120',
        percent: 37, memPercent: 25, memUsed: 2e9, memTotal: 8e9, memFree: 6e9,
        temp: 61, powerDraw: 42.5, clock: 1800, maxClock: 2400, fanSpeed: 0
    };
    await feed(full);
    check(rows() === 'true,true,true,true' && fields() === 'true,true,true' && rp._gpuHwStatsRow.visible && rp._gpuVramCard.visible,
        `gpu page: a GPU that reports everything shows rows ${rows()}, fields ${fields()}`);
    check(rp._gpuFan.val.text === '0 RPM' && rp._gpuPower.val.text === '42.5 W' && rp._gpuHwClockVal.text === '1800 / 2400 MHz',
        `gpu page: values are '${rp._gpuFan.val.text}', '${rp._gpuPower.val.text}', '${rp._gpuHwClockVal.text}'`);
    check(gpuPlaceholders(rp).length === 0, `gpu page: placeholders with a full reading (${gpuPlaceholders(rp).join(' | ')})`);
    // A model name longer than the card wraps; it is never cut off.
    const nameLines = rp._gpuModelName.clutter_text.get_layout().get_line_count();
    check(nameLines >= 2 && cutOffLabels(rp._detailSections.gpu).length === 0,
        `gpu page: a long model name is on ${nameLines} line(s), cut off: ${cutOffLabels(rp._detailSections.gpu).join(' | ') || 'nothing'}`);
    const [cardX] = rp._gpuHwCard.get_transformed_position();
    const [nameX] = rp._gpuModelName.get_transformed_position();
    check(nameX + rp._gpuModelName.width <= cardX + rp._gpuHwCard.width, 'gpu page: the model name runs past its card');
    await shot('gpu-full');

    await feed({
        ...full, brand: 'Intel', model: 'Intel Graphics', driver: 'i915', memPercent: 0, memUsed: 0, memTotal: 0, memFree: 0,
        temp: 0, powerDraw: null, clock: null, maxClock: null, fanSpeed: null
    });
    check(rows() === 'false,false,false,false' && !rp._gpuHwStatsRow.visible && !rp._gpuVramCard.visible,
        `gpu page: a GPU that reports only its load still shows rows ${rows()}`);
    check(rp._gpuUsage.row.is_mapped() && rp._gpuUsage.val.text === '37%' && rp._gpuHwCard.visible,
        `gpu page: the load row reads '${rp._gpuUsage.val.text}'`);
    check(gpuPlaceholders(rp).length === 0, `gpu page: placeholders with a bare reading (${gpuPlaceholders(rp).join(' | ')})`);
    await shot('gpu-bare');

    await feed({ present: false, percent: 0 });
    check(rp._gpuInactiveCard.visible && !rp._gpuHwCard.visible && !rp._gpuSparkCard.visible && !rp._gpuStatsCard.visible,
        'gpu page: without a GPU the cards of readings are still shown');
    check(gpuPlaceholders(rp).length === 0, `gpu page: placeholders without a GPU (${gpuPlaceholders(rp).join(' | ')})`);
    check(cutOffLabels(rp._detailSections.gpu).length === 0, `gpu page: the notice is cut off: ${cutOffLabels(rp._detailSections.gpu).join(' | ')}`);
    await shot('gpu-none');
    check(rp._summaryCards.gpu.valueLabel.text === 'n/a', `gpu card: reads '${rp._summaryCards.gpu.valueLabel.text}' without a GPU`);

    delete rp._gpu.sample;
    await sleep(wait);
    check(rp._gpuHwCard.visible === !!rp._lastGpu?.present, 'gpu page: did not follow the real reading again');
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// Battery tracking in the real shell: off by default; on, it must attribute
// a CPU burner's time to the burner's own app scope. The burner is started
// by the user's systemd as `app-rptest-<tag>-1.scope`, as GNOME starts apps.
async function batteryTracking(rp) {
    const s = rp._settings;
    check(!s.get_boolean('battery-tracking') && !rp._tracker, 'tracking: running although it is off by default');
    s.set_boolean('battery-tracking', true);
    for (let i = 0; i < 40 && !rp._tracker?.lastSample; i++) await sleep(250);
    check(rp._tracker?.running && rp._tracker.lastSample, 'tracking: did not start');
    const path = rp._tracker.path;
    check(path.startsWith(GLib.get_user_data_dir()), `tracking: history kept outside the data directory (${path})`);

    if (!rp._tracker.lastSample.appsAvailable) {
        console.log('RP-UITEST tracking: no systemd user cgroups in this environment; the burner check was not run');
    } else {
        const tag = `burner${GLib.random_int_range(1000, 9999)}`;
        const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
        // The sandbox has its own runtime directory and bus; the user's
        // systemd is reached through its private socket.
        launcher.setenv('XDG_RUNTIME_DIR', `/run/user/${new Gio.Credentials().get_unix_user()}`, true);
        launcher.unsetenv('DBUS_SESSION_BUS_ADDRESS');
        const burner = launcher.spawnv(['systemd-run', '--user', '--scope', '--quiet', `--unit=app-rptest-${tag}-1.scope`,
            'timeout', '8', 'sh', '-c', 'while :; do :; done']);
        const done = new Promise(resolve => burner.wait_async(null, () => resolve()));
        // CPU per app gained while the burner ran (other apps of the
        // session were busy before it, and may be now).
        const cpuNow = () => new Map(rp._tracker.ledger.summarize().apps.map(a => [a.id, a.cpu]));
        await rp._tracker.tick();
        const before = cpuNow();
        await sleep(500);
        await rp._tracker.tick();
        await sleep(5500);
        await rp._tracker.tick();
        await done;
        const sum = rp._tracker.ledger.summarize();
        const gained = a => ({ ...a, cpu: a.cpu - (before.get(a.id) ?? 0) });
        const byCpu = sum.apps.filter(a => !a.id.startsWith('@')).map(gained).sort((x, y) => y.cpu - x.cpu);
        const found = sum.apps.find(a => a.id === tag);
        // Born after the previous sample: counted from zero, about 6 s of one core.
        check(found && found.cpu > 4.5e6 && found.cpu < 7e6,
            `tracking: burner ${tag} got ${found ? (found.cpu / 1e6).toFixed(2) : 'no'} s of CPU (expected about 6)`);
        check(byCpu[0]?.id === tag, `tracking: top app by CPU is ${byCpu[0]?.id}, not the burner`);
        console.log(`RP-UITEST tracking: burner ${(found.cpu / 1e6).toFixed(2)} s CPU, ${(found.wh * 1000).toFixed(2)} mWh, ` +
            `energy ${sum.hasEnergy ? 'measured' : 'not readable'}; next: ${byCpu.slice(1, 3).map(a => `${a.id} ${(a.cpu / 1e6).toFixed(2)} s`).join(', ')}`);
    }

    // The preferences window asks for a save, then for clearing.
    const mtime = () => {
        const f = Gio.File.new_for_path(path);
        return f.query_exists(null) ? f.query_info('time::modified,time::modified-usec', 0, null).get_modification_date_time().to_unix_usec() : 0;
    };
    const before = mtime();
    await sleep(1100);
    s.set_boolean('action-flush-history', true);
    for (let i = 0; i < 20 && mtime() === before; i++) await sleep(150);
    check(mtime() > before && !s.get_boolean('action-flush-history'), 'tracking: a flush request did not write the history');
    s.set_boolean('action-clear-history', true);
    await sleep(800);
    const cleared = JSON.parse(new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]));
    check(cleared.buckets.length === 0 && rp._tracker.ledger.buckets.length === 0, `tracking: clearing left ${cleared.buckets.length} hours in the file`);

    s.set_boolean('battery-tracking', false);
    await sleep(500);
    check(!rp._tracker, 'tracking: still running after being switched off');
}

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
            if (!w.label.visible) continue;
            const [textW] = w.label.clutter_text.get_layout().get_pixel_size();
            const slack = w.label.width - textW;
            check(slack <= 14, `top-bar ${key} reserves ${slack}px beyond its text '${w.label.text}'`);
        }
        const kids = rp._indicatorBox.get_children();
        check(kids.filter(k => k.style_class === 'resource-pulse-divider' && k.width > 0).length === 7, 'top-bar dividers missing');
    }
    await topBarFits(ext.stateObj);

    // Pages are built on first visit, not in enable().
    check(Object.keys(ext.stateObj._detailSections).length === 0, 'detail pages were built eagerly');
    await clickThrough(ext.stateObj, 'first open');
    await cycleTabs(ext.stateObj, 1, 'dark');
    check(Object.keys(ext.stateObj._detailSections).length === 8, 'detail pages missing after visiting every tab');
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

    await panelKeyboard(ext.stateObj);
    await panelSizeFollows(ext.stateObj);
    await prefsWindow(ext.stateObj);
    await gpuPageFollowsReadings(ext.stateObj);
    await batteryTracking(ext.stateObj);
    await keyboardOpensCards(ext.stateObj);
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
            async e => {
                // What the screen looked like when it went wrong.
                await shot('failure').catch(() => {});
                console.log(`RP-UITEST FAIL: ${e.message}\n${e.stack}`);
            });
    }

    disable() {}
}
