// Test-only driver, loaded by `./scripts/dev.sh test-ui` inside an isolated headless shell.
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

// Shells before 49 start in the Activities overview, where a client's window
// is a thumbnail: a click there picks the window instead of reaching it, and
// a screenshot shows the thumbnail. Leave the overview and raise the window.
async function bringForward(metaWindow) {
    if (Main.overview.visible) {
        Main.overview.hide();
        for (let i = 0; i < 30 && (Main.overview.visible || Main.overview.animationInProgress); i++) await sleep(100);
    }
    if (!metaWindow.has_focus()) {
        metaWindow.activate(global.get_current_time());
        await sleep(300);
    }
}

// A click inside a client's window (the preferences, a GTK process): the
// client gives the point in its surface, the window's buffer rect says where
// that surface is on the stage.
async function clickInWindow(metaWindow, x, y) {
    pointer ??= Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const rect = metaWindow.get_buffer_rect();
    const now = () => GLib.get_monotonic_time();
    // Two motions: the first event of a just-created virtual pointer only places it.
    pointer.notify_absolute_motion(now(), rect.x + x + 2, rect.y + y + 2);
    await sleep(150);
    pointer.notify_absolute_motion(now(), rect.x + x, rect.y + y);
    await sleep(200);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(80);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(300);
}

// A drag inside a client's window: press at (x1, y1), move there in small
// steps (past GTK's drag threshold, slowly enough for the client to follow),
// release. Points are in the window's surface, as for clickInWindow.
async function dragInWindow(metaWindow, x1, y1, x2, y2) {
    pointer ??= Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const rect = metaWindow.get_buffer_rect();
    const now = () => GLib.get_monotonic_time();
    const at = (x, y) => pointer.notify_absolute_motion(now(), rect.x + x, rect.y + y);
    at(x1 + 2, y1 + 2);
    await sleep(150);
    at(x1, y1);
    await sleep(200);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(120);
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
        at(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
        await sleep(30);
    }
    await sleep(250);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(500);
}

// Scroll an actor into view and wait until the scroll animation has
// finished: a click sent while the content still moves lands elsewhere
// (seen in the slower compat containers).
async function scrollIntoView(rp, actor) {
    ensureActorVisibleInScrollView(rp._scrollView, actor);
    const adj = rp._scrollView.vadjustment ?? rp._scrollView.get_vscroll_bar?.()?.get_adjustment();
    let last = NaN;
    for (let i = 0, still = 0; i < 40 && still < 3; i++) {
        await sleep(100);
        const v = adj ? adj.value : 0;
        still = v === last ? still + 1 : 0;
        last = v;
    }
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

    // Top-bar labels keep their width whatever the value. A metric the
    // machine cannot provide ('n/a') reserves no room for numbers, which
    // would only be a gap after it.
    for (const [key, w] of Object.entries(rp._topBarWidgets)) {
        if (!w.label) continue;
        const widths = [];
        for (const text of ['9%', '99%', 'n/a', '9%']) {
            w.label.text = text;
            widths.push(w.label.get_preferred_width(-1)[1]);
        }
        check(widths[0] > 0 && widths[1] === widths[0] && widths[3] === widths[0], `pass ${pass}: top-bar ${key} width changes with value (${widths})`);
        w.label.text = 'n/a';
        const [naText] = w.label.clutter_text.get_layout().get_pixel_size();
        const naWidth = w.label.get_preferred_width(-1)[1];
        check(naWidth <= widths[0] && naWidth - naText <= 14, `pass ${pass}: top-bar ${key} reserves ${naWidth - naText}px beyond 'n/a' (values: ${widths[0]}px)`);
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
    // The laid-out width: the width property answers the requested size
    // while a relayout is pending, which values changing many times a
    // second make likely.
    rp._indicator.menu.open();
    await sleep(600);
    const auto = Math.round(rp._menuViewport.allocation.get_width());
    s.set_int('menu-custom-width', 460);
    s.set_int('menu-custom-height', 600);
    await sleep(800);
    check(Math.round(rp._menuViewport.allocation.get_width()) === 460, `panel size: ${Math.round(rp._menuViewport.allocation.get_width())} px wide after a stored 460`);
    s.set_int('menu-custom-width', 0);
    s.set_int('menu-custom-height', 0);
    await sleep(800);
    check(Math.round(rp._menuViewport.allocation.get_width()) === auto, `panel size: ${Math.round(rp._menuViewport.allocation.get_width())} px after a reset, ${auto} before`);
    rp._indicator.menu.close();
    await sleep(400);
}

// A focused overview card opens its page on Return and on Space, sent as
// real key events through the compositor.
// What a screen reader is given, read over AT-SPI by a separate process
// (a11y-check.js) as Orca would: one tree per name asked for.
async function a11yTrees(...names) {
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const proc = Gio.Subprocess.new(['gjs', '-m', `${here}/a11y-check.js`, ...names],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    // A client stuck on the accessibility bus must not hang the whole test.
    const killId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    const [, out] = await new Promise((resolve, reject) => proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
            resolve(obj.communicate_utf8_finish(res));
        } catch (e) {
            reject(e);
        }
    }));
    GLib.source_remove(killId);
    const trees = {};
    for (const line of (out ?? '').split('\n')) {
        const tree = /^A11Y-CHECK TREE ([^\t]+)\t(.*)$/.exec(line);
        if (tree) trees[tree[1]] = JSON.parse(tree[2]);
    }
    const verdict = (out ?? '').split('\n').filter(line => /^A11Y-CHECK (DONE|FAIL)/.test(line));
    check(proc.get_successful() && verdict.includes('A11Y-CHECK DONE'), `a11y: the AT-SPI client failed: ${verdict.join(' | ') || `exit ${proc.get_exit_status()}`}`);
    return trees;
}

function a11yNodes(tree, out = []) {
    out.push(tree);
    for (const child of tree.children) a11yNodes(child, out);
    return out;
}

// Interactive (reactive, so 'sensitive') objects a screen reader would
// reach without a name; labels are named by their text.
function a11yUnnamed(tree) {
    return a11yNodes(tree).filter(n => n.showing && n.sensitive && !n.name && n.role !== 'label' && n.role !== 'text')
        .map(n => n.role);
}

