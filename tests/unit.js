// Unit tests for the pure parts of the collectors and the engine.
// Run with: ./dev.sh test-unit   (or: gjs -m tests/unit.js)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import { formatBytes, formatSpeed, formatTemp, formatUptime, formatDuration, batteryStateLabel } from '../lib/format.js';
import { RingBuffer } from '../lib/ringbuffer.js';
import { parseStatBlob, cpuPercent, ProcessSampler } from '../lib/process.js';
import { parseCpuLines, calcCpuUsage, parseCpuIdentity } from '../lib/cpu.js';
import { listDirAsync } from '../lib/utils.js';
import { powerReadout, thermalUnavailable, batteryIconName, labelTemplate, visibleInterfaces, PeakScale } from '../lib/present.js';

let failed = 0;
let passed = 0;
function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        printerr(`FAIL ${label}: expected ${e}, got ${a}`);
    }
}
function ok(cond, label) {
    eq(!!cond, true, label);
}

// ── formatters ──
eq(formatBytes(0), '0 B', 'bytes zero');
eq(formatBytes(NaN), '0 B', 'bytes NaN');
eq(formatBytes(-5), '0 B', 'bytes negative');
eq(formatBytes(0.5), '0 B', 'bytes fractional (used to index units[-1])');
eq(formatBytes(1536, true), '1.5 KiB', 'bytes IEC');
eq(formatBytes(1e21), '1000000.0 PB', 'bytes beyond unit table stays in last unit');
eq(formatSpeed(0.2), '0 B/s', 'speed fractional');
eq(formatSpeed(5 * 1024 ** 5), '5242880.0 GB/s', 'speed beyond unit table');
eq(formatSpeed(1024 * 1024), '1.0 MB/s', 'speed MB');
eq(formatTemp(100, 'F'), '212°F', 'temp F');
eq(formatUptime(90061), '1d 1h', 'uptime');
eq(formatDuration(3660), '1h 1m', 'duration');
eq(batteryStateLabel('not charging'), 'Not Charging', 'battery pending state is not "Full"');
eq(batteryStateLabel('bogus'), 'Unknown', 'battery unknown state');

// ── ring buffer ──
{
    const rb = new RingBuffer(4);
    eq(rb.length, 0, 'ring empty');
    for (let i = 1; i <= 10; i++) rb.push(i);
    eq(rb.length, 4, 'ring length capped');
    eq([rb.get(0), rb.get(1), rb.get(2), rb.get(3)], [7, 8, 9, 10], 'ring keeps newest, oldest first');
    eq(rb.max(), 10, 'ring max');
    eq(rb._buf.length, 4, 'ring never reallocates');
    rb.push(NaN);
    eq(rb.get(3), 0, 'ring stores non-finite as 0');
    rb.clear();
    eq([rb.length, rb.max()], [0, 0], 'ring clear');
}

// ── /proc/stat ──
{
    const lines = parseCpuLines('cpu  10 0 10 80 0 0 0 0 0 0\ncpu0 5 0 5 40 0 0 0 0 0 0\ncpu2 5 0 5 40 0 0 0 0 0 0\nintr 123\ncpufreq 1\n');
    eq(lines.map(l => l.id), [-1, 0, 2], 'cpu lines: aggregate + online cores, offline cpu1 absent');
    eq(calcCpuUsage([10, 0, 10, 80, 0, 0, 0, 0], 0, 0).percent, 0, 'first cpu sample is 0, not lifetime average');
    eq(calcCpuUsage([60, 0, 10, 130, 0, 0, 0, 0], 100, 20).percent, 50, 'cpu delta');
    eq(calcCpuUsage([10, 0, 10, 80, 0, 0, 0, 0], 100, 20).percent, 0, 'identical reading yields 0');
    eq(calcCpuUsage([5, 0, 5, 40, 0, 0, 0, 0], 100, 20).percent, 0, 'counter going backwards yields 0, not negative');
}

// ── CPU identity ──
{
    const id = (name, vendor = 'GenuineIntel') =>
        parseCpuIdentity(`vendor_id\t: ${vendor}\nmodel name\t: ${name}\ncpu cores\t: 10\nsiblings\t: 12\n`);
    eq([id('12th Gen Intel(R) Core(TM) i5-1235U').gen, id('12th Gen Intel(R) Core(TM) i5-1235U').model], ['12th Gen', 'i5-1235U'], 'explicit generation');
    eq(id('Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz').gen, '8th Gen', '4-digit model is single-digit generation (was "85th")');
    eq(id('Intel(R) Core(TM) i7-10510U CPU @ 1.80GHz').gen, '10th Gen', '5-digit model');
    eq(id('Intel(R) Core(TM) i5-1135G7 @ 2.40GHz').gen, '11th Gen', '11th gen G-series');
    eq(id('Intel(R) Core(TM) i7-3770 CPU @ 3.40GHz').gen, '3rd Gen', 'ordinal suffix');
    const amd = id('AMD Ryzen 7 5800X 8-Core Processor', 'AuthenticAMD');
    eq([amd.vendor, amd.tier, amd.gen], ['amd', '7', ''], 'ryzen tier from name, not from any digit in the string');
    const none = parseCpuIdentity('processor\t: 0\nBogoMIPS\t: 50\n');
    eq([none.model, none.vendor, none.cores, none.threads], ['Unknown CPU', 'other', 0, 0], 'no invented core counts');
}

