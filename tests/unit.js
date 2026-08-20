// Unit tests for the pure parts of the collectors and the engine.
// Run with: ./dev.sh test-unit   (or: gjs -m tests/unit.js)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import { formatBytes, formatSpeed, formatSpeedCompact, formatTemp, formatUptime, formatDuration, batteryStateLabel } from '../lib/format.js';
import { RingBuffer } from '../lib/ringbuffer.js';
import { RunningStats } from '../lib/stats.js';
import { parseStatBlob, cpuPercent, groupByName, ProcessSampler } from '../lib/process.js';
import { parseCpuLines, calcCpuUsage, parseCpuIdentity } from '../lib/cpu.js';
import { listDirAsync, runSubprocess } from '../lib/utils.js';
import { parseNetDev, counterDelta } from '../lib/network.js';
import { parseDiskstats, parseMounts, ioUtilization } from '../lib/disk.js';
import { sensorLabel, parseMilliCelsius, pickPackageTemp, primarySensor, ThermalSampler } from '../lib/thermal.js';
import { raplWatts } from '../lib/power.js';
import { upowerState, batteryHealth } from '../lib/battery.js';
import { parseNvidiaSmi, parseAmdSclk, intelBusyFromRc6 } from '../lib/gpu.js';
import { powerReadout, thermalUnavailable, batteryIconName, labelTemplate, visibleInterfaces, PeakScale, hoverIndex, agoLabel } from '../lib/present.js';

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

