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
        // Overlapping calls on purpose: the poll guard must absorb them.
        rp._poll();
        rp._poll();
        await sleep(1300);
        rp._poll();
        await sleep(400);
        if (tag) await shot(`${tag}-${tab}`);
        // The settings page is longer than the panel: capture all of it.
        if (tag && tab === 'settings') {
            const adj = rp._scrollView.get_vadjustment();
            const pageful = adj.page_size - 40;
            for (let part = 2, y = pageful; y < adj.upper - adj.page_size + pageful && part <= 4; part++, y += pageful) {
                adj.value = Math.min(y, adj.upper - adj.page_size);
                await sleep(300);
                await shot(`${tag}-settings-${part}`);
            }
            adj.value = 0;
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

function eachDescendant(actor, visit) {
    visit(actor);
    actor.get_children().forEach(child => eachDescendant(child, visit));
}

async function openSettings(rp) {
    rp._indicator.menu.open();
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    await sleep(500);
    await clickActor(rp._overviewMenuBtn);
    check(rp._activeTab === 'settings', `settings: the menu button left the tab at '${rp._activeTab}'`);
    await sleep(500);
}

async function scrollTo(rp, actor) {
    ensureActorVisibleInScrollView(rp._scrollView, actor);
    await sleep(500);
}

// What made the old page hard to read, as assertions: every row has the
// same height, every control sits in the same column, nothing is cut off.
function settingsLayout(rp, label) {
    const page = rp._settingsPage;
    const rows = [...Object.values(rp._settingRows), rp._sizeRow, rp._powerRow].filter(row => row.visible);
    check(rows.length >= 10, `${label}: only ${rows.length} setting rows are visible`);

    const heights = new Set(rows.map(row => Math.round(row.height)));
    check(heights.size === 1, `${label}: setting rows are ${[...heights].join(' / ')} px high`);

    const columns = new Set(rows.map(row => {
        const [x] = row.controlBin.get_transformed_position();
        return `${Math.round(x)}+${Math.round(row.controlBin.width)}`;
    }));
    check(columns.size === 1, `${label}: control columns differ (${[...columns].join(', ')})`);

    const isSwitch = control => 'state' in control;
    for (const row of rows) {
        const [binX] = row.controlBin.get_transformed_position();
        const [x] = row.control.get_transformed_position();
        const name = row.titleLabel.text;
        check(Math.round(x + row.control.width) === Math.round(binX + row.controlBin.width),
            `${label}: control of '${name}' does not end at the column's right edge`);
        if (!isSwitch(row.control)) {
            check(Math.round(x) === Math.round(binX), `${label}: control of '${name}' does not fill the column`);
        }
    }
    const controlHeights = new Set(rows.filter(row => !isSwitch(row.control)).map(row => Math.round(row.control.height)));
    check(controlHeights.size === 1, `${label}: controls are ${[...controlHeights].join(' / ')} px high`);

    const tiles = Object.values(rp._pinTiles);
    const tileSizes = new Set(tiles.map(tile => `${Math.round(tile.width)}x${Math.round(tile.height)}`));
    check(tiles.length === 8 && tileSizes.size === 1, `${label}: pin tiles differ in size (${[...tileSizes].join(', ')})`);
    const gap = tiles[1].get_transformed_position()[0] - (tiles[0].get_transformed_position()[0] + tiles[0].width);
    check(Math.round(gap) === 8, `${label}: pin tiles are ${gap}px apart`);

    const cut = [];
    let labels = 0;
    eachDescendant(page, actor => {
        if (!(actor instanceof St.Label) || !actor.is_mapped()) return;
        labels++;
        if (actor.clutter_text.get_layout().is_ellipsized()) cut.push(actor.text);
    });
    check(labels > 40, `${label}: only ${labels} labels found on the settings page, the walk is broken`);
    check(cut.length === 0, `${label}: cut-off text on the settings page: ${cut.join(' | ')}`);

    const [, natural] = page.get_preferred_height(page.width);
    check(natural <= 900, `${label}: the settings page is ${natural}px long`);
    console.log(`RP-UITEST ${label}: rows ${[...heights][0]}px, controls ${[...controlHeights][0]}px, column ${[...columns][0]}, page ${Math.round(natural)}px at ${Math.round(page.width)}px`);
}

// One of each control, clicked with the real pointer, plus a change made
// behind the page's back.
async function settingsControls(rp) {
    const s = rp._settings;
    const ctl = key => rp._settingControls[key];
    s.set_strv('pinned-metrics', ['cpu', 'memory']);
    await openSettings(rp);
    settingsLayout(rp, 'settings layout (default width)');

    await scrollTo(rp, rp._pinTiles.gpu);
    await clickActor(rp._pinTiles.gpu);
    check(s.get_strv('pinned-metrics').join() === 'cpu,memory,gpu', `pin tile: pinned is ${s.get_strv('pinned-metrics')}`);
    check(rp._pinTiles.gpu.badge.text === '3' && rp._pinTiles.gpu.has_style_class_name('active'), 'pin tile: gpu is not marked as third');
    check('gpu' in rp._topBarWidgets, 'pin tile: gpu did not reach the top bar');
    await clickActor(rp._pinTiles.cpu);
    check(s.get_strv('pinned-metrics').join() === 'memory,gpu', `pin tile: after unpinning cpu the list is ${s.get_strv('pinned-metrics')}`);
    check(rp._pinTiles.cpu.pinPosition === 0 && !rp._pinTiles.cpu.has_style_class_name('active') &&
        rp._pinTiles.memory.badge.text === '1' && rp._pinTiles.gpu.badge.text === '2', 'pin tile: positions did not move up');

    const compact = ctl('compact-label');
    await scrollTo(rp, compact);
    // Where the knob sits inside the track: 0 at the left end, 1 at the right.
    const knobAt = () => (compact.knob.get_transformed_position()[0] - compact.get_transformed_position()[0]) /
        (compact.width - compact.knob.width);
    check(knobAt() < 0.25, `switch: knob of a switched-off setting sits at ${knobAt().toFixed(2)}`);
    await clickActor(compact);
    check(s.get_boolean('compact-label') && compact.state, 'switch: click did not turn compact mode on');
    check(knobAt() > 0.75 && compact.has_style_class_name('active'), `switch: knob of a switched-on setting sits at ${knobAt().toFixed(2)}`);
    await clickActor(compact);
    check(!s.get_boolean('compact-label') && !compact.state, 'switch: second click did not turn compact mode off');
    check(knobAt() < 0.25 && !compact.has_style_class_name('active'), `switch: knob did not return (${knobAt().toFixed(2)})`);

    const mem = ctl('unit-mem');
    await scrollTo(rp, mem);
    await clickActor(mem.buttons.get('GiB'));
    check(s.get_string('unit-mem') === 'GiB' && mem.buttons.get('GiB').has_style_class_name('active') &&
        !mem.buttons.get('GB').has_style_class_name('active'), `segments: unit-mem is '${s.get_string('unit-mem')}' after clicking GiB`);
    // Changed from outside (preferences window, gsettings): the page follows.
    s.set_string('unit-mem', 'GB');
    await sleep(300);
    check(mem.value === 'GB' && mem.buttons.get('GB').has_style_class_name('active'), 'segments: the page did not follow an outside change');

    const poll = ctl('poll-interval');
    s.set_int('poll-interval', 2);
    await scrollTo(rp, poll);
    await clickActor(poll.decButton);
    check(s.get_int('poll-interval') === 1 && poll.valueLabel.text === '1 s' && !poll.decButton.reactive,
        `stepper: − left the interval at ${s.get_int('poll-interval')} ('${poll.valueLabel.text}')`);
    await clickActor(poll.incButton);
    check(s.get_int('poll-interval') === 2 && poll.decButton.reactive, `stepper: + left the interval at ${s.get_int('poll-interval')}`);

    // The narrowest panel a user can drag to; then the Reset row, clicked.
    s.set_int('menu-custom-width', 360);
    s.set_int('menu-custom-height', 576);
    rp._updateMenuDimensions();
    await sleep(800);
    settingsLayout(rp, 'settings layout (minimum width)');
    await shot('settings-min-width');
    const reset = rp._sizeRow.control;
    check(rp._sizeRow.asideLabel.text === '360 × 576' && reset.reactive, `size row: shows '${rp._sizeRow.asideLabel.text}' for a custom 360 × 576`);
    await scrollTo(rp, reset);
    await clickActor(reset);
    check(s.get_int('menu-custom-width') === 0 && rp._sizeRow.asideLabel.text === 'automatic' && !reset.reactive,
        `size row: after Reset width is ${s.get_int('menu-custom-width')}, label '${rp._sizeRow.asideLabel.text}'`);

    s.set_strv('pinned-metrics', ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu']);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// The permission row is offered only while the collector reports counters
// it may not read, and its first click only explains.
async function powerRowWhenBlocked(rp) {
    await openSettings(rp);
    const interval = rp._settings.get_int('poll-interval') * 1000;
    check(rp._powerRow.visible === !!rp._lastPwr?.raplBlocked,
        `power row: visible is ${rp._powerRow.visible} while raplBlocked is ${rp._lastPwr?.raplBlocked}`);
    rp._pwr.sample = () => Promise.resolve({ raplSupported: false, raplBlocked: true, packagePower: null, systemPower: null });
    await sleep(interval + 1500);
    check(rp._powerRow.visible && !rp._powerFixNote.visible, 'power row: not offered while the counters are blocked');
    settingsLayout(rp, 'settings layout (with the power row)');
    const enable = rp._powerRow.control;
    await scrollTo(rp, enable);
    await clickActor(enable);
    check(rp._powerFixArmed && enable.label === 'Confirm' && rp._powerFixNote.visible && rp._powerFixNote.text.includes('administrator'),
        `power row: first click did not ask for confirmation (button '${enable.label}')`);
    await scrollTo(rp, rp._powerFixNote);
    const lines = rp._powerFixNote.clutter_text.get_layout().get_line_count();
    check(lines > 1 && !rp._powerFixNote.clutter_text.get_layout().is_ellipsized(), `power row: the warning is on ${lines} line(s)`);
    await shot('settings-power-row');
    // The second click would start pkexec; it is not sent.
    rp._disarmPowerFix();
    check(!rp._powerFixNote.visible && enable.label === 'Enable', 'power row: disarming left the warning up');
    delete rp._pwr.sample;
    await sleep(interval + 1500);
    check(rp._powerRow.visible === !!rp._lastPwr?.raplBlocked, 'power row: did not follow the real reading again');
    console.log(`RP-UITEST power row: energy counters on this machine are ${rp._lastPwr?.raplBlocked ? 'blocked' : rp._lastPwr?.raplSupported ? 'readable' : 'absent'}`);
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// The in-menu steppers move in steps of 5 while preferences move in steps
// of 1: from 98 % the next step must land on the schema maximum, and the
// label must show the stored value, not the rejected one.
async function stepperClamps(rp) {
    rp._settings.set_int('threshold-cpu', 98);
    rp._indicator.menu.open();
    rp._activeTab = 'settings';
    rp._updateTabVisibility();
    await sleep(600);
    const stepper = rp._settingControls['threshold-cpu'];
    check(stepper.valueLabel.text === '98%', `stepper: shows '${stepper.valueLabel.text}' for a stored 98`);
    ensureActorVisibleInScrollView(rp._scrollView, stepper);
    await sleep(600);
    await clickActor(stepper.incButton);
    const stored = rp._settings.get_int('threshold-cpu');
    check(stored === 100, `stepper: + from 98 stored ${stored}, expected 100`);
    check(stepper.valueLabel.text === '100%', `stepper: label shows '${stepper.valueLabel.text}' for a stored 100`);
    // At the maximum the + button is switched off instead of doing nothing.
    check(!stepper.incButton.reactive && stepper.decButton.reactive, 'stepper: + is still active at the maximum');
    await clickActor(stepper.decButton);
    check(rp._settings.get_int('threshold-cpu') === 95 && stepper.incButton.reactive,
        `stepper: − from 100 stored ${rp._settings.get_int('threshold-cpu')}`);
    rp._settings.reset('threshold-cpu');
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
}

// A focused overview card opens its page on Return and on Space, sent as
// real key events through the compositor.
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

// The settings page without a pointer: Tab reaches every control, Space
// flips a switch, Left / Right change a choice or a number.
async function settingsKeyboard(rp) {
    const s = rp._settings;
    const ctl = key => rp._settingControls[key];

    // From the top-bar button the keyboard must get into the panel at all.
    await clickActor(rp._indicator);
    check(rp._indicator.menu.isOpen, 'keyboard: the panel button did not open the menu');
    await pressKey(Clutter.KEY_Down);
    const entered = global.stage.get_key_focus();
    check(entered !== rp._menuSection && rp._menuContainer.contains(entered),
        `keyboard: Down from the panel button focused ${entered?.constructor.name}.${entered?.style_class}, not something in the panel`);
    await pressKey(Clutter.KEY_Tab);
    const next = global.stage.get_key_focus();
    check(next !== entered && rp._menuContainer.contains(next), 'keyboard: Tab did not move on inside the panel');
    await openSettings(rp);

    const focusable = [];
    eachDescendant(rp._settingsPage, actor => {
        if (actor.can_focus && actor.is_mapped()) focusable.push(actor);
    });
    check(focusable.length >= 28, `keyboard: only ${focusable.length} focusable controls on the settings page`);
    focusable[0].grab_key_focus();
    const reached = new Set([focusable[0]]);
    for (let i = 0; i < focusable.length + 4; i++) {
        await pressKey(Clutter.KEY_Tab, 150);
        reached.add(global.stage.get_key_focus());
    }
    const missed = focusable.filter(actor => !reached.has(actor));
    check(missed.length === 0, `keyboard: Tab never reached ${missed.length} of ${focusable.length} controls (${missed.slice(0, 4).map(a => a.style_class).join(', ')})`);

    // The last control is below the fold; focusing it must bring it into view.
    rp._scrollView.get_vadjustment().set_value(0);
    const last = rp._sizeRow.control;
    last.grab_key_focus();
    await sleep(300);
    const viewTop = rp._scrollView.get_transformed_position()[1];
    const lastTop = last.get_transformed_position()[1];
    check(lastTop >= viewTop && lastTop + last.height <= viewTop + rp._scrollView.height,
        `keyboard: the focused control is outside the view (${Math.round(lastTop - viewTop)} of ${Math.round(rp._scrollView.height)})`);
    await shot('settings-focus');

    const tooltips = ctl('show-tooltips');
    s.set_boolean('show-tooltips', true);
    tooltips.grab_key_focus();
    await pressKey(Clutter.KEY_space);
    check(!s.get_boolean('show-tooltips') && !tooltips.state, 'keyboard: Space did not switch tooltips off');
    await pressKey(Clutter.KEY_Return);
    check(s.get_boolean('show-tooltips') && tooltips.state, 'keyboard: Return did not switch tooltips back on');

    const net = ctl('network-top-format');
    s.set_string('network-top-format', 'download');
    net.buttons.get('download').grab_key_focus();
    await pressKey(Clutter.KEY_Right);
    check(s.get_string('network-top-format') === 'upload' && global.stage.get_key_focus() === net.buttons.get('upload'),
        `keyboard: Right on a choice gave '${s.get_string('network-top-format')}'`);
    await pressKey(Clutter.KEY_Right);
    await pressKey(Clutter.KEY_Right);
    check(s.get_string('network-top-format') === 'both', `keyboard: Right past the last choice gave '${s.get_string('network-top-format')}'`);
    await pressKey(Clutter.KEY_Left);
    check(s.get_string('network-top-format') === 'upload', `keyboard: Left on a choice gave '${s.get_string('network-top-format')}'`);

    const mem = ctl('threshold-mem');
    s.set_int('threshold-mem', 90);
    mem.incButton.grab_key_focus();
    await pressKey(Clutter.KEY_Left);
    check(s.get_int('threshold-mem') === 85 && mem.valueLabel.text === '85%', `keyboard: Left on a stepper gave ${s.get_int('threshold-mem')}`);
    await pressKey(Clutter.KEY_Right);
    check(s.get_int('threshold-mem') === 90, `keyboard: Right on a stepper gave ${s.get_int('threshold-mem')}`);
    check(rp._activeTab === 'settings', `keyboard: arrow keys left the settings page for '${rp._activeTab}'`);

    s.reset('network-top-format');
    s.reset('threshold-mem');
    rp._activeTab = 'overview';
    rp._updateTabVisibility();
    rp._indicator.menu.close();
    await sleep(400);
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
    await sleep(600);
    const temp = rp._settingControls['threshold-temp'];
    check(temp.valueLabel.text === '176°F', `threshold: 80 °C shown as '${temp.valueLabel.text}' with °F selected`);
    ensureActorVisibleInScrollView(rp._scrollView, temp.incButton);
    await sleep(600);
    await clickActor(temp.incButton);
    check(rp._settings.get_int('threshold-temp') === 85 && temp.valueLabel.text === '185°F',
        `threshold: after + stored ${rp._settings.get_int('threshold-temp')}, label '${temp.valueLabel.text}'`);
    rp._settings.reset('threshold-temp');
    rp._settings.reset('unit-temp');
    await sleep(200);
    check(temp.valueLabel.text === '80°C', `threshold: back in °C shows '${temp.valueLabel.text}'`);
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
// The preferences window. Its rows are checked by prefs-check.js, a GTK
// client of this shell working on a memory-backed copy of the settings; then
// the real window is opened the way the shell opens it.
async function prefsWindow() {
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
    const proc = launcher.spawnv(['gjs', '-m', `${here}/prefs-check.js`, root, '5000']);
    const output = new Promise((resolve, reject) => proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
            resolve(obj.communicate_utf8_finish(res)[1]);
        } catch (e) {
            reject(e);
        }
    }));
    for (let i = 0; i < 16 && !titled(); i++) await sleep(250);
    await sleep(1200);
    if (titled()) await shot('prefs-rows');
    const text = await output;
    const verdict = text.split('\n').filter(line => line.startsWith('PREFS-CHECK'));
    check(proc.get_successful() && verdict.some(line => line.startsWith('PREFS-CHECK DONE')),
        `prefs: ${verdict.join(' | ') || `no verdict (exit ${proc.get_exit_status()})`}`);
    console.log(`RP-UITEST ${verdict.join(' | ')}`);
    await sleep(500);

    // The real thing: only "a window with the extension's name appears" can
    // be asserted from here; its content is in the screenshot.
    Main.extensionManager.openExtensionPrefs(TARGET, '', {});
    for (let i = 0; i < 40 && !titled(); i++) await sleep(250);
    check(titled(), 'prefs: the shell did not open a preferences window');
    await sleep(1500);
    await shot('prefs-window');
    titled().delete(global.get_current_time());
    await sleep(800);
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

    await settingsControls(ext.stateObj);
    await powerRowWhenBlocked(ext.stateObj);
    await settingsKeyboard(ext.stateObj);
    await prefsWindow();
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
            async e => {
                // What the screen looked like when it went wrong.
                await shot('failure').catch(() => {});
                console.log(`RP-UITEST FAIL: ${e.message}\n${e.stack}`);
            });
    }

    disable() {}
}