const A11Y_BUTTON = /^(push )?button$/;

async function screenReader(rp) {
    const root = Main.extensionManager.lookup(TARGET).path;
    const { spokenValue } = await import(`file://${root}/lib/common/present.js`);
    const { METRIC_NAMES } = await import(`file://${root}/ui/panel/constants.js`);
    // No reading may land while the client reads the names: polls are held
    // (the timer calls whatever rp._poll is) and the last glide finishes.
    const hold = async () => {
        rp._poll = () => {};
        for (let i = 0; i < 50 && (rp._pollInFlight || rp._glideId); i++) await sleep(100);
    };
    const release = () => {
        delete rp._poll;
    };
    const launched = [];
    const launch = rp._launchSystemMonitor;
    try {
        // The top bar: each value named with its metric, dividers as
        // separators, the ⚠ not offered while hidden.
        await hold();
        const bar = (await a11yTrees('Resource Pulse'))['Resource Pulse'];
        const barNodes = a11yNodes(bar);
        check(a11yUnnamed(bar).length === 0, `a11y: unnamed in the top bar: ${a11yUnnamed(bar).join(', ')}`);
        for (const [key, w] of Object.entries(rp._topBarWidgets)) {
            const want = `${METRIC_NAMES[key]} ${spokenValue(w.text)}`;
            check(barNodes.some(n => n.showing && n.name === want), `a11y: no top-bar item '${want}' (have ${barNodes.filter(n => n.sensitive).map(n => `'${n.name}'`).join(', ')})`);
        }
        const separators = barNodes.filter(n => n.role === 'separator').length;
        check(separators === Object.keys(rp._topBarWidgets).length - 1, `a11y: ${separators} separators between ${Object.keys(rp._topBarWidgets).length} metrics`);
        const alerts = barNodes.find(n => n.name.startsWith('Alerts'));
        check(alerts && !alerts.showing, `a11y: the hidden ⚠ is ${alerts ? 'offered' : 'missing'}`);
        release();

        // The overview: cards named with their values, buttons named.
        rp._indicator.menu.open();
        rp._activeTab = 'overview';
        rp._updateTabVisibility();
        await sleep(rp._intervalUs / 1000 + 800);
        await hold();
        let panel = (await a11yTrees('Resource Pulse panel'))['Resource Pulse panel'];
        let nodes = a11yNodes(panel);
        check(a11yUnnamed(panel).length === 0, `a11y: unnamed on the overview: ${a11yUnnamed(panel).join(', ')}`);
        for (const card of Object.values(rp._summaryCards)) {
            const start = `${card.title} ${spokenValue(card.valueLabel.text)}`;
            // A card for hardware this machine lacks (a battery) is hidden.
            if (!card.box.visible) {
                check(!nodes.some(n => n.showing && n.name.startsWith(`${card.title} `) && n.name.endsWith('details')), `a11y: the hidden ${card.title} card is offered`);
                continue;
            }
            check(nodes.some(n => n.showing && A11Y_BUTTON.test(n.role) && n.name.startsWith(start) && n.name.endsWith(`opens ${card.title} details`)),
                `a11y: no card button '${start} ..., opens ${card.title} details'`);
        }
        for (const name of ['Refresh now', 'Settings'])
            check(nodes.some(n => n.showing && A11Y_BUTTON.test(n.role) && n.name === name), `a11y: no '${name}' button on the overview`);
        check(!nodes.some(n => n.showing && /System Monitor|About Resource Pulse/.test(n.name) && A11Y_BUTTON.test(n.role)), 'a11y: the overview still offers a System Monitor or About button');
        release();

        // The CPU page: range toggles, process rows (Enter opens System
        // Monitor), the ✕ named with the process it ends.
        rp._activeTab = 'cpu';
        rp._updateTabVisibility();
        await sleep(2 * rp._intervalUs / 1000 + 800);
        await hold();
        panel = (await a11yTrees('Resource Pulse panel'))['Resource Pulse panel'];
        nodes = a11yNodes(panel);
        check(a11yUnnamed(panel).length === 0, `a11y: unnamed on the CPU page: ${a11yUnnamed(panel).join(', ')}`);
        const toggles = nodes.filter(n => n.showing && n.role === 'toggle button');
        check(toggles.length === 3 && toggles.filter(n => n.checked).length === 1, `a11y: range toggles ${toggles.map(n => `${n.name}${n.checked ? ' (checked)' : ''}`).join(', ')}`);
        const rows = rp._procWidgets.filter(w => w.item.visible);
        const items = nodes.filter(n => n.showing && n.role === 'list item');
        check(rows.length > 0 && items.length === rows.length, `a11y: ${items.length} process list items offered for ${rows.length} rows`);
        for (const w of rows) {
            check(items.some(n => n.name.startsWith(w.group.comm) && n.name.endsWith('opens System Monitor')), `a11y: no list item for ${w.group.comm} (have ${items.map(n => `'${n.name}'`).join(', ')})`);
            if (w.endBtn.reactive)
                check(nodes.some(n => n.sensitive && A11Y_BUTTON.test(n.role) && n.name.startsWith(`End ${w.group.comm}`)), `a11y: no 'End ${w.group.comm}' button`);
        }
        rp._launchSystemMonitor = view => launched.push(view);
        rows[0].item.grab_key_focus();
        await pressKey(Clutter.KEY_Return);
        check(launched[0] === 'processes' && !rp._indicator.menu.isOpen, `a11y: Enter on a process row launched ${launched[0] ?? 'nothing'} and left the menu ${rp._indicator.menu.isOpen ? 'open' : 'closed'}`);
        rp._launchSystemMonitor = launch;
        release();

        // The Battery page: its line about the top app is a named button.
        rp._indicator.menu.open();
        rp._activeTab = 'battery';
        rp._updateTabVisibility();
        await sleep(rp._intervalUs / 1000 + 800);
        await hold();
        panel = (await a11yTrees('Resource Pulse panel'))['Resource Pulse panel'];
        check(a11yUnnamed(panel).length === 0, `a11y: unnamed on the Battery page: ${a11yUnnamed(panel).join(', ')}`);
        check(a11yNodes(panel).some(n => n.showing && A11Y_BUTTON.test(n.role) && n.name.startsWith(rp._batTopAppLabel.text)),
            `a11y: the top-app line '${rp._batTopAppLabel.text}' is not a named button`);
        console.log(`RP-UITEST a11y: top bar ${barNodes.filter(n => n.sensitive && n.showing).map(n => `'${n.name}'`).join(', ')}`);
    } finally {
        rp._launchSystemMonitor = launch;
        release();
        rp._activeTab = 'overview';
        rp._updateTabVisibility();
        rp._indicator.menu.close();
        await sleep(400);
    }
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
        const click = /^PREFS-CHECK CLICK ([\w-]+) (-?\d+) (-?\d+)/.exec(line);
        const drag = /^PREFS-CHECK DRAG ([\w-]+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(line);
        if (drag) {
            check(titled(), `prefs: no window to drag ${drag[1]} in`);
            await bringForward(titled());
            await dragInWindow(titled(), ...drag.slice(2, 6).map(Number));
        } else if (click) {
            check(titled(), `prefs: no window to click ${click[1]} in`);
            await bringForward(titled());
            await clickInWindow(titled(), Number(click[2]), Number(click[3]));
        } else if (show) {
            await sleep(700);
            check(titled(), `prefs: no window on screen for the ${show[1]} page`);
            await bringForward(titled());
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
    // The first request fails as it does when GNOME's preferences service
    // is quitting (window closed and opened again within a second): the
    // extension must say so and try again, and the window must still open.
    const bus = Gio.DBus.session;
    let requests = 0;
    bus.call = function (...args) {
        if (args[3] === 'OpenExtensionPrefs' && ++requests === 1) {
            const done = args[args.length - 1];
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                done({ call_finish: () => { throw new Error('simulated: the service is quitting'); } }, null);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        return Object.getPrototypeOf(bus).call.apply(bus, args);
    };
    try {
        await clickActor(rp._overviewMenuBtn);
        for (let i = 0; i < 40 && !titled(); i++) await sleep(250);
    } finally {
        delete bus.call;
    }
    // The first request failed, so an open window means the extension sent
    // it again (its warning is in the shell log).
    check(requests === 2, `prefs: ${requests} window requests, expected the failed one and one retry`);
    check(titled(), 'prefs: the menu button did not open the window after a failed first request');
    check(!rp._indicator.menu.isOpen, 'prefs: the menu stayed open over the window');
    for (let i = 0; i < 20 && rp._settings.get_string('prefs-page') !== ''; i++) await sleep(150);
    check(rp._settings.get_string('prefs-page') === '', `prefs: the window did not take the Settings page ('${rp._settings.get_string('prefs-page')}')`);
    await sleep(1500);
    await shot('prefs-window');
    titled().delete(global.get_current_time());
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);

    // The overview ends with the hardware card: no System Monitor or About button.
    const footButtons = rp._overviewPage.get_children().filter(c => c instanceof St.Button);
    check(footButtons.length === 0 && !rp._aboutBtn, `prefs: the overview has ${footButtons.length} buttons at its foot`);

    // The battery page's line opens the window on the Tracking page.
    rp._indicator.menu.open();
    rp._activeTab = 'battery';
    rp._updateTabVisibility();
    await sleep(1500);
    check(rp._batTopAppLabel.text.includes('tracking is off'), `battery line: '${rp._batTopAppLabel.text}' with tracking off`);
    await scrollIntoView(rp, rp._batTopApp);
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

    // As the Extensions app opens it: no page asked for, so the settings
    // only (the tabs themselves are checked in prefs-check.js; this is the
    // real path through the shell, shown for the screenshot).
    check(rp._settings.get_string('prefs-page') === '', 'prefs: a page request was left over');
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);
    Main.extensionManager.openExtensionPrefs(TARGET, '', {});
    for (let i = 0; i < 40 && !titled(); i++) await sleep(250);
    check(titled(), 'prefs: the Extensions app path did not open the window');
    await sleep(1200);
    await shot('prefs-window-extensions-app');
    titled().delete(global.get_current_time());
    for (let i = 0; i < 20 && titled(); i++) await sleep(150);
}

// The GPU page with three kinds of reading, fed through the real poll: a GPU
// that reports everything, one that reports only its load, and none at all.
async function gpuPageFollowsReadings(rp) {
    rp._indicator.menu.open();
    rp._activeTab = 'gpu';
    rp._updateTabVisibility();
    // Exact readings on the page: smoothing (tested in smoothGlide) is off here.
    rp._settings.set_boolean('smooth-transitions', false);
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

    // Several GPUs (a hybrid laptop): the shown one in the card, every one
    // listed, a sleeping one said to be asleep.
    await feed({
        ...full, key: 'card0', gpus: [{ ...full, key: 'card0' }, { key: 'nvidia0', model: 'NVIDIA RTX 3050', percent: 0, asleep: true },
            { key: 'card2', model: 'AMD Radeon 780M', percent: 12 }],
    });
    const listed = rp._gpuListRows?.map(row => `${row.lbl.text}=${row.val.text}`) ?? [];
    check(rp._gpuAllCard.visible && listed.length === 3 && /shown above/.test(listed[0]) && listed[1] === 'NVIDIA RTX 3050=asleep' && listed[2] === 'AMD Radeon 780M=12%',
        `gpu page: the GPUs are listed as ${listed.join(' | ') || 'nothing'}`);
    check(/NVIDIA RTX 3050: asleep/.test(rp._tooltipTexts.gpu ?? ''), `gpu tooltip with several GPUs: '${rp._tooltipTexts.gpu}'`);
    check(cutOffLabels(rp._gpuAllCard).length === 0, `gpu page: cut off in the list of GPUs: ${cutOffLabels(rp._gpuAllCard).join(' | ')}`);
    await shot('gpu-several');
    await feed(full);
    check(!rp._gpuAllCard.visible, 'gpu page: the list of GPUs stays with one GPU');

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
    rp._settings.set_boolean('smooth-transitions', true);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// Two batteries (a laptop with a second, removable one): the page lists
// each under the figures for both together.
async function severalBatteries(rp) {
    rp._indicator.menu.open();
    rp._activeTab = 'battery';
    rp._updateTabVisibility();
    rp._settings.set_boolean('smooth-transitions', false);
    const wait = rp._settings.get_int('poll-interval') * 1000 + 1500;
    const each = [
        { name: 'BAT0', percent: 67, state: 'discharging', health: 90, cycleCount: 300 },
        { name: 'BAT1', percent: 50, state: 'discharging', health: 80, cycleCount: 40 },
    ];
    rp._bat.sample = () => Promise.resolve({
        present: true, percent: 61.5, state: 'discharging', timeRemaining: 18000, timeToEmpty: 18000, timeToFull: 0,
        health: 86.7, cycleCount: 300, energyRate: 8, energy: 40, energyFull: 65, energyFullDesign: 75, batteries: each,
    });
    try {
        await sleep(wait);
        const rows = rp._batListRows?.map(row => `${row.lbl.text}: ${row.val.text}`) ?? [];
        check(rp._batListCard.visible && rows.join(' | ') === 'BAT0: 67% · Discharging · health 90% | BAT1: 50% · Discharging · health 80%',
            `battery page: the batteries are listed as ${rows.join(' | ') || 'nothing'}`);
        check(rp._summaryCards.battery.valueLabel.text === '62%', `battery card: '${rp._summaryCards.battery.valueLabel.text}' for both batteries`);
        check(cutOffLabels(rp._batListCard).length === 0, `battery page: cut off in the list of batteries: ${cutOffLabels(rp._batListCard).join(' | ')}`);
        await scrollIntoView(rp, rp._batListCard);
        await shot('battery-several');
    } finally {
        delete rp._bat.sample;
        rp._settings.set_boolean('smooth-transitions', true);
    }
    await sleep(wait);
    check(rp._batListCard.visible === (rp._lastBat?.batteries?.length > 1), 'battery page: did not follow the real reading again');
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

// The 1 h / 24 h range with real clicks on the detail header, the network
// day totals, and the Disk page's top list with a process writing to disk.
async function historyAndUsage(rp) {
    rp._indicator.menu.open();
    rp._activeTab = 'cpu';
    rp._updateTabVisibility();
    await sleep(800);
    const spark = rp._cpuSparkline;
    const clickRange = async range => {
        await scrollIntoView(rp, rp._rangeButtons[range]);
        await clickActor(rp._rangeButtons[range]);
    };
    await clickRange('hour');
    check(rp._range === 'hour' && spark.history === rp._long.hour.cpu && spark.spanLabel === '1h',
        `range: 1h click gave range ${rp._range}, span '${spark.spanLabel}'`);
    // The run so far has lasted minutes: there are buckets with samples.
    const h = spark.history;
    const filled = Array.from({ length: h.length }, (_, i) => h.get(i)).filter(Number.isFinite).length;
    check(h.length >= 2 && filled >= 2, `range: 1h CPU history has ${h.length} buckets, ${filled} with samples`);
    await shot('range-1h');
    await clickRange('day');
    check(spark.history === rp._long.day.cpu && spark.spanLabel === '24h', `range: 24h shows '${spark.spanLabel}'`);
    await clickRange('live');
    check(spark.history === rp._hist.cpu && spark.spanLabel === rp._spanLabel, `range: back to live shows '${spark.spanLabel}'`);

    rp._activeTab = 'network';
    rp._updateTabVisibility();
    await sleep(2500);
    for (const row of [rp._netToday, rp._netMonth])
        check(/^↓ [\d.]+ \w*B {2}↑ [\d.]+ \w*B$/.test(row.val.text), `net usage: row shows '${row.val.text}'`);

    // A writer on a real disk (not tmpfs, where nothing reaches storage).
    rp._activeTab = 'disk';
    rp._updateTabVisibility();
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), `rp-io-test-${GLib.random_int_range(1000, 9999)}`]);
    GLib.mkdir_with_parents(dir, 0o700);
    GLib.spawn_command_line_sync(`ln -s /bin/sh ${dir}/rpdiskwriter`);
    const writer = Gio.Subprocess.new([`${dir}/rpdiskwriter`, '-c',
        `while :; do dd if=/dev/zero of=${dir}/blob bs=1M count=64 oflag=direct conv=fsync status=none; done`], Gio.SubprocessFlags.NONE);
    try {
        let row = null;
        for (let i = 0; i < 30 && !row; i++) {
            await sleep(400);
            row = (rp._dskProcWidgets ?? []).find(w => w.group?.comm === 'dd' || w.group?.comm === 'rpdiskwriter');
        }
        const listed = (rp._dskProcWidgets ?? []).filter(w => w.item.visible).map(w => `${w.group?.comm} ${w.statLbl.text}`).join(', ');
        if (!row && listed === '')
            console.log('RP-UITEST disk list: no per-process I/O counters readable here; the writer check was not run');
        else {
            check(row && row.group.ioRate > 0, `disk list: the writer is not listed with a rate (${listed})`);
            await scrollIntoView(rp, rp._dskProcList);
            await shot('disk-top');
            console.log(`RP-UITEST disk list: ${listed}; note: '${rp._dskProcNote.visible ? rp._dskProcNote.text : ''}'`);
        }
    } finally {
        writer.force_exit();
        await sleep(300);
        GLib.spawn_command_line_sync(`rm -rf ${dir}`);
        rp._indicator.menu.close();
        await sleep(300);
    }
}

