#!/usr/bin/env gjs -m
// Delivery delays must not change rate weighting or threshold durations.
import { DisplayAverage, interpolateReading } from '../../src/lib/engine/smoothing.js';
import { AlertMonitor, alertReadings } from '../../src/lib/engine/alerts.js';

let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
function data(value, sampledAt) {
    return {
        cpu: { total: value, cores: [value] },
        gpu: { present: true, key: 'card0', percent: value, powerDraw: value,
            gpus: [{ key: 'card0', percent: value, powerDraw: value }] },
        pwr: { packagePower: value, systemPower: value },
        dsk: { readRate: value, writeRate: value, diskPercent: value },
        net: { total: { rxRate: value, txRate: value }, interfaces: { eth0: { rxRate: value, txRate: value } } },
        samples: Object.fromEntries(['cpu', 'gpu', 'pwr', 'dsk', 'net'].map(key =>
            [key, { fresh: true, status: 'fresh', sampledAt: sampledAt * 1e6 }])),
    };
}
const averages = new DisplayAverage();
averages.add(data(0, 1), 1e6);
averages.add(data(100, 3), 3e6);
const delayed = averages.add(data(0, 4), 9e6);
for (const [label, value] of [
    ['CPU', delayed.cpu.total], ['core', delayed.cpu.cores[0]],
    ['GPU', delayed.gpu.percent], ['GPU power', delayed.gpu.powerDraw],
    ['GPU card', delayed.gpu.gpus[0].percent], ['GPU card power', delayed.gpu.gpus[0].powerDraw],
    ['package', delayed.pwr.packagePower], ['system', delayed.pwr.systemPower],
    ['disk read', delayed.dsk.readRate], ['disk write', delayed.dsk.writeRate], ['disk busy', delayed.dsk.diskPercent],
    ['network receive', delayed.net.total.rxRate], ['network send', delayed.net.total.txRate],
    ['interface receive', delayed.net.interfaces.eth0.rxRate], ['interface send', delayed.net.interfaces.eth0.txRate],
]) check(near(value, 200 / 3), `${label}: late rate uses measured interval, not delivery interval`);
const later = averages.add({ ...data(0, 4), samples: Object.fromEntries(['cpu', 'gpu', 'pwr', 'dsk', 'net'].map(key =>
    [key, { fresh: false, status: 'cached', sampledAt: 4e6 }])) }, 12e6);
check(near(later.cpu.total, 50), 'window expiry uses presentation time while sample coverage uses measurement time');
const legacy = new DisplayAverage();
legacy.add({ cpu: { total: 0 } }, 1e6);
check(legacy.add({ cpu: { total: 100 } }, 3e6).cpu.total === 100, 'legacy snapshots without metadata retain delivery timestamps');
const glideTarget = data(100, 20);
check(interpolateReading(data(0, 1), glideTarget, 0.5).samples === glideTarget.samples, 'sample metadata stays opaque during interpolation');

const monitor = new AlertMonitor();
const feed = (value, at, delivered) => monitor.update(alertReadings(data(value, at), { cpu: 90 }, () => true), delivered * 1e6);
feed(95, 1, 1);
feed(95, 20, 40);
check(!monitor.isActive('cpu'), 'late high value cannot manufacture thirty sustained seconds');
feed(95, 31, 50);
check(monitor.isActive('cpu') && monitor.active()[0].since === 1e6, 'sustain starts at measurement time');
feed(20, 32, 70);
feed(20, 33, 80);
check(monitor.isActive('cpu'), 'delivery delay cannot manufacture recovery time');
feed(20, 34, 81);
check(!monitor.isActive('cpu'), 'recovery completes after enough measured time');
const separate = new AlertMonitor();
const metrics = data(95, 1);
metrics.samples.gpu.sampledAt = 10e6;
separate.update(alertReadings(metrics, { cpu: 90, gpu: 90 }, () => true), 11e6);
const next = data(95, 31);
next.samples.gpu.sampledAt = 30e6;
separate.update(alertReadings(next, { cpu: 90, gpu: 90 }, () => true), 40e6);
check(separate.isActive('cpu') && !separate.isActive('gpu'), 'each metric evaluates its own sample clock');
const old = new AlertMonitor();
old.update({ cpu: { value: 95, threshold: 90 } }, 1e6);
old.update({ cpu: { value: 95, threshold: 90 } }, 31e6);
check(old.isActive('cpu'), 'legacy alerts without timestamps use the supplied clock');
print(`sample time audit: ${passed} passed`);
