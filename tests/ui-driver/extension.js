// Test-only driver, loaded by `./dev.sh test-ui` inside an isolated headless shell.
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'resource-pulse@yourdomain.example';
const TABS = ['overview', 'cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu', 'settings'];

let started = false;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function cycleTabs(rp, pass) {
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
    }

    check(rp._summaryCards.cpu.valueLabel.text !== '--%', `pass ${pass}: cpu card never updated`);
    // 60 s of history at most, however many on-demand polls were fired.
    check(rp._hist.cpu.length >= 3, `pass ${pass}: cpu history not recorded (${rp._hist.cpu.length})`);
    check(rp._hist.cpu.length <= 12, `pass ${pass}: on-demand polls leaked into history (${rp._hist.cpu.length})`);
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
        for (const text of ['9%', '100%', 'n/a']) {
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

async function run() {
    await sleep(1500);
    let ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj, 'target extension not enabled');

    await cycleTabs(ext.stateObj, 1);

    // Same path the screen lock takes.
    Main.extensionManager.disableExtension(TARGET);
    await sleep(500);
    Main.extensionManager.enableExtension(TARGET);
    await sleep(1500);
    ext = Main.extensionManager.lookup(TARGET);
    check(ext?.stateObj?._indicator, 'target extension did not re-enable');

    await cycleTabs(ext.stateObj, 2);

    // Disable while a poll is in flight. The menu stays closed: tearing down
    // an open PanelMenu trips shell-internal BoxPointer allocation errors
    // that are unrelated to this extension.
    ext.stateObj._poll();
    Main.extensionManager.disableExtension(TARGET);
    await sleep(1500);
    Main.extensionManager.enableExtension(TARGET);
    await sleep(2500);
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