// ── /proc/[pid]/stat ──
{
    const tail = (ut, st, start, rss) =>
        `S 1 1 1 0 -1 4194560 100 0 0 0 ${ut} ${st} 0 0 20 0 1 0 ${start} 1000000 ${rss} 18446744073709551615 0 0 0`;
    const blob = [
        `1 (systemd) ${tail(10, 5, 100, 3000)}`,
        `4194304 (big pid) ${tail(1, 1, 200, 10)}`,
        `77 (a) b) (c) ${tail(2, 2, 300, 20)}`,
        `88 (naïve-日本語) ${tail(3, 3, 400, 30)}`,
        `99 (new\nline) ${tail(4, 4, 500, 40)}`,
        '123 (truncated) S 1 1',
        ''
    ].join('\n');
    const rows = parseStatBlob(blob);
    eq(rows.map(r => r.pid), [1, 4194304, 77, 88, 99], 'stat: pids incl. > 65535; truncated record dropped');
    eq(rows.map(r => r.comm), ['systemd', 'big pid', 'a) b) (c', 'naïve-日本語', 'new\nline'], 'stat: comm with spaces, parens, non-ASCII, newline');
    eq([rows[0].ticks, rows[0].start, rows[0].rss], [15, 100, 3000], 'stat: utime+stime, starttime, rss fields');
    eq(parseStatBlob(''), [], 'stat: empty input (every process vanished)');

    eq(cpuPercent({ start: 100, ticks: 100 }, { start: 100, ticks: 150 }, 0.5, 100), 100, 'proc cpu: 50 ticks in 0.5 s at 100 Hz = one core');
    eq(cpuPercent({ start: 100, ticks: 100 }, { start: 100, ticks: 500 }, 1, 100), 400, 'proc cpu: multi-threaded process may exceed 100');
    eq(cpuPercent(undefined, { start: 100, ticks: 150 }, 1, 100), 0, 'proc cpu: first sight');
    eq(cpuPercent({ start: 100, ticks: 900 }, { start: 999, ticks: 5 }, 1, 100), 0, 'proc cpu: reused PID');
    eq(cpuPercent({ start: 100, ticks: 100 }, { start: 100, ticks: 150 }, 0, 100), 0, 'proc cpu: zero dt never divides');
    eq(cpuPercent({ start: 100, ticks: 150 }, { start: 100, ticks: 100 }, 1, 100), 0, 'proc cpu: backwards counter');
}

// ── presentation helpers ──
{
    eq(powerReadout({ raplSupported: false, packagePower: null, systemPower: null }).value, null, 'power: nothing readable is n/a, not 0 W');
    ok(powerReadout({ raplSupported: false, packagePower: null, systemPower: null }).reason.length > 0, 'power: n/a carries a reason');
    eq(powerReadout({ raplSupported: true, packagePower: 0, systemPower: null }).value, 0, 'power: a real 0 W reading stays 0');
    eq(powerReadout({ raplSupported: true, packagePower: 9, systemPower: 14.5 }).value, 14.5, 'power: system draw preferred on battery');
    eq(thermalUnavailable({ packageTemp: 0, sensors: [], fans: [] }), true, 'thermal: no sensors is unavailable');
    eq(thermalUnavailable({ packageTemp: 51, sensors: [{}], fans: [] }), false, 'thermal: reading present');
}

// ── live: process churn, bounded state, no fd leak ──
const loop = new GLib.MainLoop(null, false);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(), GLib.SOURCE_REMOVE)));
(async () => {
    const fds = async () => (await listDirAsync('/proc/self/fd')).length;
    const sampler = new ProcessSampler();
    await sampler.sample(16e9);
    const fdBefore = await fds();
    let maxMap = 0;
    let maxCpu = 0;
    let minCount = Infinity;
    for (let round = 0; round < 10; round++) {
        // 40 children per round that die while /proc is being walked.
        for (let i = 0; i < 40; i++)
            Gio.Subprocess.new(['/bin/true'], Gio.SubprocessFlags.NONE);
        const r = await sampler.sample(16e9, round % 2 === 1);
        maxMap = Math.max(maxMap, sampler._prev.size);
        minCount = Math.min(minCount, r.count);
        for (const p of r.top) {
            maxCpu = Math.max(maxCpu, p.cpu);
            if (!(p.cpu >= 0) || !(p.mem >= 0)) ok(false, `churn: bad value for ${p.comm}: ${p.cpu}/${p.mem}`);
        }
        eq(sampler._prev.size, r.count, `churn round ${round}: previous-sample map holds only live processes`);
        await sleep(60);
    }
    await sleep(300);
    const final = await sampler.sample(16e9);
    System.gc();
    ok(minCount > 10, 'churn: samples returned processes');
    ok(sampler._prev.size === final.count, 'churn: map pruned after children exited');
    ok(maxMap < final.count + 450, `churn: map bounded (${maxMap})`);
    const ncpu = GLib.get_num_processors();
    ok(maxCpu <= ncpu * 100 * 1.5, `churn: no absurd CPU value (${maxCpu.toFixed(1)}%)`);
    const fdAfter = await fds();
    ok(fdAfter <= fdBefore + 2, `churn: fds flat (${fdBefore} -> ${fdAfter})`);
    print(`churn: ${final.count} procs, peak map ${maxMap}, peak cpu ${maxCpu.toFixed(1)}%, fds ${fdBefore} -> ${fdAfter}`);
})().catch(e => {
    failed++;
    printerr(`FAIL live test threw: ${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();

print(`${passed} passed, ${failed} failed`);
System.exit(failed > 0 ? 1 : 0);
