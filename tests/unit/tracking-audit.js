#!/usr/bin/env gjs -m
// Regression fixtures for independent history, damaged ledgers and teardown.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { BatteryLedger, LedgerFormatError, loadLedger } from '../../src/lib/engine/batteryledger.js';
import { BatteryTracker } from '../../src/lib/engine/batterytracker.js';

let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const wait = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function reading(step, total = null) {
    return {
        mono: 1e9 + step * 30e6, wall: 1700000000000 + step * 30000,
        usage: { total, system: null, units: [{ unit: 'a.scope', id: 'a', usec: step * 1e6, memory: 256 * 2 ** 20 }] },
        packageW: 10, battery: { present: true, onBattery: true, energyWh: 40 - step * 0.1 },
        machine: { memUsed: 2 ** 30, memTotal: 8 * 2 ** 30, swapUsed: 0, swapTotal: 2 ** 30,
            swapInBytes: step * 2 ** 20, swapOutBytes: 0, pressure: { cpu: step * 1e6, memory: 0, memoryFull: 0, io: 0 },
            disks: [{ name: 'sda', readBytes: step * 500, writtenBytes: step * 100 }] },
        net: [{ iface: 'eth0', rxBytes: step * 1000, txBytes: step * 20 }],
        appIo: new Map([['a.scope', { read: step * 100, write: step * 10 }]]),
        hot: true, idle: true, temp: 50,
    };
}

