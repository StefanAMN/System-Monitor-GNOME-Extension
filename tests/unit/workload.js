import { BatteryLedger, FINE_MS } from '../../src/lib/engine/batteryledger.js';
import { compareWorkloads, workloadStarts } from '../../src/lib/engine/workload.js';

let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}
const fine = Math.floor(Date.now() / FINE_MS) * FINE_MS - 4 * FINE_MS;
const opts = { before: fine, after: fine + 2 * FINE_MS, minutes: 5, now: fine + 4 * FINE_MS };
const left = { t: opts.before, b: true, s: 300, cs: 300, cc: 60e6, ms: 300, mu: 1024 * 300, ds: 300, dr: 3000, dw: 0, bs: 300, bc: 1 };
const right = { ...left, t: opts.after, cc: 120e6, mu: 2048 * 300, ds: 150, dr: 1500, dw: 0, bc: 0.5 };
const fixture = { fine: [left, right, { ...right, t: opts.after + FINE_MS, cc: 1e9 }], buckets: [{ ...left, cc: 1e9 }] };
const compared = compareWorkloads(fixture, opts);
check(compared.seconds === 300 && compared.metrics.cpu.before.value === 12 && compared.metrics.cpu.after.value === 24 && compared.metrics.cpu.percent === 100,
    'CPU is seconds per minute, using only fine buckets and the half-open range');
check(compared.metrics.memory.before.value === 2 ** 30 && compared.metrics.memory.after.value === 2 ** 31 && compared.metrics.memory.percent === 100,
    'memory compares the time-weighted mean');
check(compared.metrics.read.before.value === 600 && compared.metrics.read.after.value === 600 && compared.metrics.read.change === null,
    'a half-covered disk interval keeps its measured rate and withholds change');
check(compared.metrics.battery.before.value === 12 && compared.metrics.battery.after.value === 6 && compared.metrics.battery.percent === -50,
    'battery rate uses measured discharge time and reports change');
check(workloadStarts(fixture, 5, opts.after).join() === `${opts.before}`, 'a range only appears after its end');
check(compareWorkloads(fixture, { ...opts, after: fine }) === null && compareWorkloads(fixture, { ...opts, before: fine + 1 }) === null &&
    compareWorkloads(fixture, { ...opts, now: opts.after + 1 }) === null, 'overlap, partial bucket and unfinished range are rejected');

const hour = new Date(new Date(fine).setMinutes(0, 0, 0)).getTime() - 7200000;
const old = BatteryLedger.fromJSON(JSON.stringify({ version: 2, buckets: [0, 1].map(i => ({
    t: hour + i * 3600000, b: true, s: 3600, a: {}, cpu: 900e6, bw: 1,
    ms: 3600, mu: 1024 * 3600, ds: 3600, dr: i * 3600, dw: 0,
})) }));
const legacy = compareWorkloads(old, { before: hour, after: hour + 3600000, minutes: 60, now: hour + 7200000 });
check(legacy.metrics.cpu.before.value === null && legacy.metrics.battery.change === null,
    'legacy aggregate time does not invent CPU or battery coverage');
check(legacy.metrics.memory.change === 0 && legacy.metrics.write.before.value === 0 && legacy.metrics.write.change === 0 &&
    legacy.metrics.read.change === 60 && legacy.metrics.read.percent === null, 'older memory and disk data works, including zero and a change from zero');
const shifted = hour + 1800000;
const traveled = { buckets: [{ ...old.buckets[0], t: shifted }, { ...old.buckets[1], t: shifted + 3600000 },
    { ...old.buckets[1], t: shifted + 5400000, dr: 1e9 }] };
const travelComparison = compareWorkloads(traveled, { before: shifted, after: shifted + 3600000, minutes: 60, now: shifted + 7200000 });
check(travelComparison.metrics.read.after.value === 60 && travelComparison.metrics.read.after.seconds === 3600,
    'recorded hourly starts survive a timezone offset change and ignore partial buckets');

// An old bucket reopened by the current build retains its old totals while
// the measured numerator and denominator begin together.
const wall = hour + 60000;
const ledger = BatteryLedger.fromJSON(JSON.stringify({ version: 2,
    buckets: [{ t: hour, b: true, s: 150, cpu: 50e6, bw: 1, a: {} }],
    fine: [{ t: hour, b: true, s: 150, cpu: 50e6, bw: 1 }],
}));
function ingest(i, total, energyWh, onBattery = true) {
    ledger.ingest({ mono: 1e9 + i * 30e6, wall: wall + i * 30000, usage: { total, system: null, units: [] },
        battery: { present: true, onBattery, energyWh } });
}
ingest(0, 100e6, 10);
ingest(1, 101e6, 9.9);
ingest(2, null, null);
ingest(3, 100, 9.7);
ingest(4, 99, 10);
const back = BatteryLedger.fromJSON(JSON.stringify(ledger));
for (const b of [back.buckets[0], back.fine[0]]) {
    check(b.cs === 30 && b.cc === 1e6 && b.cpu === 51e6,
        'CPU coverage excludes missing counters, rebaseline and counter reset');
    check(b.bs === 30 && Math.abs(b.bc - 0.1) < 1e-9 && b.bw > 1,
        'battery coverage excludes missing readings and increasing energy');
}
ingest(5, 100, 10, false);
ingest(6, 101, 9.8);
check(ledger.buckets[0].bs === 30, 'a transition from AC does not count as a full discharging interval');
ingest(7, 101, 9.8);
check(ledger.buckets[0].bs === 60 && ledger.buckets[0].cs > 30, 'measured zero drain and CPU work still add coverage');
ingest(8, 102, 0);
check(ledger.buckets[0].bs === 60, 'a zero battery-energy fallback is unavailable for comparison');
print(`workload comparison: ${passed} passed`);