// Values glide to each reading over one polling interval: with polling
// paused, two known readings are shown; memory (not averaged) passes
// through in-between values and lands exactly on the reading, CPU lands on
// the average of the two, and the bars follow.
async function smoothGlide(rp) {
    check(rp._settings.get_boolean('smooth-transitions'), 'glide: smooth changes are off by default');
    rp._indicator.menu.open();
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    await sleep(800);
    // No real reading may land while known ones are shown: the timer, and
    // any one-off poll (the menu opening schedules one), are held.
    GLib.source_remove(rp._timeoutId);
    rp._timeoutId = null;
    const poll = rp._poll;
    rp._poll = () => {};
    try {
        const base = rp._lastData;
        const reading = (mem, cpu) => ({ ...base, mem: { ...base.mem, percent: mem }, cpu: { ...base.cpu, total: cpu } });
        const mem = () => parseInt(rp._summaryCards.memory.valueLabel.text, 10);
        const cpu = () => parseInt(rp._summaryCards.cpu.valueLabel.text, 10);
        rp._smoothPrev = null;
        rp._shownTo = null;
        rp._present(reading(20, 10));
        await sleep(rp._intervalUs / 1000 + 300);
        check(mem() === 20 && cpu() === 10, `glide: first reading shown as ${mem()} / ${cpu()}`);
        // Screen readers are told the reading, not each frame: one new name
        // when the glide arrives (a11y.js).
        const renamed = { bar: [], card: [] };
        const barBox = rp._topBarWidgets.memory.box;
        const cardBox = rp._summaryCards.memory.box;
        const barId = barBox.connect('notify::accessible-name', () => renamed.bar.push(barBox.accessible_name));
        const cardId = cardBox.connect('notify::accessible-name', () => renamed.card.push(cardBox.accessible_name));
        const t0 = GLib.get_monotonic_time();
        rp._present(reading(80, 90));
        const seen = [];
        while (GLib.get_monotonic_time() - t0 < rp._intervalUs - 150000) {
            await sleep(120);
            seen.push(mem());
        }
        await sleep(450);
        barBox.disconnect(barId);
        cardBox.disconnect(cardId);
        check(renamed.bar.join() === 'Memory 80%', `glide: the top-bar memory was renamed ${renamed.bar.length} times (${renamed.bar.join(' | ')}), not once to 'Memory 80%'`);
        check(renamed.card.length === 1 && renamed.card[0].startsWith('Memory 80%,'), `glide: the memory card was renamed ${renamed.card.length} times (${renamed.card.join(' | ')})`);
        const between = new Set(seen.filter(v => v > 20 && v < 80));
        check(between.size >= 5, `glide: memory showed ${[...between].join(', ')} on the way (want ≥ 4 in-between values)`);
        check(seen.every((v, i) => i === 0 || v >= seen[i - 1]), `glide: memory went back on the way (${seen.join(', ')})`);
        check(mem() === 80, `glide: memory ended at ${mem()}, not the reading 80`);
        check(cpu() === 50, `glide: CPU ended at ${cpu()}, not the average 50 of 10 and 90`);
        check(rp._topBarWidgets.memory.label.text === '80%', `glide: top bar memory ends at '${rp._topBarWidgets.memory.label.text}'`);
        check(rp._summaryCards.memory.pbar.pct === 80, `glide: the memory bar ends at ${rp._summaryCards.memory.pbar.pct} %`);
        console.log(`RP-UITEST glide: memory 20 -> ${seen.join(' ')} -> ${mem()} over ${(rp._intervalUs / 1e6).toFixed(0)} s`);

        // Menu closed: no frames at all (the budget is 1 %); the top bar
        // shows the averaged value at once.
        rp._indicator.menu.close();
        await sleep(400);
        rp._present(reading(40, 10));
        check(!rp._glideId, 'glide: frames run with the menu closed');
        check(rp._topBarWidgets.memory.label.text === '40%' && rp._topBarWidgets.cpu.label.text === '30%',
            `glide: closed top bar shows '${rp._topBarWidgets.memory.label.text}' / '${rp._topBarWidgets.cpu.label.text}', not 40% / the average 30%`);

    } finally {
        delete rp._poll;
        if (rp._poll !== poll) rp._poll = poll;
        rp._startPolling();
        rp._indicator.menu.close();
        await sleep(300);
    }
}