// ── running stats (power session average / peak) ──
{
    const S = 1000000;
    const st = new RunningStats(5);
    eq([st.mean, st.peak, st.count], [0, 0, 0], 'stats: empty');
    st.add(10, 1 * S);
    eq([st.mean, st.peak], [10, 10], 'stats: a single reading is its own mean');
    st.add(30, 3 * S);
    eq(st.mean, 10, 'stats: a reading holds until the next one (10 W for 2 s)');
    st.add(0, 4 * S);
    eq([st.mean.toFixed(3), st.peak], [(50 / 3).toFixed(3), 30], 'stats: time-weighted, not per-sample (10 W x 2 s + 30 W x 1 s)');
    st.add(100, 600 * S);
    eq(st.mean.toFixed(3), (50 / 3).toFixed(3), 'stats: an unsampled gap is not bridged with the stale reading');
    st.add(100, 601 * S);
    eq(st.mean, 150 / 4, 'stats: resumes after the gap');
    st.add(NaN, 602 * S);
    st.add(100, 601 * S);
    eq([st.mean, st.peak, st.count], [150 / 4, 100, 6], 'stats: non-finite readings and a clock going backwards add no time');
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

// ── process grouping ──
{
    const row = (comm, pid, cpu, rss) => ({ comm, pid, cpu, rss, rssBytes: rss * 4096, mem: rss / 100 });
    const g = groupByName([row('firefox', 10, 5, 100), row('bash', 11, 1, 10), row('firefox', 12, 7.5, 300), row('firefox', 13, 0, 50)]);
    eq(g.map(x => [x.comm, x.count, x.cpu, x.rss, x.rssBytes]), [['firefox', 3, 12.5, 450, 450 * 4096], ['bash', 1, 1, 10, 10 * 4096]], 'group: sums cpu and memory per name, keeps first-seen order');
    eq(g[0].pid, 10, 'group: keeps a representative pid');
    eq(groupByName([]), [], 'group: empty');
}

// ── collectors: network ──
{
    const netdev = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000 10 0 0 0 0 0 0 9000 10 0 0 0 0 0 0
enp0s31f6: 123456 100 1 2 0 0 0 5 654321 90 3 4 0 0 0 0
wlp43s0:18446744073709551000 7 0 0 0 0 0 0 42 1 0 0 0 0 0 0
docker0: 1 2 3
`;
    const rows = parseNetDev(netdev);
    eq(rows.map(r => r.iface), ['enp0s31f6', 'wlp43s0'], 'netdev: header and loopback skipped, truncated line dropped, no space after colon handled');
    eq([rows[0].rxBytes, rows[0].rxErrors, rows[0].rxDrops, rows[0].txBytes, rows[0].txErrors, rows[0].txDrops],
        [123456, 1, 2, 654321, 3, 4], 'netdev: field positions');
    eq(parseNetDev(''), [], 'netdev: empty file');
    eq(counterDelta(1500, 1000), 500, 'net counter: normal delta');
    eq(counterDelta(200, 4294967000), 0, 'net counter: reset / 32-bit wrap reads 0, not negative or huge');
    eq(counterDelta(7, 7), 0, 'net counter: idle');
}

// ── collectors: disk ──
{
    const diskstats = [
        '   7       0 loop0 100 0 2000 10 0 0 0 0 0 5 10 0 0 0 0 0 0',
        ' 259       0 nvme0n1 5000 10 400000 900 8000 20 900000 1500 0 2000 2400 0 0 0 0 0 0',
        ' 259       1 nvme0n1p1 4000 10 300000 800 7000 20 800000 1400 0 1900 2200 0 0 0 0 0 0',
        '   8       0 sda 10 0 80 1 2 0 16 1 0 3 2 0 0 0 0 0 0',
        ' 252       0 dm-0 1 0 8 0 1 0 8 0 0 1 1 0 0 0 0 0 0',
        '   8      16 sdab 1 0 8 0 1 0 8 0 0 1 1 0 0 0 0 0 0',
        ' 179       0 mmcblk0 1 0 8 0 1 0 8 0 0 7 1 0 0 0 0 0 0',
        ' 179       1 mmcblk0p1 1 0 8 0 1 0 8 0 0 7 1 0 0 0 0 0 0'
    ].join('\n');
    const disks = parseDiskstats(diskstats);
    eq(disks.map(d => d.name), ['nvme0n1', 'sda', 'sdab', 'mmcblk0'], 'diskstats: whole disks only (no partitions, loop, dm)');
    eq([disks[0].sectorsRead, disks[0].sectorsWritten, disks[0].ioTicks], [400000, 900000, 2000], 'diskstats: sectors read/written and io_ticks fields');
    eq(ioUtilization(1500, 1000, 1000), 50, 'disk util: 500 ms busy in 1 s');
    eq(ioUtilization(5000, 1000, 1000), 100, 'disk util: clamped to 100 (multi-queue overlap)');
    eq(ioUtilization(10, 1000, 1000), 0, 'disk util: counter reset');
    eq(ioUtilization(10, 0, 0), 0, 'disk util: no elapsed time');

    const mounts = parseMounts([
        '/dev/nvme0n1p2 / ext4 rw 0 0',
        '/dev/nvme0n1p3 /home ext4 rw 0 0',
        'tmpfs /run tmpfs rw 0 0',
        '/dev/sdb1 /media/me/USB\\040Stick vfat rw 0 0',
        '/dev/sdb1 /mnt/again vfat rw 0 0',
        '/dev/sdc1 /srv/data ext4 rw 0 0',
        '/dev/loop3 /snap/core/1 squashfs ro 0 0'
    ].join('\n'));
    eq(mounts, [{ device: '/dev/nvme0n1p3', mount: '/home' }, { device: '/dev/sdb1', mount: '/media/me/USB Stick' }],
        'mounts: user-facing real filesystems, one per device, \\040 decoded to a space');
}

// ── collectors: thermal ──
{
    eq(sensorLabel('coretemp', 'Package id 0'), { label: 'CPU Package', isPackage: true }, 'thermal: Intel package');
    eq(sensorLabel('k10temp', 'Tctl'), { label: 'CPU Package (Tctl)', isPackage: true }, 'thermal: AMD Tctl');
    eq(sensorLabel('k10temp', 'Tccd1'), { label: 'CPU Tccd1', isPackage: false }, 'thermal: AMD CCD');
    eq(sensorLabel('coretemp', 'Core 3'), { label: 'Core 3', isPackage: false }, 'thermal: core');
    eq(sensorLabel('acpitz', ''), { label: 'Motherboard', isPackage: false }, 'thermal: ACPI zone');
    eq(sensorLabel('nvme', 'Composite'), { label: 'NVMe Composite', isPackage: false }, 'thermal: NVMe');
    eq(sensorLabel('amdgpu', ''), { label: 'amdgpu', isPackage: false }, 'thermal: unlabeled input falls back to chip name');
    eq([parseMilliCelsius('47000\n'), parseMilliCelsius('0'), parseMilliCelsius('-273000'), parseMilliCelsius('200000'), parseMilliCelsius('garbage')],
        [47, null, null, null, null], 'thermal: millidegrees, implausible values rejected');
    eq(pickPackageTemp([{ label: 'Core 0', temp: 50 }, { label: 'CPU Package', temp: 55, isPackage: true }]), 55, 'thermal: package preferred');
    eq(pickPackageTemp([{ label: 'NVMe', temp: 40 }, { label: 'Core 1', temp: 52 }]), 52, 'thermal: then first core');
    eq(pickPackageTemp([{ label: 'acpitz', temp: 40 }, { label: 'NVMe', temp: 61 }]), 61, 'thermal: then hottest');
    eq(pickPackageTemp([]), 0, 'thermal: no sensor');
    eq(primarySensor([{ label: 'Core 0' }, { label: 'CPU Package', isPackage: true }]).label, 'CPU Package', 'thermal: primary sensor is the package');
    eq(primarySensor([{ label: 'NVMe' }, { label: 'Core 1' }]).label, 'Core 1', 'thermal: else the first core');
    eq(primarySensor([{ label: 'Motherboard' }, { label: 'NVMe' }]), null, 'thermal: no primary sensor without package or core');
}

// ── collectors: power (RAPL) ──
{
    eq(raplWatts(1e6, 16e6, 2 ** 32, 1), 15, 'rapl: 15 J in 1 s = 15 W');
    const range = 262143328850;
    eq(Math.round(raplWatts(range - 5e6, 5e6, range, 1)), 10, 'rapl: counter wrap at max_energy_range_uj');
    eq(raplWatts(0, 5e9, 2 ** 32, 1), null, 'rapl: > 1000 W is rejected as implausible');
    eq(raplWatts(1e6, 2e6, 2 ** 32, 0), null, 'rapl: zero elapsed time');
}

// ── collectors: battery ──
{
    eq([0, 1, 2, 3, 4, 5, 6, 7, -1].map(upowerState),
        ['unknown', 'charging', 'discharging', 'empty', 'full', 'not charging', 'not charging', 'unknown', 'unknown'],
        'upower: every documented State value');
    eq(batteryHealth(45.3, 52).toFixed(2), '87.12', 'battery: health from Wh capacities');
    eq(batteryHealth(55, 52), 100, 'battery: above design clamps to 100');
    eq(batteryHealth(0, 0, 93), 93, 'battery: no design capacity falls back');
}

// ── collectors: GPU (NVIDIA / AMD paths cannot run on this machine) ──
{
    const nv = parseNvidiaSmi('NVIDIA GeForce RTX 3060, 550.54.14, 37, 12, 61, 2048, 12288, 45.20, 1530, 2100, 30\n');
    eq([nv.model, nv.driver, nv.percent, nv.memPercent, nv.temp, nv.memUsed, nv.memTotal, nv.powerDraw, nv.clock, nv.maxClock, nv.fanSpeed],
        ['NVIDIA GeForce RTX 3060', 'NVIDIA 550.54.14', 37, 12, 61, 2048 * 1048576, 12288 * 1048576, 45.2, 1530, 2100, 30], 'nvidia-smi: all fields');
    const laptop = parseNvidiaSmi('NVIDIA RTX A500 Laptop GPU, 535.1, 0, 0, 45, 5, 4096, [N/A], 210, 1695, [Not Supported]');
    eq([laptop.powerDraw, laptop.fanSpeed, laptop.clock], [null, null, 210], 'nvidia-smi: [N/A] and [Not Supported] become null');
    eq(parseNvidiaSmi(''), null, 'nvidia-smi: no output');
    eq(parseNvidiaSmi('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.'), null, 'nvidia-smi: driver error text');
    eq(parseAmdSclk('0: 500Mhz\n1: 1200Mhz *\n2: 2400Mhz\n'), 1200, 'amdgpu: active sclk level');
    eq(parseAmdSclk('0: 500Mhz\n'), null, 'amdgpu: no active level');
    eq(intelBusyFromRc6(1000, 1250, 1000), 75, 'intel rc6: 25% asleep = 75% busy');
    eq(intelBusyFromRc6(1000, 2000, 1000), 0, 'intel rc6: fully asleep');
    eq(intelBusyFromRc6(1000, 900, 1000), null, 'intel rc6: counter reset');
    eq(intelBusyFromRc6(1000, 1050, 50), null, 'intel rc6: interval too short');
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

{
    eq(batteryIconName(4, 'discharging'), 'battery-level-0-symbolic', 'battery icon: nearly empty');
    eq(batteryIconName(47, 'discharging'), 'battery-level-50-symbolic', 'battery icon: rounds to nearest step');
    eq(batteryIconName(90, 'charging'), 'battery-level-90-charging-symbolic', 'battery icon: charging');
    eq(batteryIconName(100, 'full'), 'battery-level-100-charged-symbolic', 'battery icon: full');
    eq(batteryIconName(80, 'not charging'), 'battery-level-80-symbolic', 'battery icon: plugged but held at 80%');
    eq(batteryIconName(NaN, 'unknown'), 'battery-missing-symbolic', 'battery icon: absent');
    eq(batteryIconName(130, 'discharging'), 'battery-level-100-symbolic', 'battery icon: clamps');

    const fits = (key, opts, samples) => samples.every(t => t.length <= labelTemplate(key, opts).length);
    ok(fits('cpu', {}, ['0%', '9%', '99%', 'n/a', '--']), 'template: cpu covers normal values');
    ok(labelTemplate('cpu').length < '100%'.length, 'template: no room reserved for the rare 100%');
    ok(fits('power', {}, ['0.0W', '6.7W', 'n/a']), 'template: power');
    ok(fits('thermal', { tempUnit: 'C' }, [formatTemp(99, 'C'), 'n/a']), 'template: thermal C');
    eq(labelTemplate('battery', { batFmt: 'percent-time' }), '100%', 'template: no room reserved for a battery time estimate that may be absent');

    eq([0, 500, 1024, 9.94 * 1024, 9.96 * 1024, 999.4 * 1024, 999.6 * 1024, 5 * 1024 ** 2, 2.5 * 1024 ** 3, NaN, -4].map(formatSpeedCompact),
        ['0.0 KB/s', '0.5 KB/s', '1.0 KB/s', '9.9 KB/s', '10 KB/s', '999 KB/s', '1.0 MB/s', '5.0 MB/s', '2.5 GB/s', '0.0 KB/s', '0.0 KB/s'],
        'compact speed: never more than three digits');
    const speeds = [0, 1, 999, 1024, 20000, 1023 * 1024, 1024 ** 2, 7e8, 3e9, 9e11];
    ok(speeds.every(v => `↓ ${formatSpeedCompact(v)}`.length <= labelTemplate('network', { netFmt: 'download' }).length), 'template: network single covers every rate');
    ok(speeds.every(v => `↓${formatSpeedCompact(v)} ↑${formatSpeedCompact(v)}`.length <= labelTemplate('network', { netFmt: 'both' }).length), 'template: network both');
}

{
    const S = 1000000;
    const scale = new PeakScale(15, 60);
    eq(scale.update(5, 1 * S), 15, 'peak: never below the floor');
    eq(scale.update(45, 2 * S), 45, 'peak: rises at once');
    eq(scale.update(5, 62 * S), 30, 'peak: halves its excess over the floor per half-life');
    ok(scale.update(5, 3600 * S) < 15.001, 'peak: settles on the floor');
    eq(scale.update(0, 3600 * S), scale.update(0, 3599 * S), 'peak: clock going backwards does not grow it');
    eq(new PeakScale(15).percent(0, S), 0, 'peak: zero reading is 0%, no division by zero');
    eq(new PeakScale(15).percent(30, S), 100, 'peak: new peak is full scale');

    const shown = visibleInterfaces({
        eno1: { isVirtual: false, rxRate: 0, txRate: 0 },
        wwan0: { isVirtual: false, rxRate: 0, txRate: 0 },
        usb0: { isVirtual: false, rxRate: 0, txRate: 0 },
        wlp43s0: { isVirtual: false, rxRate: 5000, txRate: 10 },
        docker0: { isVirtual: true, rxRate: 0, txRate: 0 },
        tailscale0: { isVirtual: true, rxRate: 900, txRate: 0 }
    }).map(([name]) => name);
    eq(shown, ['eno1', 'wwan0', 'usb0', 'wlp43s0', 'tailscale0'], 'interfaces: every physical one, virtual only when active');
    eq(visibleInterfaces(undefined), [], 'interfaces: none');
}

{
    // 60-slot graph, 590 px wide starting at x=30: 10 px per sample, newest at x=620.
    eq(hoverIndex(620, 30, 590, 60, 60), 59, 'hover: right edge is the newest sample');
    eq(hoverIndex(30, 30, 590, 60, 60), 0, 'hover: left edge is the oldest when full');
    eq(hoverIndex(604, 30, 590, 60, 60), 57, 'hover: snaps to the nearest sample');
    eq(hoverIndex(620, 30, 590, 60, 5), 4, 'hover: partly filled history is right-aligned');
    eq(hoverIndex(300, 30, 590, 60, 5), -1, 'hover: no sample that far back yet');
    eq(hoverIndex(700, 30, 590, 60, 60), -1, 'hover: right of the graph');
    eq(hoverIndex(100, 30, 590, 60, 0), -1, 'hover: empty history');
    eq(hoverIndex(100, 30, 0, 60, 10), -1, 'hover: zero-width graph');
    eq([agoLabel(0, 2), agoLabel(7, 2), agoLabel(30, 2), agoLabel(40, 2)], ['now', '14s ago', '1m ago', '1m 20s ago'], 'hover: age label');
}

// ── live: process churn, bounded state, no fd leak ──
const loop = new GLib.MainLoop(null, false);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(), GLib.SOURCE_REMOVE)));
(async () => {
    const fds = async () => (await listDirAsync('/proc/self/fd')).length;

    // A helper that hangs (nvidia-smi with the card off the bus) is killed.
    {
        const t0 = GLib.get_monotonic_time();
        const hung = await runSubprocess(['sleep', '30'], { timeoutMs: 200 });
        const ms = (GLib.get_monotonic_time() - t0) / 1000;
        ok(!hung.success && ms < 3000, `subprocess: hung child killed by the timeout (${ms.toFixed(0)} ms, success=${hung.success})`);
        const handle = {};
        const pending = runSubprocess(['sleep', '30'], { handle });
        await sleep(50);
        ok(typeof handle.cancel === 'function', 'subprocess: handle can cancel a running child');
        handle.cancel();
        const cancelled = await pending;
        ok(!cancelled.success && handle.cancel === null, 'subprocess: cancelled child reports failure and clears the handle');
        const quick = await runSubprocess(['echo', 'hi'], { timeoutMs: 5000 });
        eq([quick.success, quick.stdout.trim()], [true, 'hi'], 'subprocess: a child that finishes in time is untouched');
    }
    // Top bar (fast) and Thermal tab (detailed) must report the same figure,
    // also on machines with neither a package nor a core sensor.
    {
        const dir = GLib.dir_make_tmp('rp-thermal-XXXXXX');
        const write = (name, text) => {
            GLib.file_set_contents(`${dir}/${name}`, text);
            return `${dir}/${name}`;
        };
        const thm = new ThermalSampler();
        thm._lastDiscovery = GLib.get_monotonic_time();
        thm._discoveredFans = [];
        thm._discoveredSensors = [
            { path: write('board', '40000\n'), label: 'Motherboard', isPackage: false },
            { path: write('nvme', '61000\n'), label: 'NVMe Composite', isPackage: false }
        ];
        const fast = await thm.sample(false);
        const full = await thm.sample(true);
        eq([fast.packageTemp, full.packageTemp], [61, 61], 'thermal: top bar and tab agree without a package sensor (hottest)');
        thm._discoveredSensors.push({ path: write('pkg', '52000\n'), label: 'CPU Package', isPackage: true });
        const fastPkg = await thm.sample(false);
        eq([fastPkg.packageTemp, fastPkg.detailed, (await thm.sample(true)).packageTemp], [52, false, 52],
            'thermal: with a package sensor the top bar reads only that one');
        for (const name of ['board', 'nvme', 'pkg']) GLib.unlink(`${dir}/${name}`);
        GLib.rmdir(dir);
    }

    const sampler = new ProcessSampler();
    await sampler.sample(16e9);
    // Back-to-back samples (ms apart) must not turn one clock tick into a spike.
    let spike = 0;
    for (let i = 0; i < 20; i++) {
        const r = await sampler.sample(16e9);
        for (const p of r.top) spike = Math.max(spike, p.cpu / p.count);
    }
    ok(spike <= GLib.get_num_processors() * 100 && spike <= 150, `rapid samples: no per-process rate spike (max ${spike.toFixed(1)}% per process)`);
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
        ok(r.top.length <= 5 && r.top.every(p => p.count >= 1), `churn round ${round}: grouped rows`);
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