async function main() {
    const ledger = new BatteryLedger();
    ledger.ingest(reading(0));
    check(ledger.ingest(reading(1)), 'missing CPU counters still record a valid interval');
    const sum = ledger.summarize();
    check(sum.seconds === 30 && near(sum.batteryWh, 0.1) && near(sum.packageWh, 1 / 12), 'battery and package energy survive absent CPU counters');
    check(sum.cpu === 0 && sum.attributedWh === 0 && sum.apps.every(a => a.wh === 0), 'unavailable CPU counters never invent energy attribution');
    check(sum.memSeconds === 30 && sum.memUsedMiBs === 1024 * 30 && sum.apps[0].memMiBs === 256 * 30, 'machine and application memory survive absent CPU counters');
    check(sum.rxBytes === 1000 && sum.txBytes === 20 && sum.idleRxBytes === 1000, 'network accounting survives absent CPU counters');
    check(sum.diskReadBytes === 500 && sum.apps[0].diskRead === 100 && sum.swapInMiB === 1 && sum.stall.cpu === 1, 'disk, swap and pressure counters survive absent CPU counters');
    check(sum.tempSeconds === 30 && sum.tempAvg === 50 && sum.hotSeconds === 30 && sum.idleSeconds === 30, 'temperature and away time survive absent CPU counters');
    check(ledger.fine[0].s === 30 && ledger.fine[0].rx === 1000, 'fine history records independent metrics too');
    ledger.ingest(reading(2, 100e6));
    check(ledger.summarize().cpu === 0, 'CPU recovery primes its own baseline');
    ledger.ingest(reading(3, 102e6));
    check(ledger.summarize().cpu === 2e6 && ledger.summarize().apps.some(a => a.cpu === 1e6), 'CPU tracking resumes after two valid readings');
    const gap = reading(4, 103e6);
    gap.mono += 300e6;
    gap.wall += 300000;
    ledger.ingest(gap);
    check(ledger.summarize().seconds === 90 && near(ledger.summarize().gapWh, 0.1), 'gaps remain excluded from active history');

    const encode = bucket => JSON.stringify({ version: 2, buckets: [{ t: 1700000000000, a: {}, ...bucket }] });
    for (const bad of [{ a: null }, { a: [] }, { a: { a: null } }, { a: { a: [1, 2] } }, { a: { a: [1, 2, '3'] } },
        { a: { a: [1, -1, 0] } }, { s: '30' }, { s: null }, { cpu: -1 }, { b: 1 }, { energy: 'true' }]) {
        let rejected = false;
        try { BatteryLedger.fromJSON(encode(bad)); } catch (e) { rejected = e instanceof LedgerFormatError; }
        check(rejected, `malformed ledger rejected: ${JSON.stringify(bad)}`);
    }
    const old = BatteryLedger.fromJSON(JSON.stringify({ version: 1, buckets: [{ t: 0, a: { a: [1, 0, 0] } }] }));
    check(old.summarize().seconds === 0 && old.summarize().apps[0].cpu === 1, 'sparse legacy buckets normalize missing numeric fields');
    const back = BatteryLedger.fromJSON(JSON.stringify(ledger));
    check(JSON.stringify(back.summarize()) === JSON.stringify(ledger.summarize()), 'valid current history round-trips');
    const fine = BatteryLedger.fromJSON(JSON.stringify({ version: 2, buckets: [], fine: [{ t: 0, rx: 'bad' }, { t: 1, rx: 5 }] }));
    check(fine.fine.length === 1 && fine.fine[0].rx === 5 && fine.fine[0].s === 0, 'invalid optional fine buckets are dropped and valid sparse ones normalized');

    const dir = GLib.dir_make_tmp('rp-tracking-audit-XXXXXX');
    const path = `${dir}/ledger.json`;
    GLib.file_set_contents(path, encode({ a: null }));
    const loaded = await loadLedger(path);
    const files = [];
    const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    try {
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) files.push(info.get_name());
    } finally { enumerator.close(null); }
    check(loaded.problem?.includes('damaged') && loaded.ledger.buckets.length === 0 && files.some(f => f.startsWith('ledger.json.damaged-')), 'malformed maps use damaged-file preservation and fresh-history recovery');
    for (const name of files) GLib.unlink(`${dir}/${name}`);
    GLib.rmdir(dir);

    const events = [];
    let finishPower;
    const tracker = new BatteryTracker({
        usage: { sample: async () => ({ total: 1, system: 0, units: [] }), cancel: () => events.push('usage cancelled') },
        power: { sample: () => new Promise(resolve => { finishPower = resolve; }) },
        battery: { sample: async () => ({ present: false }) }, machine: null, network: null,
        gpu: { sample: async () => { events.push('gpu started'); return new Map(); }, cancel: () => events.push('gpu cancelled') },
        appIo: { sample: async () => { events.push('io started'); return new Map(); }, cancel: () => events.push('io cancelled') },
        focus: { current: () => null, disconnect: () => {} },
    });
    tracker.ledger = new BatteryLedger();
    tracker.save = async () => {};
    const pending = tracker.tick();
    await tracker.stop();
    finishPower({ raplSupported: false });
    check(await pending === false && !events.some(e => e.endsWith('started')), 'stopping a pending first-stage read never starts downstream collectors');

    let finishGpu;
    events.length = 0;
    const parallel = new BatteryTracker({
        usage: { sample: async () => ({ total: 1, system: 0, units: [] }), cancel: () => {} },
        power: { sample: async () => ({ raplSupported: false }) },
        battery: { sample: async () => ({ present: false }) }, machine: null, network: null,
        gpu: { sample: () => new Promise(resolve => { finishGpu = resolve; events.push('gpu started'); }), cancel: () => finishGpu?.(new Map()) },
        appIo: { sample: async () => { events.push('io started'); return new Map(); }, cancel: () => events.push('io cancelled') },
        focus: { current: () => null, disconnect: () => {} },
    });
    parallel.ledger = new BatteryLedger();
    parallel.save = async () => {};
    const sampling = parallel.tick();
    await wait();
    check(events.includes('gpu started') && events.includes('io started'), 'GPU and disk collectors run concurrently after membership is known');
    await parallel.stop();
    check(await sampling === false && parallel.ledger._prevMono === 0 && events.includes('io cancelled'), 'stopping parallel downstream reads cancels them and prevents ingestion');
    print(`tracking audit: ${passed} passed`);
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
main().catch(e => { failed = true; printerr(`${e.message}\n${e.stack}`); }).finally(() => loop.quit());
loop.run();
if (failed) System.exit(1);