// Ending processes from the CPU page with real clicks: the ✕ asks first,
// End stops a process that quits on request, Force quit stops one that
// ignores the request, and Cancel leaves a process alone. The processes run
// under their own names (symlinks to sh) so they are found in the list.
// Process search on the CPU page, with real clicks and keys: an idle process
// with a name of its own (never among the busiest five) is found, Backspace
// edits the text instead of leaving the page, a name with no match says so,
// and Escape (which the shell's menu takes) closes the menu and so ends the
// search: it reopens with the busiest five.
async function processSearch(rp) {
    const dir = GLib.dir_make_tmp('rp-search-XXXXXX');
    GLib.spawn_command_line_sync(`ln -s /bin/sh ${dir}/rpsearchidle`);
    // A loop, not a lone 'sleep 600': bash (Fedora's sh) execs a lone
    // command in place, and the process would be called 'sleep'.
    const idle = Gio.Subprocess.new([`${dir}/rpsearchidle`, '-c', 'while :; do sleep 1; done'], Gio.SubprocessFlags.NONE);
    const type = async text => {
        for (const ch of text) await pressKey(Clutter.unicode_to_keysym(ch.codePointAt(0)), 120);
    };
    const shown = () => (rp._procWidgets ?? []).filter(w => w.item.visible).map(w => w.group?.comm);
    try {
        rp._indicator.menu.open();
        rp._activeTab = 'cpu';
        rp._updateTabVisibility();
        await sleep(2 * rp._intervalUs / 1000 + 800);
        const search = rp._procSearch.cpu;
        check(!shown().includes('rpsearchidle'), `search: the idle process is already among the busiest (${shown().join(', ')})`);
        await scrollIntoView(rp, search.entry);
        await clickActor(search.entry);
        await type('rpsearch');
        for (let i = 0; i < 20 && !shown().includes('rpsearchidle'); i++) await sleep(300);
        check(search.entry.text === 'rpsearch' && shown().length > 0 && shown().every(c => c.includes('rpsearch')) && shown().includes('rpsearchidle'),
            `search: typing 'rpsearch' (field '${search.entry.text}') lists ${shown().join(', ') || 'nothing'}`);
        // A reading taken while the text was shorter is shown dimmed until
        // one for the whole text arrives.
        for (let i = 0; i < 20 && rp._procList.opacity !== 255; i++) await sleep(300);
        check(rp._procList.opacity === 255, `search: the matches stay dimmed (opacity ${rp._procList.opacity})`);
        await shot('cpu-search');

        await pressKey(Clutter.KEY_BackSpace);
        check(rp._activeTab === 'cpu' && search.entry.text === 'rpsearc', `search: Backspace left the field '${search.entry.text}' on the '${rp._activeTab}' page`);
        await type('qq');
        // The line follows the next sample of the full text.
        for (let i = 0; i < 20 && !(search.noMatch.visible && search.noMatch.text.includes(search.entry.text)); i++) await sleep(300);
        check(search.noMatch.visible && /rpsearcqq/.test(search.noMatch.text) && shown().length === 0,
            `search: no match shows '${search.noMatch.visible ? search.noMatch.text : 'nothing'}', rows ${shown().join(', ')}`);

        await pressKey(Clutter.KEY_Escape);
        check(!rp._indicator.menu.isOpen && search.entry.text === '' && !search.noMatch.visible,
            `search: Escape left the menu ${rp._indicator.menu.isOpen ? 'open' : 'closed'} with '${search.entry.text}'`);
        rp._indicator.menu.open();
        rp._activeTab = 'cpu';
        rp._updateTabVisibility();
        for (let i = 0; i < 20 && !(shown().length > 0 && !shown().includes('rpsearchidle')); i++) await sleep(300);
        check(shown().length > 0 && !shown().includes('rpsearchidle'), `search: reopened, the busiest are back (${shown().join(', ')})`);
    } finally {
        idle.force_exit();
        GLib.spawn_command_line_sync(`rm -rf ${dir}`);
        rp._indicator.menu.close();
        await sleep(400);
    }
}

