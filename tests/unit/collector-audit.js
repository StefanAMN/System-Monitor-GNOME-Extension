// Regression fixtures for per-app counter identity, membership and RAPL availability.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { AppIoSampler } from '../../src/lib/collectors/appio.js';
import { AppUsageSampler } from '../../src/lib/collectors/appusage.js';
import { PowerSampler } from '../../src/lib/collectors/power.js';

let passed = 0;
function eq(actual, expected, description) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${description}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    passed++;
}
const loop = new GLib.MainLoop(null, false);
const root = GLib.dir_make_tmp('rp-collector-audit-XXXXXX');
const mkdir = path => GLib.mkdir_with_parents(`${root}/${path}`, 0o700);
const write = (path, value) => GLib.file_set_contents(`${root}/${path}`, value);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function run() {
    const stat = (pid, start) => {
        const fields = new Array(22).fill('0');
        fields[0] = 'S';
        fields[19] = String(start);
        write(`${pid}/stat`, `${pid} (non ASCII é (worker)) ${fields.join(' ')}\n`);
    };
    const io = (pid, start, read, written = 0) => {
        mkdir(String(pid));
        stat(pid, start);
        write(`${pid}/io`, `read_bytes: ${read}\nwrite_bytes: ${written}\n`);
    };
    const units = pids => [{ unit: 'a.scope', usec: 100, pids }];
    const sampler = new AppIoSampler(root);
    io(70000, 10, 100);
    eq([...await sampler.sample(units([70000]))], [], 'first I/O sample establishes baseline');
    io(70000, 10, 110);
    eq([...await sampler.sample(units([70000]))], [['a.scope', { read: 10, write: 0 }]], 'I/O advances even with unchanged CPU time');
    if (Gio.Credentials.new().get_unix_user() !== 0) {
        GLib.chmod(`${root}/70000/io`, 0);
        eq([...await sampler.sample(units([70000]))], [], 'permission failure leaves out the unreadable measurement');
        eq(sampler.denied, 1, 'permission failure remains visible');
        GLib.chmod(`${root}/70000/io`, 0o600);
        io(70000, 10, 120);
        eq([...await sampler.sample(units([70000]))], [['a.scope', { read: 10, write: 0 }]], 'permission recovery preserves baseline');
    }
    // Reused PID can have a higher counter, so falling counters are insufficient.
    io(70000, 20, 1000);
    eq([...await sampler.sample(units([70000]))], [['a.scope', { read: 1000, write: 0 }]], 'PID reuse is detected by start time');
    io(70000, 20, 1005);
    eq([...await sampler.sample([{ unit: 'b.scope', usec: 100, pids: [70000] }])], [], 'process migration establishes a new attribution baseline');
    io(70000, 20, 1010);
    eq([...await sampler.sample([{ unit: 'b.scope', usec: 100, pids: [70000] }])], [['b.scope', { read: 5, write: 0 }]], 'migrated process counts only its new units I/O');
    eq([...await sampler.sample([])], [], 'empty membership forgets exited processes');
    eq(sampler._prev.size, 0, 'I/O baseline retention remains bounded');
    io(123, 1, 100);
    const pending = sampler.sample(units([123]));
    sampler.cancel();
    eq([...await pending], [], 'cancellation resolves without committing partial counters');

    const unknown = new AppIoSampler(root);
    io(456, 1, 100);
    const read = unknown._read;
    unknown._read = () => null;
    await unknown.sample(units([456]));
    unknown._read = read;
    eq([...await unknown.sample(units([456]))], [], 'initially unreadable process first successful read is a baseline');

    mkdir('session/a.scope');
    write('cpu.stat', 'usage_usec 100\n');
    write('session/a.scope/cpu.stat', 'usage_usec 1\n');
    write('session/a.scope/cgroup.procs', '123\n');
    const usage = new AppUsageSampler({ mount: root, session: `${root}/session` });
    eq((await usage.sample({ withPids: true })).units[0].pids, [123], 'membership initially read');
    write('session/a.scope/cgroup.procs', '456\n');
    eq((await usage.sample({ withPids: true })).units[0].pids, [456], 'unchanged CPU time does not freeze membership');
    let release;
    usage._sessionRoot = () => new Promise(resolve => { release = resolve; });
    const held = usage.sample();
    usage.cancel();
    release(`${root}/session`);
    eq((await held).units, [], 'cancellation during root discovery does not schedule idle work');
    eq(usage._idleId, 0, 'root discovery cancellation leaves no source');

    mkdir('power/intel-rapl:0');
    const zone = 'power/intel-rapl:0';
    write(`${zone}/name`, 'package-0\n');
    write(`${zone}/energy_uj`, '1000000\n');
    write(`${zone}/max_energy_range_uj`, '1000000000\n');
    const power = new PowerSampler(`${root}/power`);
    let got = await power.sample();
    eq([got.raplSupported, got.packagePower, got.warmingUp], [true, null, true], 'RAPL discovery has no measured power before a baseline');
    await sleep(10);
    write(`${zone}/energy_uj`, '1100000\n');
    got = await power.sample();
    eq(Number.isFinite(got.packagePower) && got.packagePower > 0, true, 'valid RAPL pair yields measured watts');
    GLib.unlink(`${root}/${zone}/energy_uj`);
    got = await power.sample();
    eq([got.raplSupported, got.packagePower, got.packageSamples], [true, null, 0], 'failed counter read is unavailable rather than measured zero');
    write(`${zone}/energy_uj`, '1200000\n');
    got = await power.sample();
    eq([got.packagePower, got.warmingUp], [null, true], 'RAPL recovery first renews the baseline');
    await sleep(10);
    got = await power.sample();
    eq(got.packagePower, 0, 'a valid unchanged counter genuinely measures zero watts');
    write(`${zone}/energy_uj`, 'not an energy counter\n');
    eq((await power.sample()).packagePower, null, 'malformed counter is not parsed as zero');
    write(`${zone}/energy_uj`, '1300000\n');
    await power.sample();
    mkdir('power/intel-rapl:1');
    write('power/intel-rapl:1/energy_uj', '3000000\n');
    power._packageCount = 2;
    power._raplPaths.push({ baseDir: 'second-package', energyPath: `${root}/power/intel-rapl:1/energy_uj`, maxRange: 1e9 });
    got = await power.sample();
    eq([got.packagePower, got.packagePartial, got.packageSamples, got.packageCount], [null, true, 1, 2], 'partial package availability does not under-report total watts');
    print(`${passed} collector audit checks passed`);
}
let failed = false;
run().catch(e => { printerr(e.stack); failed = true; }).finally(() => {
    Gio.Subprocess.new(['rm', '-rf', root], Gio.SubprocessFlags.NONE).wait(null);
    loop.quit();
});
loop.run();
if (failed) System.exit(1);
