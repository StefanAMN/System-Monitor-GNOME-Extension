import GLib from 'gi://GLib';

import { AppBottleneckSampler, cgroupIoBytes } from '../../src/lib/collectors/appbottlenecks.js';
import { appBottlenecks } from '../../src/lib/engine/appbottlenecks.js';

let passed = 0;
function check(condition, label) {
    if (!condition) throw new Error(label);
    passed++;
}

check(cgroupIoBytes('8:0 rbytes=10 wbytes=20 rios=1\n9:0 wbytes=40 rbytes=30\n') === 100, 'sums bytes across devices');
check(cgroupIoBytes('') === 0 && cgroupIoBytes(null) === null && cgroupIoBytes('8:0 rbytes=2') === null, 'idle and missing disk data are distinct');

const scope = (path, fields = {}) => ({
    path, id: 'org.example.Browser', at: 1e6, inode: 1,
    cpu: 100, memory: 200, io: null, pressure: [40, 100000, 0, 0, null, null], ...fields,
});
const before = {
    time: 1e6, total: 3, io: new Map(),
    units: [scope('/a'), scope('/b'), scope('/c', { id: 'Ended' })],
};
const after = {
    time: 3e6, total: 3,
    io: new Map([['/a', { read: 1500, write: 500 }], ['/d', { read: 999999, write: 0 }]]),
    units: [
        scope('/a', { at: 3e6, cpu: 1000100, memory: 1000, pressure: [0, 600000, 0, 0, null, null] }),
        scope('/b', { at: 3e6, cpu: 500100, pressure: [0, 1100000, 0, 0, null, null] }),
        scope('/d', { at: 3e6, id: 'New', memory: null }),
    ],
};
const report = appBottlenecks(before, after);
check(report.scopes.join() === '3,2,3', 'only continuing scopes are paired');
check(report.resources[0].recent.some(row => row.id === 'Ended'), 'a scope that ended remains represented in recent pressure');
check(report.resources[0].wait[0].value === 50, 'same-app scopes use maximum pressure, not sum');
check(report.resources[0].usage[0].value === 75, 'same-app CPU usage adds across scopes');
check(report.resources[1].usage[0].value === 1200, 'memory charge aggregates point-in-time observations');
check(report.estimated && report.resources[2].usage[0].value === 1000, 'estimated disk throughput is normalized by measured elapsed time');
check(report.resources[2].coverage.join() === '0,0,1' && report.resources[1].wait.length === 0, 'missing counters and measured zero do not become ranked readings');
check(appBottlenecks(before, { ...after, time: 60e6 }) === null, 'a delayed pair is not attributed to the trigger');

after.units[1].inode++;
after.units[0].pressure[1] = 0;
check(appBottlenecks(before, after).resources[0].coverage.join() === '3,0,1',
    'counter reset and replaced inode drop the interval independently');

check(!appBottlenecks(before, { ...after, io: new Map() }).estimated, 'missing process pairs do not imply estimated coverage');
const idleIo = appBottlenecks(before, { ...after, io: new Map([['/a', { read: 0, write: 0 }]]) });
check(idleIo.estimated && idleIo.resources[2].coverage[2] === 1 && idleIo.resources[2].usage.length === 0,
    'readable zero I/O is covered without producing a ranking');

const root = GLib.dir_make_tmp('rp-app-wait-XXXXXX');
const slice = `${root}/app.slice`;
const path = `${slice}/app-gnome-org.example.Browser-100.scope`;
const proc = `${root}/proc`;
const pids = [42001, 42002, 42003];
const files = {
    'cpu.stat': 'usage_usec 100\n',
    'cpu.pressure': 'some avg10=8.25 total=12000\n',
    'io.stat': '8:0 rbytes=100 wbytes=50\n',
};
try {
    GLib.mkdir_with_parents(path, 0o700);
    for (const [name, value] of Object.entries(files)) GLib.file_set_contents(`${path}/${name}`, value);
    const sampler = new AppBottleneckSampler({ session: root });
    const initial = await sampler.begin();
    check(initial.units.length === 1 && initial.units[0].id === 'org.example.Browser', 'recurses through slices and identifies app scopes');
    check(initial.units[0].pressure[0] === 8.25 && initial.units[0].pressure[1] === 12000 &&
        initial.units[0].io === 150 && initial.units[0].memory === null, 'reads available counters independently');
    GLib.file_set_contents(`${path}/io.stat`, '8:0 rbytes=102 wbytes=52\n');
    const end = await sampler.end(initial);
    check(end.units[0].inode === initial.units[0].inode && end.units[0].io === 154, 'same scope has a stable identity and new counters');
    GLib.unlink(`${path}/io.stat`);
    GLib.file_set_contents(`${path}/cgroup.procs`, '42001\n42002\n');
    const procIo = (pid, start, read) => {
        const dir = `${proc}/${pid}`;
        GLib.mkdir_with_parents(dir, 0o700);
        const stat = ['R', ...Array(18).fill('0'), start].join(' ');
        GLib.file_set_contents(`${dir}/stat`, `${pid} (a) ${stat}`);
        GLib.file_set_contents(`${dir}/io`, `read_bytes: ${read}\nwrite_bytes: 0\n`);
    };
    procIo(42001, 10, 100);
    procIo(42002, 20, 100);
    const processSampler = new AppBottleneckSampler({ session: root, proc });
    const ioBefore = await processSampler.begin();
    procIo(42001, 10, 150);
    procIo(42002, 21, 500);
    procIo(42003, 5, 5000);
    GLib.file_set_contents(`${path}/cgroup.procs`, '42001\n42001\n42002\n42003\n');
    const ioAfter = await processSampler.end(ioBefore);
    check(ioAfter.io.get(path)?.read === 50, 'duplicate, reused and joining PIDs cannot inflate incident I/O');
    processSampler.cancel();
    const pending = sampler.begin();
    sampler.cancel();
    check(await pending === null && await sampler.end(initial) === null, 'cancellation rejects pending and stale pairs');
} finally {
    for (const pid of pids) {
        const dir = `${proc}/${pid}`;
        GLib.unlink(`${dir}/stat`);
        GLib.unlink(`${dir}/io`);
        GLib.rmdir(dir);
    }
    GLib.rmdir(proc);
    GLib.unlink(`${path}/cgroup.procs`);
    for (const name of Object.keys(files)) GLib.unlink(`${path}/${name}`);
    GLib.rmdir(path);
    GLib.rmdir(slice);
    GLib.rmdir(root);
}
print(`app bottlenecks: ${passed} passed`);