async function endProcesses(rp) {
    const dir = GLib.dir_make_tmp('rp-end-XXXXXX');
    const named = name => {
        GLib.spawn_command_line_sync(`ln -s /bin/sh ${dir}/${name}`);
        return `${dir}/${name}`;
    };
    const spawned = [];
    const spawn = (name, script) => {
        const p = Gio.Subprocess.new([named(name), '-c', script], Gio.SubprocessFlags.NONE);
        spawned.push(p);
        return p;
    };
    const exited = p => new Promise(resolve => {
        if (p.get_if_exited() || p.get_if_signaled()) resolve(true);
        else p.wait_async(null, () => resolve(true));
    });
    const rowFor = async comm => {
        for (let i = 0; i < 30; i++) {
            const w = (rp._procWidgets ?? []).find(x => x.group?.comm === comm);
            if (w) return w;
            await sleep(300);
        }
        throw new Error(`end: ${comm} never appeared in the CPU list (${(rp._procWidgets ?? []).map(x => x.group?.comm).join(', ')})`);
    };
    const until = async (cond, ms) => {
        for (let t = 0; t < ms && !cond(); t += 200) await sleep(200);
        return cond();
    };
    const clickEnd = async w => {
        await scrollIntoView(rp, w.endBtn);
        await clickActor(w.endBtn);
    };
    const bar = () => rp._procEnd;
    const clickBar = async button => {
        await scrollIntoView(rp, button);
        await clickActor(button);
    };
    try {
        rp._indicator.menu.open();
        rp._activeTab = 'cpu';
        rp._updateTabVisibility();

        // 1. Quits on request.
        const polite = spawn('rpendpolite', 'while :; do :; done');
        const politeRow = await rowFor('rpendpolite');
        await clickEnd(politeRow);
        // The press stays on the ✕: the row neither shrinks (which moved the
        // ✕ from under the pointer and lost the click) nor opens anything.
        check(politeRow.item.scale_x === 1, `end: the row reacted to the ✕ press (scale ${politeRow.item.scale_x})`);
        check(rp._indicator.menu.isOpen, 'end: clicking ✕ closed the menu (the row click went through)');
        check(bar().box.visible && /^End rpendpolite\?/.test(bar().label.text), `end: confirmation is '${bar().box.visible ? bar().label.text : 'hidden'}'`);
        await shot('end-confirm');
        await clickBar(bar().confirm);
        check(await until(() => bar().label.text === 'rpendpolite ended.', 9000), `end: after End the bar says '${bar().label.text}'`);
        check(await Promise.race([exited(polite), sleep(1000).then(() => false)]), 'end: rpendpolite is still running');

        // 2. Ignores the request: Force quit is offered and works.
        const stubborn = spawn('rpendstubborn', 'trap "" TERM; while :; do :; done');
        await clickEnd(await rowFor('rpendstubborn'));
        await clickBar(bar().confirm);
        check(await until(() => bar().step === 'force', 9000), `end: no Force quit offered ('${bar().label.text}')`);
        check(/did not quit/.test(bar().label.text) && bar().confirm.label === 'Force quit', `end: force step reads '${bar().label.text}' / '${bar().confirm.label}'`);
        await shot('end-force');
        await clickBar(bar().confirm);
        check(await until(() => bar().label.text === 'rpendstubborn ended.', 5000), `end: after Force quit the bar says '${bar().label.text}'`);
        check(await Promise.race([exited(stubborn), sleep(1000).then(() => false)]), 'end: rpendstubborn is still running');

        // 3. Cancel leaves it running.
        const kept = spawn('rpendkept', 'while :; do :; done');
        await clickEnd(await rowFor('rpendkept'));
        await clickBar(bar().cancel);
        check(!bar().box.visible, 'end: Cancel did not close the confirmation');
        await sleep(1500);
        check(!kept.get_if_exited() && !kept.get_if_signaled(), 'end: Cancel still ended the process');
        console.log('RP-UITEST end: TERM, Force quit and Cancel work with real clicks');
    } finally {
        for (const p of spawned) p.force_exit();
        rp._indicator.menu.close();
        await sleep(300);
        for (const name of ['rpendpolite', 'rpendstubborn', 'rpendkept']) GLib.unlink(`${dir}/${name}`);
        GLib.rmdir(dir);
    }
}

