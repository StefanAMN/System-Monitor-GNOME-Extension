import GLib from 'gi://GLib';
import System from 'system';
import { CollectorSamples, freshSample, recordLiveSample } from '../../src/lib/engine/samples.js';
import { BucketSeries } from '../../src/lib/engine/longhistory.js';
import { RunningStats } from '../../src/lib/engine/stats.js';
import { RingBuffer } from '../../src/lib/engine/ringbuffer.js';
import { AlertMonitor, alertReadings } from '../../src/lib/engine/alerts.js';
import { DisplayAverage } from '../../src/lib/engine/smoothing.js';
import { sampleNote } from '../../src/lib/common/present.js';

let passed = 0;
let failed = false;
function check(ok, message) {
    if (!ok) throw new Error(message);
    passed++;
}
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const loop = new GLib.MainLoop(null, false);
(async () => {
    let now = 1e6;
    let calls = 0;
    const outstanding = {};
    const errors = [];
    const cache = new CollectorSamples(() => now, outstanding, (key, error) => errors.push([key, error]));
    const never = new Promise(() => {});
    const first = { total: 95 };
    let result = await cache.read('cpu', never, () => { calls++; return Promise.resolve(first); }, null);
    check(result.fresh && result.sampledAt === now && result.value === first, 'successful measurement has timestamp and freshness');
    check(cache.held('cpu', null).status === 'cached' && !cache.held('cpu', null).fresh, 'holding a reading never creates a new measurement');
    const read = deferred();
    const deadline = deferred();
    const pending = cache.read('cpu', deadline.promise, () => { calls++; return read.promise; }, first);
    deadline.resolve();
    result = await pending;
    check(result.status === 'stale' && !result.fresh && result.value === first && result.sampledAt === 1e6, 'timeout preserves old value and age');
    await cache.read('cpu', never, () => { calls++; return first; }, first);
    check(calls === 2 && !!outstanding.cpu, 'a stuck collector is started only once');
    now = 5e6;
    const second = { total: 20 };
    read.resolve(second);
    await Promise.resolve();
    result = await cache.read('cpu', never, () => { calls++; return first; }, first);
    check(result.fresh && result.value === second && result.sampledAt === 5e6 && calls === 2, 'late measurement delivered once without another read');
    check(!cache.held('cpu').fresh, 'late result is not recorded twice');
    result = await cache.read('cpu', never, () => Promise.reject(new Error('denied')), second);
    check(result.status === 'stale' && result.value === second && errors.length === 2, 'rejections retain stale value and report failure');
    result = await cache.read('cpu', never, () => { throw new Error('sync'); }, second);
    check(result.status === 'stale', 'synchronous failures are contained');

    for (let i = 0; i < 100; i++) await cache.read('cpu', never, () => first, first);
    check(cache._waiters.size === 0 && cache._entries.size === 1, 'completed polls retain no cancellation waiters');

    const rows = deferred();
    const processDeadline = deferred();
    const oldRequest = cache.read('processes', processDeadline.promise, () => rows.promise, null, 'cpu:foo');
    processDeadline.resolve(); await oldRequest;
    result = await cache.read('processes', never, () => null, null, 'memory:bar');
    check(result.value === null && !result.fresh, 'a pending process request cannot supply rows for another filter');
    rows.resolve({ top: ['old CPU rows'] }); await Promise.resolve();
    const expected = { top: ['new memory rows'] };
    result = await cache.read('processes', never, () => Promise.resolve(expected), null, 'memory:bar');
    check(result.value === expected, 'ready late rows with another sort are discarded');

    const stopped = new CollectorSamples(() => now);
    const late = deferred();
    const stoppedDeadline = deferred();
    const stoppedRead = stopped.read('gpu', stoppedDeadline.promise, () => late.promise, null);
    stopped.close();
    const cancelledResult = await stoppedRead;
    check(!cancelledResult.fresh, 'teardown resolves poll waiters even when the collector remains hung');
    late.resolve({ percent: 99 });
    await Promise.resolve();
    check(Object.keys(stopped.outstanding).length === 0 && stopped.held('gpu', null).sampledAt === null, 'teardown cannot be repopulated by late completion');

    const fresh = { fresh: true, status: 'fresh', sampledAt: 1e6 };
    const cached = { fresh: false, status: 'cached', sampledAt: 1e6 };
    const stale = { fresh: false, status: 'stale', sampledAt: 1e6 };
    const limits = { cpu: 90 };
    const data = sample => ({ cpu: first, samples: { cpu: sample } });
    const monitor = new AlertMonitor({ sustainUs: 30e6 });
    monitor.update(alertReadings(data(fresh), limits, () => true), 1e6);
    monitor.update(alertReadings(data(cached), limits, () => true), 40e6);
    check(!monitor.isActive('cpu'), 'cached high value cannot raise an alert');
    monitor.update(alertReadings(data(stale), limits, () => true), 41e6);
    monitor.update(alertReadings(data({ ...fresh, sampledAt: 42e6 }), limits, () => true), 42e6);
    check(!monitor.isActive('cpu'), 'timeout breaks the sustained high interval');
    monitor.update(alertReadings(data({ ...fresh, sampledAt: 73e6 }), limits, () => true), 73e6);
    check(monitor.isActive('cpu'), 'fresh sustained high readings still raise an alert');
    monitor.update(alertReadings(data(stale), limits, () => true), 74e6);
    check(!monitor.isActive('cpu'), 'unreadable metric clears its alert');
    check(!freshSample(data(cached), 'cpu') && freshSample(data(fresh), 'cpu'), 'history gating distinguishes measurements from held values');
    const ring = new RingBuffer(3);
    ring.push(80); ring.pushGap(); ring.push(20);
    check(Number.isNaN(ring.get(1)) && ring.max() === 80, 'missing live measurement is a graph gap rather than zero');
    const delayedHistory = new RingBuffer(5);
    recordLiveSample(delayedHistory, 10, 1e6, 1e6, 1e6);
    recordLiveSample(delayedHistory, NaN, 1e6, 2e6, 1e6);
    recordLiveSample(delayedHistory, 30, 2e6, 3e6, 1e6);
    check(delayedHistory.get(1) === 30 && Number.isNaN(delayedHistory.get(2)), 'late results fill their past missing tick rather than inventing a current reading');
    check(!delayedHistory.fillGap(0, 99) && delayedHistory.get(0) === 10, 'late results never overwrite an existing measurement');
    const skipped = new RingBuffer(5);
    recordLiveSample(skipped, 43, 2e6, 2e6, 2e6);
    recordLiveSample(skipped, 56, 8e6, 8e6, 2e6, 2);
    check(skipped.length === 4 && skipped.get(0) === 43 && Number.isNaN(skipped.get(1)) &&
        Number.isNaN(skipped.get(2)) && skipped.get(3) === 56, 'missed ticks add gaps without clearing live history');
    recordLiveSample(skipped, 57, 1e9, 1e9, 2e6, 999);
    check(skipped.length === 5 && Number.isNaN(skipped.get(0)) && skipped.get(4) === 57,
        'large gaps expire the old values within the fixed retention');
    const buckets = new BucketSeries(60e6, 4);
    buckets.add(10, 60e6); buckets.advance(120e6); buckets.add(99, 61e6);
    check(Number.isNaN(buckets.get(buckets.length - 1)) && buckets.get(0) === 10, 'late measurements cannot contaminate a later time bucket');

    check(sampleNote(data(stale), 'cpu', 6e6).includes('5 s') && sampleNote(data(fresh), 'cpu', 1e6) === '', 'stale explanation preserves the last measured age');

    check(sampleNote(data(fresh), 'cpu', 6e6).includes('5 s'), 'late-ready measurements show their age even when newly consumed');

    const stats = new RunningStats();
    stats.add(10, 1e6); stats.add(20, 3e6); stats.breakInterval();
    stats.add(100, 7e6); stats.add(0, 9e6);
    check(stats.mean === 55, 'power session mean excludes time with missing measurements');

    const avg = new DisplayAverage();
    avg.add({ cpu: { total: 0 }, samples: { cpu: fresh } }, 1e6);
    const initial = avg.add({ cpu: { total: 90 }, samples: { cpu: fresh } }, 3e6);
    const held = avg.add({ cpu: { total: 0 }, samples: { cpu: stale } }, 5e6);
    check(initial.cpu.total === 90 && held.cpu.total === 90, 'a stale fallback adds no weight to display averaging');
    const empty = new DisplayAverage().add({ cpu: { total: 0 }, samples: { cpu: stale } }, 1e6);
    check(Number.isFinite(empty.cpu.total), 'first unavailable display remains finite');
    print(`sampling audit: ${passed} passed`);
})().catch(error => {
    printerr(`${error.message}\n${error.stack}`);
    failed = true;
}).finally(() => loop.quit());
loop.run();
if (failed) System.exit(1);
