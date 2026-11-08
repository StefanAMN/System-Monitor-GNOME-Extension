import GLib from 'gi://GLib';
import System from 'system';

import { DiskSampler, driveIoStats, parseDiskstats } from '../../src/lib/collectors/disk.js';

let passed = 0;
let failed = false;

function check(condition, description) {
    if (!condition) throw new Error(description);
    passed++;
}

const previous = '259 0 nvme0n1 100 0 1000 250 40 0 400 120 0 180 500 4 0 64 10 2 30';
const current = '259 0 nvme0n1 120 0 1200 300 50 0 500 150 0 250 700 8 0 100 22 4 46';
const legacy = line => line.split(' ').slice(0, 14).join(' ');
const parse = line => parseDiskstats(line, true)[0];
const none = value => value.iops === null && value.latencyMs === null && value.queueDepth === null;

async function run() {
    const before = parse(previous);
    const after = parse(current);
    let stats = driveIoStats(after, before, 2000);
    check(stats.name === 'nvme0n1' && stats.iops === 18 && stats.latencyMs === 3 && stats.queueDepth === 0.1,
        'rates include completed reads, writes, discards and flushes and use request milliseconds');
    stats = driveIoStats(parse(legacy(current)), parse(legacy(previous)), 2000);
    check(stats.iops === 15 && Math.abs(stats.latencyMs - 80 / 30) < 1e-9 && stats.queueDepth === 0.1,
        'older counters without discard and flush still support read/write performance');
    stats = driveIoStats(parse(legacy(current).split(' ').slice(0, 13).join(' ')), parse(legacy(previous)), 2000);
    check(stats.queueDepth === null && stats.iops === 15 && stats.latencyMs > 0,
        'missing weighted time leaves request statistics available without implying zero queue depth');
    stats = driveIoStats(after, parse(legacy(previous)), 2000);
    check(stats.iops === null && stats.latencyMs === null && stats.queueDepth === 0.1,
        'request types appearing mid-interval do not count a device lifetime as traffic');
    stats = driveIoStats(parse(current.replace('22 4 46', '22 bad 46')), before, 2000);
    check(stats.iops === null && stats.latencyMs === null && stats.queueDepth === 0.1,
        'invalid optional request counters are unavailable without discarding valid weighted time');
    stats = driveIoStats(parse(current.replace('22 4 46', '22 4 2')), before, 2000);
    check(stats.iops === 18 && stats.latencyMs === null, 'reset timing counter does not corrupt operation rates');
    stats = driveIoStats({ ...after, reads: 5 }, before, 2000);
    check(stats.iops === null && stats.latencyMs === null, 'reset request counter cannot inflate rates or latency');
    stats = driveIoStats({ ...after, weightedIoMs: 1 }, before, 2000);
    check(stats.queueDepth === null && stats.iops === 18, 'a reset weighted counter leaves valid request deltas intact');
    stats = driveIoStats(after, after, 2000);
    check(stats.iops === 0 && stats.latencyMs === null && stats.queueDepth === 0,
        'idle drives have zero IOPS and queue depth without a completed latency');
    stats = driveIoStats({ ...after, weightedIoMs: 950 }, after, 2000);
    check(stats.iops === 0 && stats.latencyMs === null && stats.queueDepth === 0.125,
        'a weighted-time delta can be reported without completed requests');
    check(none(driveIoStats(after, before, 0)) && none(driveIoStats(after, before, -20)) &&
        none(driveIoStats(after, before, Infinity)), 'missing or invalid elapsed interval is unavailable');
    check(none(driveIoStats(after, null, 2000)), 'new drive warms up without counting its lifetime');
    check(none(driveIoStats({ ...after, minor: 7 }, before, 2000)),
        'same name with a changed device number does not reuse the previous baseline');
    check(none(driveIoStats({ ...after, sectorsRead: 10 }, before, 2000)), 'reset lifetime sector counters invalidate the old baseline');
    check(parseDiskstats(current)[0].reads === undefined, 'byte-only caller does not parse optional request counters');

    const fixture = GLib.dir_make_tmp('rp-drive-stats-XXXXXX');
    try {
        GLib.file_set_contents(`${fixture}/mounts`, '');
        GLib.file_set_contents(`${fixture}/diskstats`, previous);
        const sampler = new DiskSampler(fixture);
        check((await sampler.sample(false)).drives === null, 'background sample only keeps the drive baseline');
        const t = sampler._prevTime;
        GLib.file_set_contents(`${fixture}/diskstats`, `${current}\n8 0 sda 8 0 16 1 8 0 16 1 0 4 4\n8 1 sda1 1 0 8 1 1 0 8 1 0 1 1\n`);
        const detailed = await sampler.sample(true);
        const elapsedMs = (sampler._prevTime - t) / 1000;
        check(detailed.drives.length === 2 && detailed.drives[1].name === 'sda' && none(detailed.drives[1]),
            'the next detailed sample adds a newly attached whole drive and skips its partition');
        const nvme = detailed.drives[0];
        check(Math.abs(nvme.iops - 36000 / elapsedMs) < 1e-8 && nvme.latencyMs === 3 &&
            Math.abs(nvme.queueDepth - 200 / elapsedMs) < 1e-8, 'detail uses existing background counters and the actual monotonic interval');
        GLib.file_set_contents(`${fixture}/diskstats`, current);
        const removed = await sampler.sample(true);
        check(removed.drives.length === 1 && removed.drives[0].iops === 0, 'removed drives disappear from the next detailed reading');
    } finally {
        GLib.unlink(`${fixture}/mounts`);
        GLib.unlink(`${fixture}/diskstats`);
        GLib.rmdir(fixture);
    }
    print(`disk drive performance: ${passed} passed`);
}

const loop = new GLib.MainLoop(null, false);
run().catch(error => {
    printerr(`${error.message}\n${error.stack}`);
    failed = true;
}).finally(() => loop.quit());
loop.run();
if (failed) System.exit(1);