// A real CPU load past the limit: the ⚠ appears in the top bar, the pinned
// CPU value turns red, the ⚠'s tooltip (real hover) names CPU, a notification
// names the cause, clicking its banner opens the CPU page, and all of it
// clears once the load is gone. The 30 s / 10 s timing is unit-tested; here
// it is shortened so the scenario stays quick.
async function alertsRaise(rp) {
    const { AlertMonitor } = await import(`file://${Main.extensionManager.lookup(TARGET).path}/lib/engine/alerts.js`);
    const settings = rp._settings;
    const threshold = settings.get_int('threshold-cpu');
    settings.set_int('threshold-cpu', 50);
    rp._alerts = new AlertMonitor({ sustainUs: 4e6, recoverUs: 4e6 });
    check(!rp._dangerBox.visible, 'alerts: ⚠ shown before any load');
    let collapsedBefore = null;
    const burners = [];
    const n = GLib.get_num_processors();
    try {
        for (let i = 0; i < n; i++)
            burners.push(Gio.Subprocess.new(['sh', '-c', 'while :; do :; done'], Gio.SubprocessFlags.NONE));
        // What the top bar hides with the CPU already at full load, before
        // the ⚠: a value that grows (3% -> 100%) may need room of its own.
        await sleep(2500);
        const fitState = () => {
            const center = Main.panel._centerBox;
            const room = Math.floor(Math.min(center.allocation.x1, Main.panel.allocation.get_width() - center.allocation.x2));
            const wanted = Main.panel._rightBox.get_preferred_width(-1)[1];
            const labels = rp._topBarLabels().map(l => `${Math.round(l.get_preferred_width(-1)[1])}${l.visible ? '' : 'h'}`).join(' ');
            return `room ${room}, wanted ${Math.round(wanted)}, ⚠ ${rp._dangerBox.visible ? Math.round(rp._dangerBox.get_preferred_width(-1)[1]) : 'off'}, labels ${labels}, cpu '${rp._topBarWidgets.cpu.label.text}'`;
        };
        if (!rp._dangerBox.visible) collapsedBefore = rp._topBarCollapsed;
        const fitBefore = fitState();
        for (let i = 0; i < 40 && !rp._dangerBox.visible; i++) await sleep(500);
        check(rp._dangerBox.visible, `alerts: no ⚠ after 20 s of ${n} burners (CPU ${rp._lastCpu?.total?.toFixed(0)} %)`);
        check(rp._topBarWidgets.cpu.label.has_style_class_name('resource-pulse-label-danger'), 'alerts: the pinned CPU value is not red');
        const warned = a11yNodes((await a11yTrees('Resource Pulse'))['Resource Pulse']).find(node => node.name.startsWith('Alerts'));
        check(warned?.showing && warned.sensitive && /^Alerts: CPU \d+ % for /.test(warned.name), `alerts: a screen reader is given the ⚠ as '${warned?.name}'${warned?.showing ? '' : ' (not showing)'}`);
        // The ⚠ is narrower than any value, so making room for it hides at
        // most one. A label showing 'n/a' reserves no room and may be
        // narrower, but hiding it costs no value (it stays in the tooltip),
        // and the next one hidden is wider than the ⚠, so still at most one
        // value goes. The number of hidden values is only logged: under load
        // the CPU value itself grows ("62%" -> "100%", wider than the room
        // reserved for normal values) and may hide one more on a full bar
        // (seen in the compat containers with 1 px to spare).
        await sleep(2500);
        const widths = Object.entries(rp._topBarWidgets).map(([k, w]) => `${k} ${Math.round(w.box.width)}${w.label?.visible ? '' : ' (hidden)'}`).join(', ');
        console.log(`RP-UITEST alerts: hidden values ${collapsedBefore ?? '?'} -> ${rp._topBarCollapsed}; before: ${fitBefore}; after: ${fitState()}; ${widths}`);
        const shortest = Math.min(...rp._topBarLabels().filter(l => l.text !== 'n/a').map(l => l.get_preferred_width(-1)[1]));
        check(rp._dangerBox.width < shortest, `alerts: the ⚠ (${Math.round(rp._dangerBox.width)} px) is wider than a value (${Math.round(shortest)} px)`);
        check(!rp._topBarWidgets.memory.label.has_style_class_name('resource-pulse-label-danger'), 'alerts: memory marked although only CPU is high');
        // The cause needs two process scans a second apart.
        await sleep(2500);
        const source = Main.messageTray.getSources().find(src => src.title === 'Resource Pulse');
        const note = source?.notifications.at(-1);
        check(note?.title === 'CPU usage is high', `alerts: notification is '${note?.title}'`);
        check(/^CPU \d+ % for \d+ min — sh( ×\d+)? using [\d.]+ cores$/.test(note.body ?? ''), `alerts: notification body '${note.body}' does not name the burner`);

        if (!pointer) await clickActor(rp._dangerBox).catch(() => {});
        const [x, y] = rp._dangerBox.get_transformed_position();
        const [w, h] = rp._dangerBox.get_transformed_size();
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2, y + h / 2);
        await sleep(600);
        check(rp._tooltip?.visible && /^CPU \d+ % for \d+ min — sh( ×\d+)? using [\d.]+ cores$/.test(rp._tooltip.text), `alerts: ⚠ tooltip is '${rp._tooltip?.text}'`);
        await shot('alert-topbar');
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), 640, 400);
        await sleep(300);

        // The banner, clicked: the panel opens on the CPU page.
        const banner = Main.messageTray._banner;
        if (banner) {
            await clickActor(banner);
            for (let i = 0; i < 10 && !rp._indicator.menu.isOpen; i++) await sleep(200);
            check(rp._indicator.menu.isOpen && rp._activeTab === 'cpu', `alerts: banner click left the menu ${rp._indicator.menu.isOpen ? `on ${rp._activeTab}` : 'closed'}`);
            rp._indicator.menu.close();
            await sleep(300);
        } else {
            console.log('RP-UITEST alerts: no banner on screen to click (notification went straight to the tray)');
        }
    } finally {
        for (const b of burners) b.force_exit();
    }
    for (let i = 0; i < 40 && rp._dangerBox.visible; i++) await sleep(500);
    check(!rp._dangerBox.visible, 'alerts: ⚠ still shown 20 s after the load ended');
    check(!rp._topBarWidgets.cpu.label.has_style_class_name('resource-pulse-label-danger'), 'alerts: CPU value still red after recovery');
    settings.set_int('threshold-cpu', threshold);
    rp._alerts = new AlertMonitor();
}

