// GPU accounting, cache invalidation and main-loop scheduling regressions.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { GpuUsageSampler } from '../../src/lib/collectors/gpuusage.js';
import { parseNvidiaSmi } from '../../src/lib/collectors/gpu.js';
import { gpuReadings, powerReadout } from '../../src/lib/common/present.js';

let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}
function removeTree(path) {
    if (GLib.file_test(path, GLib.FileTest.IS_DIR) && !GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) {
        const dir = GLib.Dir.open(path, 0);
        try {
            for (let name = dir.read_name(); name !== null; name = dir.read_name()) removeTree(`${path}/${name}`);
        } finally {
            dir.close();
        }
        GLib.rmdir(path);
    } else GLib.unlink(path);
}
function fdCount() {
    let count = 0;
    const dir = GLib.Dir.open('/proc/self/fd', 0);
    try {
        while (dir.read_name() !== null) count++;
    } finally {
        dir.close();
    }
    return count;
}

async function run() {
    const nv = parseNvidiaSmi('GPU, 580, 10, 0, 45, 4096, 8192, 50, 1000, 2000, 35');
    check(nv.memPercent === 50, 'VRAM occupancy uses allocated bytes, independent of memory bus activity');
    check(gpuReadings(nv).fan === '35%', 'NVIDIA fan percentage keeps its unit');
    check(gpuReadings({ fanSpeed: 0, fanUnit: 'rpm' }).fan === '0 RPM', 'a stopped hwmon fan remains a real reading');
    check(gpuReadings({ fanSpeed: 1000 }).fan === '1000 RPM', 'legacy fan snapshots default to RPM');
    check(powerReadout({ raplSupported: true, packagePower: null }).value === null, 'RAPL warmup is unavailable rather than zero');
    check(powerReadout({ raplSupported: true, packagePower: 0 }).value === 0, 'a measured zero remains available');
    check(powerReadout({ systemPower: NaN, raplSupported: true, packagePower: 8 }).value === 8, 'invalid system power cannot mask a valid package sample');

    const root = GLib.dir_make_tmp('rp-gpu-audit-XXXXXX');
    const write = (path, text) => GLib.file_set_contents(`${root}/${path}`, text);
    const identity = (pid, start) => {
        const fields = new Array(22).fill('0');
        fields[0] = 'S';
        fields[19] = String(start);
        write(`${pid}/stat`, `${pid} (GPU app) ${fields.join(' ')}\n`);
    };
    const process = (pid, start = 1) => {
        GLib.mkdir_with_parents(`${root}/${pid}/fd`, 0o700);
        GLib.mkdir_with_parents(`${root}/${pid}/fdinfo`, 0o700);
        identity(pid, start);
    };
    const client = (pid, fd, id, ns) => {
        Gio.File.new_for_path(`${root}/${pid}/fd/${fd}`).make_symbolic_link('/dev/dri/renderD128', null);
        write(`${pid}/fdinfo/${fd}`, `drm-driver: i915\ndrm-pdev: 0000:00:02.0\ndrm-client-id: ${id}\ndrm-engine-render: ${ns} ns\n`);
    };
    try {
        process(123);
        const sampler = new GpuUsageSampler(root);
        const units = new Map([['a.scope', [123]]]);
        check((await sampler.sample(units)).size === 0, 'empty GPU cache begins empty');
        client(123, 3, 7, 1e9);
        sampler._pids.get(123).scanned -= 5e6;
        check((await sampler.sample(units)).get('a.scope') === 1e9, 'a process opening its first GPU descriptor is found after the short negative cache expires');
        client(123, 4, 8, 2e9);
        sampler._pids.get(123).scanned -= 60e6;
        check((await sampler.sample(units)).get('a.scope') === 3e9, 'active caches discover added clients within one minute');
        GLib.unlink(`${root}/123/fd/3`);
        Gio.File.new_for_path(`${root}/123/fd/3`).make_symbolic_link('/dev/null', null);
        write('123/fdinfo/3', 'pos: 0\n');
        client(123, 5, 9, 3e9);
        identity(123, 2);
        check((await sampler.sample(units)).get('a.scope') === 6e9, 'PID reuse forces rediscovery even when cached descriptor numbers remain open');
        client(123, 6, 10, 4e9);
        write('123/fdinfo/4', 'pos: 0\n');
        await sampler.sample(units);
        check((await sampler.sample(units)).get('a.scope') === 10e9, 'a replaced non-DRM descriptor invalidates the cache');

        process(789);
        client(789, 3, 99, 2e9);
        client(789, 4, 99, 1e9);
        const dup = new GpuUsageSampler(root);
        const duplicate = new Map([['dup.scope', [789]]]);
        check((await dup.sample(duplicate)).get('dup.scope') === 2e9, 'duplicated clients use the largest counter regardless of descriptor order');
        check((await dup.sample(duplicate)).get('dup.scope') === 2e9, 'an older duplicate cannot lower the baseline and recount GPU time');
        write('789/fdinfo/3', 'drm-driver: i915\ndrm-pdev: 0000:00:02.0\ndrm-client-id: 99\ndrm-engine-render: 3000000000 ns\n');
        check((await dup.sample(duplicate)).get('dup.scope') === 3e9, 'a later larger duplicate adds only the new GPU time');
        dup.cancel();

        process(456);
        for (let fd = 0; fd < 512; fd++)
            Gio.File.new_for_path(`${root}/456/fd/${fd}`).make_symbolic_link('/dev/null', null);
        const huge = new GpuUsageSampler(root);
        const before = fdCount();
        const pending = huge.sample(new Map([['huge.scope', [456]]]));
        let yielded = false;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            yielded = huge._idleId !== 0 && fdCount() > before;
            huge.cancel();
            return GLib.SOURCE_REMOVE;
        });
        check((await pending).size === 0 && yielded, 'one large descriptor table yields to the main loop before completion');
        check(fdCount() === before && huge._work === null && huge._idleId === 0, 'cancelling a suspended descriptor walk closes its directory handle');
        check((await huge.sample(new Map([['huge.scope', [456]]]))).size === 0, 'a cancelled scan can be sampled again');
        sampler.cancel();
        huge.cancel();
    } finally {
        removeTree(root);
    }
    print(`GPU audit: ${passed} passed`);
}
const loop = new GLib.MainLoop(null, false);
let failed = false;
run().catch(e => {
    failed = true;
    printerr(`${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
if (failed) System.exit(1);
