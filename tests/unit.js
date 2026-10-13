// Unit tests for the pure parts of the collectors and the engine.
// Run with: ./dev.sh test-unit   (or: gjs -m tests/unit.js)
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import { formatBytes, formatSpeed, formatSpeedCompact, formatTemp, formatUptime, formatDuration, batteryStateLabel } from '../lib/format.js';
import { RingBuffer } from '../lib/ringbuffer.js';
import { RunningStats } from '../lib/stats.js';
import { METRICS, SETTINGS_SECTIONS, allSettingRows, formatSettingValue, stepSettingValue, pinPositions, togglePinned } from '../lib/settingsmodel.js';
import { parseStatBlob, cpuPercent, groupByName, ProcessSampler } from '../lib/process.js';
import { parseCpuLines, calcCpuUsage, parseCpuIdentity } from '../lib/cpu.js';
import { listDirAsync, runSubprocess, readFileAsync, noteReadError } from '../lib/utils.js';
import { parseNetDev, counterDelta } from '../lib/network.js';
import { parseDiskstats, parseMounts, ioUtilization } from '../lib/disk.js';
import { sensorLabel, parseMilliCelsius, pickPackageTemp, primarySensor, ThermalSampler } from '../lib/thermal.js';
import { raplWatts, PowerSampler } from '../lib/power.js';
import { describeUnit, unescapeUnit, sessionRootFrom, AppUsageSampler } from '../lib/appusage.js';
import { BatteryTracker } from '../lib/batterytracker.js';
import { parseDrmFdinfo, GpuUsageSampler } from '../lib/gpuusage.js';
import { diagnose, minutesGained } from '../lib/diagnostics.js';
import { batteryFromProperties, readBacklight } from '../lib/systemstate.js';
import { appInfo } from '../lib/appnames.js';
import { AlertMonitor, alertReadings, alertLine } from '../lib/alerts.js';
import { BatteryLedger, LedgerFormatError, loadLedger, saveLedger, SYSTEM, OTHER, MORE, APPS_PER_BUCKET, MAX_BUCKETS, DAYS_KEPT } from '../lib/batteryledger.js';
import { upowerState, batteryHealth } from '../lib/battery.js';
import { parseNvidiaSmi, parseAmdSclk, intelBusyFromRc6 } from '../lib/gpu.js';
import { powerReadout, thermalUnavailable, batteryIconName, labelTemplate, visibleInterfaces, gpuTooltip, gpuReadings, sanitizeMetricList, PeakScale, hoverIndex, agoLabel } from '../lib/present.js';

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
eq(formatSpeed(5e15), '5000000.0 GB/s', 'speed beyond unit table');
eq([formatSpeed(1e6), formatSpeed(1500), formatSpeed(999)], ['1.0 MB/s', '1.5 KB/s', '999.0 B/s'], 'speed: decimal units, as labelled');
eq([formatBytes(999949), formatBytes(999950), formatBytes(1e6)], ['999.9 KB', '1.0 MB', '1.0 MB'], 'bytes: a value that rounds to a full step moves to the next unit');
eq([formatBytes(1024 ** 3 - 1, true), formatSpeed(999.96), formatSpeed(999960)], ['1.0 GiB', '1.0 KB/s', '1.0 MB/s'], 'bytes / speed: no "1024.0 MiB" or "1000.0 KB/s"');
eq(formatBytes(999.96e15), '1000.0 PB', 'bytes: the last unit has nowhere to roll over to');
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
        '/dev/sdd1 /run/media/me/CAMERA exfat rw 0 0',
        '/dev/sde1 /mnt/win ntfs3 rw 0 0',
        '/dev/loop3 /snap/core/1 squashfs ro 0 0'
    ].join('\n'));
    eq(mounts, [{ device: '/dev/nvme0n1p3', mount: '/home' }, { device: '/dev/sdb1', mount: '/media/me/USB Stick' },
        { device: '/dev/sdd1', mount: '/run/media/me/CAMERA' }, { device: '/dev/sde1', mount: '/mnt/win' }],
        'mounts: user-facing real filesystems incl. exFAT and ntfs3, one per device, \\040 decoded to a space');
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
    eq(gpuTooltip({ present: true, brand: 'Intel', percent: 12.4, memTotal: 0, memPercent: 0, temp: 0 }), 'Intel: 12%',
        'gpu tooltip: integrated GPU shows no "VRAM: 0%" or "Temp: 0°C"');
    eq(gpuTooltip({ present: true, brand: 'NVIDIA', percent: 37, memTotal: 8e9, memPercent: 25, temp: 61 }, 'F'), 'NVIDIA: 37%\nVRAM: 25% · Temp: 142°F',
        'gpu tooltip: dedicated GPU shows memory and temperature');
    ok(/not available/.test(gpuTooltip({ present: false })), 'gpu tooltip: absent');
    // Readings a GPU does not report are null (the UI leaves the field out).
    eq(gpuReadings({ present: true, percent: 12, temp: 0, powerDraw: null, clock: null, maxClock: null, fanSpeed: null }),
        { clock: null, temp: null, fan: null, power: null }, 'gpu readings: an integrated GPU reports none of them');
    eq(gpuReadings({ present: true, percent: 37, temp: 61, powerDraw: 42.46, clock: 1800, maxClock: 2400, fanSpeed: 0 }, 'F'),
        { clock: '1800 / 2400 MHz', temp: '142°F', fan: '0 RPM', power: '42.5 W' }, 'gpu readings: all present, a stopped fan is still a reading');
    eq(gpuReadings({ present: true, percent: 5, temp: 48, powerDraw: 0, clock: 650, fanSpeed: undefined }),
        { clock: '650 MHz', temp: '48°C', fan: null, power: null }, 'gpu readings: no maximum clock, no fan, zero power');
    eq(gpuReadings({ present: false, percent: 0 }), { clock: null, temp: null, fan: null, power: null }, 'gpu readings: no GPU');
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

    eq([0, 500, 1000, 9.94 * 1000, 9.96 * 1000, 999.4 * 1000, 999.6 * 1000, 5 * 1000 ** 2, 2.5 * 1000 ** 3, NaN, -4].map(formatSpeedCompact),
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

// ── settings: stored values are validated ──
{
    eq(sanitizeMetricList(['cpu', 'bogus', 'cpu', 'gpu', '']), ['cpu', 'gpu'], 'pinned: unknown keys and duplicates dropped, order kept');
    eq(sanitizeMetricList(undefined), [], 'pinned: nothing stored');

    // Needs schemas/gschemas.compiled (./dev.sh test-unit compiles it).
    // Only the schema is inspected; no setting is read or written.
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const source = Gio.SettingsSchemaSource.new_from_directory(`${here}/../schemas`, Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup('org.gnome.shell.extensions.resource-pulse', false);
    const allowed = (key, value) => schema.get_key(key).range_check(GLib.Variant.new_string(value));
    ok(!allowed('unit-temp', 'K') && !allowed('unit-mem', 'TB') && !allowed('battery-top-format', 'x') && !allowed('network-top-format', 'x'),
        'schema: enumerated string keys reject values the UI does not know');
    ok(allowed('unit-temp', 'F') && allowed('unit-mem', 'GiB') && allowed('battery-top-format', 'percent-time') && allowed('network-top-format', 'both'),
        'schema: every value the UI writes is accepted');
    ok(!schema.has_key('density-mode'), 'schema: the unused density-mode key is gone');

    // The settings model (menu page and preferences window are built from
    // it) must describe exactly what the schema stores.
    const rows = allSettingRows();
    eq(rows.filter(r => !schema.has_key(r.key)).map(r => r.key), [], 'settings model: every row is a schema key');
    eq(rows.filter(r => !['pins', 'switch', 'choice', 'number'].includes(r.kind)).map(r => r.key), [], 'settings model: known kinds only');
    const typeOf = key => schema.get_key(key).get_value_type().dup_string();
    eq(rows.filter(r => typeOf(r.key) !== { pins: 'as', switch: 'b', choice: 's', number: 'i' }[r.kind]).map(r => r.key), [],
        'settings model: each kind matches the type of its key');
    for (const row of rows.filter(r => r.kind === 'choice')) {
        ok(row.choices.every(([value]) => allowed(row.key, value)), `settings model: schema accepts every choice of ${row.key}`);
        const [, offered] = schema.get_key(row.key).get_range().deepUnpack();
        eq(row.choices.map(([value]) => value).sort(), offered.deepUnpack().sort(), `settings model: ${row.key} offers every value the schema allows`);
    }
    for (const row of rows.filter(r => r.kind === 'number')) {
        const [kind, limits] = schema.get_key(row.key).get_range().deepUnpack();
        eq([kind, ...limits.deepUnpack()], ['range', row.min, row.max], `settings model: ${row.key} has the schema's range`);
        ok(row.step > 0 && (row.max - row.min) % row.step === 0, `settings model: ${row.key} steps land on both ends of its range`);
    }
    eq(new Set(rows.map(r => r.key)).size, rows.length, 'settings model: no key appears twice');
    eq(SETTINGS_SECTIONS.map(s => s.id), ['topbar', 'units', 'alerts'], 'settings model: sections');
    eq(METRICS.map(m => m.key), schema.get_key('overview-card-order').get_default_value().deepUnpack().slice().sort((a, b) =>
        METRICS.findIndex(m => m.key === a) - METRICS.findIndex(m => m.key === b)), 'settings model: the metrics are the schema\'s cards');

    const cpuRow = rows.find(r => r.key === 'threshold-cpu');
    const tempRow = rows.find(r => r.key === 'threshold-temp');
    const pollRow = rows.find(r => r.key === 'poll-interval');
    eq([formatSettingValue(cpuRow, 90), formatSettingValue(pollRow, 2), formatSettingValue(tempRow, 80), formatSettingValue(tempRow, 80, 'F')],
        ['90%', '2 s', '80°C', '176°F'], 'settings model: values as shown');
    eq([stepSettingValue(cpuRow, 90, 1), stepSettingValue(cpuRow, 98, 1), stepSettingValue(cpuRow, 100, 1), stepSettingValue(cpuRow, 52, -1), stepSettingValue(pollRow, 1, -1)],
        [95, 100, 100, 50, 1], 'settings model: a step clamps to the range, also from an off-grid value');
    eq(pinPositions(['memory', 'cpu']), { cpu: 2, memory: 1, battery: 0, power: 0, disk: 0, network: 0, thermal: 0, gpu: 0 }, 'pins: positions follow the pinned order');
    eq([togglePinned(['cpu', 'memory'], 'gpu'), togglePinned(['cpu', 'memory'], 'cpu')], [['cpu', 'memory', 'gpu'], ['memory']], 'pins: toggling appends or removes');
}

// ── alerts: sustain, recovery, unavailable values, notification gap ──
{
    const S = 1e6;
    const a = new AlertMonitor({ sustainUs: 30 * S, recoverUs: 10 * S, hysteresis: 5, notifyGapUs: 600 * S });
    const at = (value, t) => a.update({ cpu: { value, threshold: 90 } }, t * S);
    eq(at(95, 0), { raised: [], cleared: [] }, 'alerts: not raised on the first high reading');
    eq(at(95, 29), { raised: [], cleared: [] }, 'alerts: not raised before 30 s');
    eq(at(95, 30), { raised: ['cpu'], cleared: [] }, 'alerts: raised after 30 s at or above the threshold');
    eq(a.active().map(x => [x.key, x.since]), [['cpu', 0]], 'alerts: active since the first high reading');
    eq(at(88, 31), { raised: [], cleared: [] }, 'alerts: a dip inside the hysteresis band does not clear');
    eq(at(84, 32), { raised: [], cleared: [] }, 'alerts: below the band, recovery starts');
    eq(at(95, 35), { raised: [], cleared: [] }, 'alerts: back up, recovery restarts');
    at(84, 36);
    eq(at(84, 45), { raised: [], cleared: [] }, 'alerts: not cleared before 10 s below');
    eq(at(84, 46), { raised: [], cleared: ['cpu'] }, 'alerts: cleared after 10 s below the band');
    ok(!a.isActive('cpu'), 'alerts: inactive after clearing');
    at(95, 50);
    eq(at(70, 60), { raised: [], cleared: [] }, 'alerts: an interrupted run does not raise');
    eq(at(95, 85), { raised: [], cleared: [] }, 'alerts: the run restarts from the new high reading');
    eq(at(95, 115), { raised: ['cpu'], cleared: [] }, 'alerts: raised 30 s after the restart');
    eq(a.update({ cpu: null }, 116 * S), { raised: [], cleared: ['cpu'] }, 'alerts: a metric that became unreadable clears');
    eq(a.update({ cpu: { value: NaN, threshold: 90 } }, 200 * S), { raised: [], cleared: [] }, 'alerts: NaN never alerts');
    ok(a.takeNotification('cpu', 0), 'alerts: first notification allowed');
    ok(!a.takeNotification('cpu', 599 * S), 'alerts: second within 10 min refused');
    ok(a.takeNotification('memory', 1 * S), 'alerts: the gap is per metric');
    ok(a.takeNotification('cpu', 600 * S), 'alerts: allowed again after 10 min');
    // The threshold is read on every update: lowering it below the value starts the run.
    const b = new AlertMonitor({ sustainUs: 30 * S });
    b.update({ memory: { value: 80, threshold: 90 } }, 0);
    b.update({ memory: { value: 80, threshold: 75 } }, 1 * S);
    eq(b.update({ memory: { value: 80, threshold: 75 } }, 31 * S).raised, ['memory'], 'alerts: a lowered threshold applies');

    const unavailable = thm => !(thm.sensors?.length > 0);
    const limits = { cpu: 90, memory: 90, thermal: 80, gpu: 95, disk: 95, pressure: 10 };
    const r = alertReadings({
        cpu: { total: 50 }, mem: { total: 8e9, percent: 60 },
        thm: { packageTemp: 0, sensors: [] }, gpu: { present: false, percent: 0 },
        dsk: { mounts: [] }, psi: null,
    }, limits, unavailable);
    eq([r.cpu, r.memory, r.thermal, r.gpu, r.disk, r.pressure], [{ value: 50, threshold: 90 }, { value: 60, threshold: 90 }, null, null, null, null],
        'alerts: readings for what is missing are null, never 0');
    const r2 = alertReadings({ dsk: { mounts: [{ percent: 97 }] }, psi: { memory: { full: 12.5 } }, thm: { packageTemp: 85, sensors: [{}] } }, limits, unavailable);
    eq([r2.disk, r2.pressure, r2.thermal], [{ value: 97, threshold: 95 }, { value: 12.5, threshold: 10 }, { value: 85, threshold: 80 }], 'alerts: disk, pressure and temperature readings');
    eq(alertLine({ value: 97.2, since: 0 }, 95 * S, { name: 'CPU', format: v => `${Math.round(v)} %` }), 'CPU 97 % for 2 min', 'alerts: line names the metric, value and duration');
}

// ── live: process churn, bounded state, no fd leak ──
const loop = new GLib.MainLoop(null, false);
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(), GLib.SOURCE_REMOVE)));
(async () => {
    const fds = async () => (await listDirAsync('/proc/self/fd')).length;

    // Optional reads: "not there" is silent, any other failure is logged once.
    {
        const failure = async path => readFileAsync(path).then(() => null, e => e);
        const dir = GLib.dir_make_tmp('rp-read-XXXXXX');
        ok(noteReadError(await failure(`${dir}/absent`)) === false, 'read errors: a missing file is not reported');
        GLib.file_set_contents(`${dir}/secret`, 'x');
        // Not GLib.chmod: gjs before 1.80 does not expose it.
        Gio.File.new_for_path(`${dir}/secret`).set_attribute_uint32('unix::mode', 0, Gio.FileQueryInfoFlags.NONE, null);
        const denied = await failure(`${dir}/secret`);
        if (denied) {
            eq([noteReadError(denied), noteReadError(denied)], [true, false], 'read errors: permission denied is reported, once');
        } else {
            print('  (running as root: permission-denied case not exercised)');
        }
        GLib.unlink(`${dir}/secret`);
        GLib.rmdir(dir);
    }

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

    // Energy counters that exist but may not be read are reported as
    // blocked (the permission fix applies), unlike a machine without any.
    {
        const root = GLib.dir_make_tmp('rp-powercap-XXXXXX');
        eq((await new PowerSampler(root).sample()).raplBlocked, false, 'power: no energy domains is not "blocked"');
        const zone = `${root}/intel-rapl:0`;
        GLib.mkdir_with_parents(zone, 0o755);
        GLib.file_set_contents(`${zone}/name`, 'package-0\n');
        GLib.file_set_contents(`${zone}/energy_uj`, '1000000\n');
        GLib.file_set_contents(`${zone}/max_energy_range_uj`, '262143328850\n');
        const mode = bits => Gio.File.new_for_path(`${zone}/energy_uj`)
            .set_attribute_uint32('unix::mode', bits, Gio.FileQueryInfoFlags.NONE, null);
        mode(0o000);
        const pwr = new PowerSampler(root);
        const denied = await pwr.sample();
        // root reads the file whatever its mode: the check cannot run there.
        if (GLib.file_test('/proc/self', GLib.FileTest.EXISTS) && Gio.Credentials.new().get_unix_user() === 0)
            print('SKIP power: unreadable counters cannot be simulated as root');
        else
            eq([denied.raplSupported, denied.raplBlocked, denied.packagePower], [false, true, null], 'power: unreadable counters are reported as blocked');
        mode(0o644);
        eq((await pwr.sample()).raplBlocked, denied.raplBlocked, 'power: the probe is cached between samples');
        pwr.forgetProbe();
        const granted = await pwr.sample();
        eq([granted.raplSupported, granted.raplBlocked], [true, false], 'power: after forgetProbe() readable counters are picked up at once');
        for (const name of ['name', 'energy_uj', 'max_energy_range_uj']) GLib.unlink(`${zone}/${name}`);
        GLib.rmdir(zone);
        GLib.rmdir(root);
    }

    // Session units named as apps, terminals, snaps and services (names as
    // they appear on a real GNOME 50 session).
    {
        const name = unit => {
            const d = describeUnit(unit);
            return d ? `${d.kind}:${d.id}` : null;
        };
        eq(unescapeUnit('jetbrains\\x2didea'), 'jetbrains-idea', 'units: \\x2d unescaped');
        eq([
            'app-gnome-org.gnome.Nautilus-4321.scope',
            'app-gnome-jetbrains\\x2didea-79679.scope',
            'app-gnome-kitty-21009.scope',
            'kitty-21009-1.scope',
            'app-org.chromium.Chromium-80335.scope',
            'app-antigravity-14164.scope',
            'app-flatpak-org.mozilla.firefox-2001.scope',
            'snap.firefox.firefox-3c1a2b.scope',
            'vte-spawn-5a0e8c3e-1111-2222-3333-444455556666.scope',
            'org.gnome.Shell@ubuntu.service',
            'pipewire.service',
            'app-gnome\\x2dsession\\x2dmanager.slice',
            'dbus.socket',
        ].map(name), [
            'app:org.gnome.Nautilus', 'app:jetbrains-idea', 'app:kitty', 'app:kitty', 'app:org.chromium.Chromium',
            'app:antigravity', 'app:org.mozilla.firefox', 'snap:snap.firefox', 'terminal:terminal',
            'service:org.gnome.Shell', 'service:pipewire', null, null,
        ], 'units: apps, terminal windows, snaps and services are told apart; slices and sockets are not units');
        eq(sessionRootFrom('0::/user.slice/user-1000.slice/user@1000.service/session.slice/org.gnome.Shell@ubuntu.service\n'),
            '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service', 'units: session root from /proc/self/cgroup');
        eq(sessionRootFrom('0::/system.slice/gdm.service\n'), null, 'units: no session root outside a user manager');
    }

    // The sampler on a fixture cgroup tree: nested slices, a socket, an
    // unreadable unit and the machine-wide counters.
    {
        const mount = GLib.dir_make_tmp('rp-cgroup-XXXXXX');
        const session = `${mount}/user.slice/user-1000.slice/user@1000.service`;
        const made = [];
        const unit = (path, usec) => {
            GLib.mkdir_with_parents(`${mount}/${path}`, 0o755);
            if (usec !== null) GLib.file_set_contents(`${mount}/${path}/cpu.stat`, `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`);
            made.push(path);
        };
        unit('', 9000000);
        unit('system.slice', 2000000);
        unit('user.slice/user-1000.slice/user@1000.service', 5000000);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice', 4000000);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.Nautilus-4321.scope', 1500000);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice/kitty-21009-1.scope', 700000);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome\\x2dsession\\x2dmanager.slice', 100);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome\\x2dsession\\x2dmanager.slice/gnome-session-manager@ubuntu.service', 100);
        unit('user.slice/user-1000.slice/user@1000.service/app.slice/dbus.socket', 5);
        unit('user.slice/user-1000.slice/user@1000.service/session.slice/org.gnome.Shell@ubuntu.service', 1200000);
        unit('user.slice/user-1000.slice/user@1000.service/session.slice/locked.service', 42);
        Gio.File.new_for_path(`${session}/session.slice/locked.service/cpu.stat`)
            .set_attribute_uint32('unix::mode', 0o000, Gio.FileQueryInfoFlags.NONE, null);

        const sampler = new AppUsageSampler({ mount, session });
        const reading = await sampler.sample();
        const byUnit = Object.fromEntries(reading.units.map(u => [u.unit, `${u.kind}:${u.id}:${u.usec}`]));
        eq([reading.total, reading.system, sampler.available], [9000000, 2000000, true], 'app usage: machine and system-service totals');
        eq(byUnit['app-gnome-org.gnome.Nautilus-4321.scope'], 'app:org.gnome.Nautilus:1500000', 'app usage: an app scope');
        eq(byUnit['kitty-21009-1.scope'], 'app:kitty:700000', 'app usage: a terminal window scope');
        eq(byUnit['gnome-session-manager@ubuntu.service'], 'service:gnome-session-manager:100', 'app usage: a unit inside a nested slice');
        eq(byUnit['org.gnome.Shell@ubuntu.service'], 'service:org.gnome.Shell:1200000', 'app usage: a session service');
        ok(!('dbus.socket' in byUnit), 'app usage: sockets are not counted');
        if (Gio.Credentials.new().get_unix_user() === 0)
            print('SKIP app usage: an unreadable counter cannot be simulated as root');
        else
            ok(!('locked.service' in byUnit), 'app usage: an unreadable counter is left out, not read as 0');

        const missing = await new AppUsageSampler({ mount: `${mount}/nowhere`, session: `${mount}/nowhere/user` }).sample();
        eq([missing.units.length, missing.total], [0, null], 'app usage: no cgroup tree gives no units and no total');

        Gio.File.new_for_path(`${session}/session.slice/locked.service/cpu.stat`)
            .set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
        for (const path of made.reverse()) {
            const dir = path ? `${mount}/${path}` : mount;
            if (GLib.file_test(`${dir}/cpu.stat`, GLib.FileTest.EXISTS)) GLib.unlink(`${dir}/cpu.stat`);
        }
        // Remove the directories, deepest first.
        const dirs = new Set();
        for (const path of made) {
            for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') dirs.add(p);
        }
        [...dirs].sort((a, b) => b.length - a.length).forEach(p => GLib.rmdir(`${mount}/${p}`));
        GLib.rmdir(mount);
    }

    // The battery ledger, on synthetic readings with answers worked out by hand.
    {
        const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
        const H = 3600 * 1000;
        const t0 = new Date(2026, 9, 14, 10, 0, 5).getTime();
        // A reading 30 s after the previous one; counters in µs.
        const reading = (step, units, total, system) => ({
            mono: 1e9 + step * 30e6, wall: t0 + step * 30000,
            usage: { total, system, units: Object.entries(units).map(([unit, usec]) => ({ unit, usec, id: unit.split('#')[0], kind: 'app', label: unit })) },
        });
        const battery = wh => ({ present: true, onBattery: true, energyWh: wh });

        const led = new BatteryLedger();
        eq(led.ingest({ ...reading(0, { 'a#1': 10e6, 'b#1': 5e6 }, 100e6, 20e6), packageW: 10, battery: battery(40) }), false,
            'ledger: the first sample only sets the baseline');
        // Next 30 s: a +6 s, b +3 s, system +1 s, machine +12 s (2 s unnamed).
        // 10 W for 30 s = 1/12 Wh, no idle baseline learnt yet: all of it is shared.
        eq(led.ingest({ ...reading(1, { 'a#1': 16e6, 'b#1': 8e6 }, 112e6, 21e6), packageW: 10, battery: battery(39.9), focusUsec: { a: 15e6 } }), true,
            'ledger: the second sample is attributed');
        let sum = led.summarize();
        const app = id => sum.apps.find(x => x.id === id);
        ok(near(sum.packageWh, 1 / 12) && near(sum.batteryWh, 0.1, 1e-9) && sum.seconds === 30 && sum.cpu === 12e6, 'ledger: interval totals');
        ok(near(app('a').wh, 1 / 24) && near(app('b').wh, 1 / 48) && near(app(SYSTEM).wh, 1 / 144) && near(app(OTHER).wh, 1 / 72),
            `ledger: package energy shared by CPU time (${sum.apps.map(x => `${x.id} ${x.wh.toFixed(5)}`).join(', ')})`);
        ok(near(sum.apps.reduce((t, x) => t + x.wh, 0), sum.attributedWh), 'ledger: shares add up to the attributed energy');
        ok(app('a').fg === 3e6 && app('b').fg === 0, 'ledger: focus for half the interval makes half of the CPU time foreground');
        eq(sum.apps[0].id, 'a', 'ledger: the biggest consumer is first');

        // A unit that vanished loses only its tail; a new one counts from zero.
        led.ingest({ ...reading(2, { 'b#1': 9e6, 'b#2': 2e6, 'c#1': 4e6 }, 120e6, 21e6), packageW: 10, battery: battery(39.8) });
        sum = led.summarize();
        eq([app('b').cpu, app('c').cpu, app('a').cpu], [3e6 + 1e6 + 2e6, 4e6, 6e6], 'ledger: new units count from zero, scopes of one app are summed');

        // The idle baseline is learnt (10th percentile) and not given to apps.
        const base = new BatteryLedger();
        let units = { 'a#1': 0 };
        for (let i = 0; i <= 30; i++) {
            units = { 'a#1': i * 1e6 };
            base.ingest({ ...reading(i, units, i * 2e6, 0), packageW: i < 10 ? 3 : 12, battery: null });
        }
        ok(base.baselineW === 3, `ledger: idle baseline learnt as ${base.baselineW} W`);
        const bs = base.summarize();
        ok(bs.idleWh > 0 && near(bs.attributedWh, bs.packageWh - bs.idleWh) && near(bs.apps.reduce((t, x) => t + x.wh, 0), bs.attributedWh),
            'ledger: the idle baseline is kept out of the shares');

        // Gaps: the timer did not run, or the machine slept.
        const gaps = new BatteryLedger();
        gaps.ingest({ ...reading(0, { 'a#1': 0 }, 0, 0), packageW: 5, battery: battery(40) });
        const late = reading(20, { 'a#1': 300e6 }, 400e6, 0); // 600 s later
        eq(gaps.ingest({ ...late, packageW: 5, battery: battery(39) }), false, 'ledger: a 10-minute gap is not attributed');
        const asleep = reading(21, { 'a#1': 301e6 }, 401e6, 0);
        asleep.wall += 3 * H; // wall time moved on 3 h, monotonic time 30 s
        eq(gaps.ingest({ ...asleep, packageW: 5, battery: battery(38.5) }), false, 'ledger: a sleep is not attributed');
        const gs = gaps.summarize();
        ok(near(gs.gapWh, 1.5) && gs.batteryWh === 0 && !gs.apps.some(x => x.id === 'a'), 'ledger: battery used over gaps is kept apart');

        // Time above the temperature alert is counted only over attributed intervals.
        const warm = new BatteryLedger();
        warm.ingest({ ...reading(0, { 'a#1': 0 }, 0, 0), packageW: 5, battery: null, hot: true });
        warm.ingest({ ...reading(1, { 'a#1': 1e6 }, 2e6, 0), packageW: 5, battery: null, hot: true });
        warm.ingest({ ...reading(2, { 'a#1': 2e6 }, 4e6, 0), packageW: 5, battery: null, hot: false });
        eq([warm.summarize().hotSeconds, warm.summarize().seconds], [30, 60], 'ledger: hot seconds');

        // AC and battery in one hour are two buckets; the battery-only view sees one.
        const mixed = new BatteryLedger();
        mixed.ingest({ ...reading(0, { 'a#1': 0 }, 0, 0), packageW: 5, battery: battery(40) });
        mixed.ingest({ ...reading(1, { 'a#1': 1e6 }, 2e6, 0), packageW: 5, battery: battery(39.9) });
        mixed.ingest({ ...reading(2, { 'a#1': 3e6 }, 4e6, 0), packageW: 5, battery: { present: true, onBattery: false, energyWh: 39.9 } });
        eq([mixed.buckets.length, mixed.summarize({ batteryOnly: true }).apps.find(x => x.id === 'a').cpu], [2, 1e6], 'ledger: AC and battery are kept apart');

        // Caps: at most 2 x APPS_PER_BUCKET named apps while open, APPS_PER_BUCKET once the hour is over.
        const busy = new BatteryLedger();
        const many = n => Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`app${i}#1`, n * (i + 1) * 1e5]));
        busy.ingest({ ...reading(0, many(0), 0, 0), packageW: 5, battery: null });
        busy.ingest({ ...reading(1, many(1), 1e9, 0), packageW: 5, battery: null });
        const open = busy.buckets[0];
        const named = b => Object.keys(b.a).filter(id => !id.startsWith('@')).length;
        ok(named(open) <= 2 * APPS_PER_BUCKET && open.a[MORE], `ledger: an open hour holds ${named(open)} named apps plus the rest`);
        const cpuBefore = Object.values(open.a).reduce((t, x) => t + x[0], 0);
        const next = reading(2, many(2), 2e9, 0);
        next.wall = t0 + H; // the next hour
        busy.ingest({ ...next, packageW: 5, battery: null });
        ok(named(open) === APPS_PER_BUCKET && near(Object.values(open.a).reduce((t, x) => t + x[0], 0), cpuBefore),
            `ledger: a closed hour keeps ${named(open)} apps and loses no CPU time`);

        // Retention: nothing older than 14 days, never more than MAX_BUCKETS.
        const old = new BatteryLedger();
        for (let h = 0; h < 20 * 24; h++) {
            const r = reading(h, { 'a#1': h * 1e6 }, h * 2e6, 0);
            r.wall = t0 + h * H;
            old.ingest({ ...r, packageW: 5, battery: { present: true, onBattery: h % 2 === 0, energyWh: 40 } });
        }
        const newest = old.buckets[old.buckets.length - 1].t;
        ok(old.buckets.length <= MAX_BUCKETS && old.buckets.every(b => b.t > newest - DAYS_KEPT * 24 * H),
            `ledger: ${old.buckets.length} buckets kept, oldest ${((newest - old.buckets[0].t) / H / 24).toFixed(1)} days back`);

        // Saved and read back; damaged files are moved aside, not lost.
        const dir = GLib.dir_make_tmp('rp-ledger-XXXXXX');
        const path = `${dir}/sub/battery-history.json`;
        eq((await loadLedger(path)).problem, null, 'ledger file: a missing file is a fresh ledger, not a problem');
        await saveLedger(path, led);
        const back = await loadLedger(path);
        eq([back.problem, JSON.stringify(back.ledger.summarize())], [null, JSON.stringify(led.summarize())], 'ledger file: written and read back');
        // After a reload the first sample reports what the battery delivered since the save as a gap.
        back.ledger.ingest({ ...reading(40, { 'a#1': 1 }, 1, 0), packageW: 5, battery: battery(39.3) });
        ok(near(back.ledger.summarize().gapWh, 0.5), 'ledger file: battery used while the extension was off is a gap');
        back.ledger.forgetLast();
        eq(back.ledger.ingest({ ...reading(41, { 'a#1': 2 }, 2, 0), packageW: 5, battery: battery(30) }), false, 'ledger: after forgetLast() the next sample starts afresh');
        ok(near(back.ledger.summarize().gapWh, 0.5), 'ledger: ... and the time it was off is not a gap');
        let threw = null;
        try {
            BatteryLedger.fromJSON('{"version": 99, "buckets": []}');
        } catch (e) {
            threw = e;
        }
        ok(threw instanceof LedgerFormatError, 'ledger file: an unknown version is refused');
        GLib.file_set_contents(path, '{"version": 1, "buck');
        const damaged = await loadLedger(path);
        const kept = [];
        const en = Gio.File.new_for_path(`${dir}/sub`).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = en.next_file(null); info; info = en.next_file(null)) kept.push(info.get_name());
        en.close(null);
        ok(damaged.problem?.includes('damaged') && damaged.ledger.buckets.length === 0 && kept.some(n => n.startsWith('battery-history.json.damaged-')),
            `ledger file: a damaged file is reported and kept aside (${damaged.problem})`);
        for (const n of kept) GLib.unlink(`${dir}/sub/${n}`);
        GLib.rmdir(`${dir}/sub`);
        GLib.rmdir(dir);
    }

    // The tracker with stand-in samplers: focus time, saving, stopping.
    {
        const dir = GLib.dir_make_tmp('rp-tracker-XXXXXX');
        const path = `${dir}/battery-history.json`;
        let cpu = 0;
        let focusCb = null;
        let focused = 'org.gnome.Nautilus';
        const problems = [];
        const tracker = new BatteryTracker({
            path,
            usage: {
                available: true,
                sample: () => {
                    cpu += 1e6;
                    return Promise.resolve({ total: cpu * 2, system: 0, units: [
                        { unit: 'app-gnome-org.gnome.Nautilus-1.scope', id: 'org.gnome.Nautilus', kind: 'app', label: 'x', usec: cpu },
                    ] });
                },
            },
            power: { sample: () => Promise.resolve({ raplSupported: true, packagePower: 6 }) },
            thermal: { sample: fast => Promise.resolve({ packageTemp: fast === false ? 91 : null }) },
            hotAbove: () => 85,
            battery: { sample: () => Promise.resolve({ present: true, state: 'discharging', energy: 40 - cpu / 1e7 }) },
            focus: { current: () => focused, connect: cb => { focusCb = cb; return 7; }, disconnect: id => { if (id === 7) focusCb = null; } },
            onProblem: message => problems.push(message),
        });
        await tracker.start();
        ok(tracker.running && focusCb !== null && tracker.ledger.buckets.length === 1, 'tracker: started, focus watched, first sample taken');
        await sleep(200);
        focused = 'kitty';
        focusCb();
        await sleep(100);
        eq(await tracker.tick(), true, 'tracker: the second sample is attributed');
        const sum = tracker.ledger.summarize();
        const nautilus = sum.apps.find(a => a.id === 'org.gnome.Nautilus');
        ok(nautilus && nautilus.fg > 0 && nautilus.fg < nautilus.cpu, `tracker: focus time split the CPU time (${nautilus?.fg} of ${nautilus?.cpu})`);
        ok(sum.packageWh > 0 && sum.hasEnergy, 'tracker: package power reached the ledger');
        ok(sum.hotSeconds > 0 && sum.hotSeconds === sum.seconds, 'tracker: a temperature above the alert is recorded (fast thermal sample)');
        ok(GLib.file_test(path, GLib.FileTest.EXISTS), 'tracker: the first hour was saved');
        await tracker.stop({ forget: true });
        ok(!tracker.running && focusCb === null, 'tracker: stopped, focus no longer watched');
        const saved = await loadLedger(path);
        eq([saved.problem, saved.ledger.buckets.length, problems.length], [null, 1, 0], 'tracker: the history survives a stop');
        eq(JSON.parse(GLib.file_get_contents(path)[1].toString()).last.batteryWh, null, 'tracker: switching off forgets the last sample');
        GLib.unlink(path);
        GLib.rmdir(dir);
    }

    // Diagnostics: each rule fires on its evidence and is silent without it.
    {
        const summary = (o = {}) => ({ seconds: 4 * 3600, batteryWh: 32, packageWh: 12, idleWh: 4, attributedWh: 8, gapWh: 0, cpu: 1e10,
            hasEnergy: true, hotSeconds: 0, apps: [], ...o });
        const state = (o = {}) => ({ battery: { healthPct: 90, cycles: 120, fullWh: 40, chargeLimit: 'on' }, backlight: 0.4,
            powerProfile: 'balanced', onBattery: true, energyReadable: true, ...o });
        const ids = findings => findings.map(f => f.id);
        const calm = diagnose({ battery: summary(), all: summary(), state: state() });
        eq(ids(calm), ['wear'], 'diagnose: a healthy, well-set machine gets only the health line');
        eq(calm[0].severity, 'info', 'diagnose: good health is information, not a warning');

        // 8 W average drain, 40 Wh full: 5 h. Saving 0.6 W gives 40/7.4 h: about 24 min more.
        ok(Math.abs(minutesGained(40, 8, 0.6) - (40 / 7.4 - 5) * 60) < 1e-9, 'diagnose: minutes gained per charge');
        eq(minutesGained(40, 8, 9), null, 'diagnose: no estimate when the saving exceeds the drain');

        const apps = [
            { id: 'chat', cpu: 1e9, fg: 1e8, wh: 2.6 }, // 90 % background, 2.34 Wh of it
            { id: 'editor', cpu: 2e9, fg: 1.8e9, wh: 4 }, // used in the foreground
            { id: 'tiny', cpu: 1e8, fg: 0, wh: 0.1 }, // background, but too small
            { id: '@system', cpu: 3e9, fg: 0, wh: 1.3 }, // not an app
        ];
        const bg = diagnose({ battery: summary({ apps }), all: summary({ apps }), state: state(), appName: id => id.toUpperCase() });
        const chat = bg.find(f => f.id === 'background:chat');
        eq(ids(bg).filter(id => id.startsWith('background')), ['background:chat'], 'diagnose: only a sizeable background consumer is named');
        ok(chat.title.startsWith('CHAT') && Math.abs(chat.estimate.watts - 2.34 / 4) < 1e-9 && chat.estimate.minutes > 0,
            `diagnose: the background finding has its estimate (${chat.estimate.watts.toFixed(3)} W, ${chat.estimate.minutes?.toFixed(1)} min)`);
        eq(ids(diagnose({ battery: summary({ apps, seconds: 1800 }), all: summary(), state: state() })).filter(id => id.startsWith('background')), [],
            'diagnose: less than an hour on battery is not enough evidence');
        eq(ids(diagnose({ battery: summary({ apps, hasEnergy: false }), all: summary(), state: state({ energyReadable: false }) })),
            ['wear', 'energy-unreadable'], 'diagnose: without energy readings no background advice, and the reason is given');

        const perf = diagnose({ battery: summary(), all: summary(), state: state({ powerProfile: 'performance' }) });
        eq(perf.find(f => f.id === 'power-profile')?.action, { kind: 'power-profile', value: 'balanced', label: 'Switch to Balanced' },
            'diagnose: performance mode on battery offers the switch');
        eq(ids(diagnose({ battery: summary(), all: summary(), state: state({ powerProfile: 'performance', onBattery: false }) })), ['wear'],
            'diagnose: performance mode on the charger is fine');
        ok(ids(diagnose({ battery: summary(), all: summary(), state: state({ backlight: 0.9 }) })).includes('brightness'), 'diagnose: high brightness');
        ok(ids(diagnose({ battery: summary({ hotSeconds: 3600 }), all: summary(), state: state() })).includes('heat'), 'diagnose: hot for a quarter of the time');

        const worn = diagnose({ battery: summary(), all: summary(), state: state({ battery: { healthPct: 72, cycles: 610, fullWh: 32, chargeLimit: 'off' } }) });
        eq(ids(worn), ['wear', 'charge-limit'], 'diagnose: a worn battery is a warning, and a charge limit is advised where it exists');
        eq(worn[0].severity, 'warning', 'diagnose: warnings come first');
        // On the charger 90 % of the time, no charge limit to offer.
        const plugged = diagnose({ battery: summary({ seconds: 3600 }), all: summary({ seconds: 36000 }),
            state: state({ battery: { healthPct: 90, cycles: 10, fullWh: 40, chargeLimit: 'unsupported' } }) });
        ok(ids(plugged).includes('always-plugged'), 'diagnose: mostly plugged in without a charge limit');
        eq(ids(diagnose({ battery: summary(), all: summary(), state: state({ battery: null, backlight: 1, powerProfile: 'performance' }) })), [],
            'diagnose: a desktop without a battery gets no battery advice');
    }

    // Machine state for the diagnostics: UPower battery properties and the backlight.
    {
        const props = { Type: 2, PowerSupply: true, IsPresent: true, EnergyFull: 38.99, EnergyFullDesign: 45, ChargeCycles: 204,
            ChargeThresholdSupported: true, ChargeThresholdEnabled: false };
        const b = batteryFromProperties(props);
        ok(Math.abs(b.healthPct - 86.644) < 0.01 && b.cycles === 204 && b.fullWh === 38.99 && b.chargeLimit === 'off', 'state: battery health, cycles, charge limit off');
        eq(batteryFromProperties({ ...props, ChargeThresholdEnabled: true }).chargeLimit, 'on', 'state: charge limit on');
        eq(batteryFromProperties({ ...props, ChargeThresholdSupported: undefined, ChargeCycles: 0 }), { healthPct: b.healthPct, cycles: null, fullWh: 38.99, chargeLimit: 'unsupported' },
            'state: an older UPower without charge-limit properties, no cycle count');
        eq([batteryFromProperties({ ...props, Type: 1 }), batteryFromProperties({ ...props, PowerSupply: false }), batteryFromProperties({ ...props, IsPresent: false })],
            [null, null, null], 'state: line power, a mouse battery and an absent battery are not the battery');
        const dir = GLib.dir_make_tmp('rp-backlight-XXXXXX');
        eq(await readBacklight(dir), null, 'state: no backlight device');
        GLib.mkdir_with_parents(`${dir}/intel_backlight`, 0o755);
        GLib.file_set_contents(`${dir}/intel_backlight/brightness`, '72000\n');
        GLib.file_set_contents(`${dir}/intel_backlight/max_brightness`, '96000\n');
        eq(await readBacklight(dir), 0.75, 'state: backlight level');
        for (const f of ['brightness', 'max_brightness']) GLib.unlink(`${dir}/intel_backlight/${f}`);
        GLib.rmdir(`${dir}/intel_backlight`);
        GLib.rmdir(dir);
        eq([appInfo('@system').name, appInfo('org.gnome.Shell').name, appInfo('no-such-app-here').name, appInfo('snap.nosuch').name],
            ['System services', 'GNOME Shell', 'no-such-app-here', 'nosuch'], 'app names: pseudo apps, services and unknown ids');
    }

    // GPU busy time per unit from DRM fdinfo, on a fixture /proc.
    {
        const i915 = 'pos:\t0\nflags:\t02100002\ndrm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t27\n' +
            'drm-engine-render:\t3000000000 ns\ndrm-engine-copy:\t0 ns\ndrm-engine-video:\t500000000 ns\ndrm-engine-capacity-video:\t2\n';
        eq(parseDrmFdinfo(i915), { key: 'i915/0000:00:02.0/27', ns: 3.5e9 }, 'gpu: engines summed, capacity lines ignored');
        eq(parseDrmFdinfo('pos:\t0\nflags:\t02\n'), null, 'gpu: a file that is not a GPU client');

        const proc = GLib.dir_make_tmp('rp-proc-XXXXXX');
        const made = [];
        const fd = (pid, n, target, info) => {
            GLib.mkdir_with_parents(`${proc}/${pid}/fd`, 0o755);
            GLib.mkdir_with_parents(`${proc}/${pid}/fdinfo`, 0o755);
            Gio.File.new_for_path(`${proc}/${pid}/fd/${n}`).make_symbolic_link(target, null);
            GLib.file_set_contents(`${proc}/${pid}/fdinfo/${n}`, info);
            made.push(`${pid}/fd/${n}`, `${pid}/fdinfo/${n}`);
        };
        const client = (id, ns) => `drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t${id}\ndrm-engine-render:\t${ns} ns\n`;
        fd(100, 3, '/dev/dri/renderD128', client(7, 2e9));
        fd(100, 4, '/dev/dri/renderD128', client(7, 2e9)); // the same client, dup'd
        fd(100, 5, '/dev/null', client(99, 9e9)); // not a GPU file: never read
        fd(101, 3, '/dev/dri/card1', client(8, 1e9)); // a child of the same app
        fd(200, 3, '/dev/dri/renderD128', client(7, 2e9)); // passed to another unit: counted once
        fd(300, 3, 'socket:[1234]', 'pos:\t0\n');
        const gs = new GpuUsageSampler(proc);
        const units = new Map([['app-a.scope', [100, 101]], ['app-b.scope', [200]], ['app-c.scope', [300, 999]]]);
        let got = await gs.sample(units);
        eq([...got], [['app-a.scope', 3e9]], 'gpu: per unit, dup\'d and shared clients counted once, other fds ignored, a vanished pid skipped');
        GLib.file_set_contents(`${proc}/100/fdinfo/3`, client(7, 5e9));
        got = await gs.sample(units);
        eq(got.get('app-a.scope'), 6e9, 'gpu: later samples read the cached GPU fds');
        for (const path of made.reverse()) GLib.unlink(`${proc}/${path}`);
        for (const pid of [100, 101, 200, 300]) {
            GLib.rmdir(`${proc}/${pid}/fd`);
            GLib.rmdir(`${proc}/${pid}/fdinfo`);
            GLib.rmdir(`${proc}/${pid}`);
        }
        GLib.rmdir(proc);

        // The ledger: uncore energy above its idle level goes to the apps
        // that kept the GPU busy, the rest of the package by CPU time.
        const H = 3600;
        const led = new BatteryLedger();
        const at = (i, cpuA, cpuB, gpuA, gpuB) => ({
            mono: 1e9 + i * 30e6, wall: new Date(2026, 9, 14, 10, 0, 5).getTime() + i * 30000,
            usage: { total: (cpuA + cpuB) * 1.0, system: 0, units: [
                { unit: 'a.scope', id: 'a', usec: cpuA }, { unit: 'b.scope', id: 'b', usec: cpuB },
            ] },
            packageW: 12, uncoreW: 4, battery: null,
            gpu: new Map([['a.scope', gpuA], ['b.scope', gpuB]]),
        });
        led.ingest(at(0, 0, 0, 0, 0));
        // 30 s: a 3 s CPU and 1 s GPU, b 1 s CPU and 3 s GPU. No baselines yet:
        // package 0.1 Wh, of which uncore 1/30 Wh to GPU time, 1/15 Wh to CPU time.
        led.ingest(at(1, 3e6, 1e6, 1e9, 3e9));
        const sum = led.summarize();
        const a = sum.apps.find(x => x.id === 'a');
        const b = sum.apps.find(x => x.id === 'b');
        const near = (x, y) => Math.abs(x - y) < 1e-9;
        ok(near(sum.graphicsWh, 4 * 30 / H) && sum.gpu === 4e9, `ledger gpu: graphics pool ${sum.graphicsWh}`);
        ok(near(a.wh, (12 - 4) * 30 / H * 0.75 + 4 * 30 / H * 0.25) && near(b.wh, (12 - 4) * 30 / H * 0.25 + 4 * 30 / H * 0.75),
            `ledger gpu: a ${a.wh.toFixed(5)} Wh, b ${b.wh.toFixed(5)} Wh`);
        ok(a.gpu === 1e9 && b.gpu === 3e9 && near(a.wh + b.wh, sum.attributedWh), 'ledger gpu: GPU time per app, shares add up');
        // An entry saved before GPU time existed reads as 0.
        const old = BatteryLedger.fromJSON(JSON.stringify({ version: 1, buckets: [{ t: 0, b: true, s: 30, bw: 0, pw: 0, iw: 0, gw: 0, cpu: 1, energy: false, a: { x: [1, 0, 0] } }] }));
        eq(old.summarize().apps[0].gpu, 0, 'ledger gpu: entries from before GPU time read as 0');
    }

    // A baseline older than the caller allows is dropped instead of turning
    // the rates into an average over the gap.
    {
        const ps = new ProcessSampler();
        await ps.sample(16e9, false, 5, 10);
        await sleep(300);
        const steady = await ps.sample(16e9, false, 5, 10);
        ok(!steady.warmingUp, 'proc baseline: consecutive samples are not warm-up');
        // Let real time pass rather than rewinding the stored timestamps:
        // on a machine up for less than the rewind (a fresh CI runner) they
        // would go negative, which the sampler reads as "no baseline".
        await sleep(300);
        const stale = await ps.sample(16e9, false, 5, 0.1);
        ok(stale.warmingUp && stale.top.every(p => p.cpu === 0), 'proc baseline: a baseline older than allowed is dropped (warm-up, no rates)');
        await sleep(300);
        ok(!(await ps.sample(16e9, false, 5, 10)).warmingUp, 'proc baseline: next sample has rates again');
        ps.destroy();
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