// The pseudo-language run (./scripts/dev.sh test-i18n: LANGUAGE=xx, a
// catalogue that wraps every string in ⟦ ⟧): visible text, tooltips and
// accessible names in the top bar and on every page of the panel must read
// ⟦…⟧ except for data (process, sensor, CPU and GPU names...); then the same
// for the preferences window (prefs-check.js coverage).
async function translationCoverage(rp) {
    const { untranslated, dataStrings } = await import('./i18n-coverage.js');
    rp._settings.set_strv('pinned-metrics', ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu']);
    await sleep(3000);
    const found = new Map();
    const look = (text, where) => {
        const data = dataStrings(rp._lastData);
        if (untranslated(text, data) && !found.has(text)) found.set(text, where);
    };
    const scan = (root, where) => eachDescendant(root, actor => {
        if (!actor.mapped) return;
        if (actor instanceof St.Label) look(actor.text, where);
        look(actor.accessible_name, `${where}, accessible name`);
    });
    scan(rp._indicator, 'top bar');
    for (const [key, text] of Object.entries(rp._tooltipTexts)) look(text, `${key} tooltip`);
    look(rp._alertText(), 'alerts');
    check(rp._topBarWidgets.cpu.box.accessible_name.includes('⟦'), `coverage: the pseudo-language is not loaded (CPU named '${rp._topBarWidgets.cpu.box.accessible_name}')`);
    let texts = 0;
    rp._indicator.menu.open();
    for (const tab of TABS) {
        rp._activeTab = tab;
        rp._updateTabVisibility();
        // Process lists need two samples.
        await sleep(['cpu', 'memory', 'disk'].includes(tab) ? 4500 : 2500);
        eachDescendant(rp._indicator.menu.box, actor => {
            if (actor.mapped && actor instanceof St.Label) texts++;
        });
        scan(rp._indicator.menu.box, `${tab} page`);
    }
    rp._indicator.menu.close();
    console.log(`RP-UITEST coverage: ${texts} panel labels read on ${TABS.length} pages`);
    check(found.size === 0, `coverage: untranslated: ${[...found].map(([text, where]) => `${where}: '${text}'`).join('; ')}`);

    // The window, in its own process.
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const proc = Gio.Subprocess.new(['gjs', '-m', `${here}/prefs-check.js`, Main.extensionManager.lookup(TARGET).path, 'coverage'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [, out] = await new Promise((resolve, reject) => proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
            resolve(obj.communicate_utf8_finish(res));
        } catch (e) {
            reject(e);
        }
    }));
    const lines = (out ?? '').split('\n').filter(line => line.startsWith('PREFS-CHECK') && !line.startsWith('PREFS-CHECK INFO'));
    check(proc.get_successful() && lines.some(line => line.startsWith('PREFS-CHECK DONE')), `coverage: ${lines.join(' | ') || `prefs-check exit ${proc.get_exit_status()}`}`);
    console.log(`RP-UITEST coverage: ${lines.join(' | ')}`);
}

async function run() {
    await sleep(1500);
    enabledAt = GLib.get_monotonic_time() - 4000000;
    let ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj, 'target extension not enabled');
    if (GLib.getenv('LANGUAGE') === 'xx') {
        await translationCoverage(ext.stateObj);
        return;
    }

    // A stored list with an unknown key and a duplicate (GSettings accepts
    // both) must not put a broken or repeated metric in the top bar.
    ext.stateObj._settings.set_strv('pinned-metrics', ['cpu', 'bogus', 'cpu', 'memory']);
    await sleep(800);
    check(Object.keys(ext.stateObj._topBarWidgets).join() === 'cpu,memory' && ext.stateObj._indicatorBox.get_n_children() === 4,
        `bogus pinned list built ${Object.keys(ext.stateObj._topBarWidgets)} with ${ext.stateObj._indicatorBox.get_n_children()} children (⚠, cpu, divider, memory expected)`);

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
    // Pressure rows were filled while their pages were visited.
    for (const row of ['_cpuWait', '_memWait', '_dskWait']) {
        const text = ext.stateObj[row]?.val.text;
        check(/^\d+\.\d % of the time$|^n\/a/.test(text ?? ''), `pressure: ${row} shows '${text}'`);
    }
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
    await severalBatteries(ext.stateObj);
    await batteryTracking(ext.stateObj);
    await keyboardOpensCards(ext.stateObj);
    await screenReader(ext.stateObj);
    await stuckCollector(ext.stateObj);
    await alertsRaise(ext.stateObj);
    await endProcesses(ext.stateObj);
    await processSearch(ext.stateObj);
    await historyAndUsage(ext.stateObj);
    await smoothGlide(ext.stateObj);

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

    // Same path the screen lock takes. The session figures (network totals,
    // power average and peak) come through it: a peak no real reading here
    // would reach is planted to recognise them.
    const before = ext.stateObj;
    before._pwrStats.add(123, GLib.get_monotonic_time());
    const kept = { rx: before._net.sessionTotals().rx, peak: before._pwrStats.peak, count: before._pwrStats.count };
    Main.extensionManager.disableExtension(TARGET);
    await sleep(500);
    const t0 = GLib.get_monotonic_time();
    Main.extensionManager.enableExtension(TARGET);
    enabledAt = GLib.get_monotonic_time();
    console.log(`RP-UITEST enable() took ${((enabledAt - t0) / 1000).toFixed(1)} ms`);
    await sleep(1500);
    ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj?._indicator, 'target extension did not re-enable');
    const back = { rx: ext.stateObj._net.sessionTotals().rx, peak: ext.stateObj._pwrStats.peak, count: ext.stateObj._pwrStats.count };
    check(back.peak === 123 && back.count >= kept.count && back.rx >= kept.rx,
        `session figures through disable/enable: ${JSON.stringify(kept)} -> ${JSON.stringify(back)}`);
    // Read without blocking at enable: the boot id gates the day's network count.
    check(typeof ext.stateObj._bootId === 'string' && ext.stateObj._bootId.length > 0 && /\/\d+\/\d+$/.test(ext.stateObj._session ?? ''),
        `boot id '${ext.stateObj._bootId}' and session '${ext.stateObj._session}' after enable`);

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
    // With the menu closed only the top bar is drawn (the panel is filled
    // when it opens), so the top bar shows that it polls.
    check(last?.stateObj?._indicator && /^\d+%$/.test(last.stateObj._topBarWidgets.cpu?.label.text ?? ''),
        `extension did not come back and poll after the final re-enable (top bar '${last?.stateObj?._topBarWidgets.cpu?.label.text}')`);
    last.stateObj._indicator.menu.open();
    await sleep(800);
    check(last.stateObj._summaryCards.cpu.valueLabel.text !== '--%', 'the panel was not filled when it opened');
    last.stateObj._indicator.menu.close();
    await sleep(300);
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
