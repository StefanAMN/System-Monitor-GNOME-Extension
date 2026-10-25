#!/usr/bin/env gjs -m
// What one usage-tracking sample costs, reading by reading, on this machine:
// CPU time of the whole process (every thread: GIO's asynchronous reads run
// on worker threads) and wall time, averaged over N samples.
//
//   gjs -m tests/bench/tracker_cost.js [samples]
//
// Every reading is forced to read everything (no idle-unit shortcuts), the
// worst case of a sample where every app ran.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { AppUsageSampler } from '../../src/lib/collectors/appusage.js';
import { GpuUsageSampler } from '../../src/lib/collectors/gpuusage.js';
import { AppIoSampler } from '../../src/lib/collectors/appio.js';
import { MachineUsageSampler } from '../../src/lib/collectors/machineusage.js';
import { NetworkSampler } from '../../src/lib/collectors/network.js';
import { ThermalSampler } from '../../src/lib/collectors/thermal.js';
import { PowerSampler } from '../../src/lib/collectors/power.js';
import { BatterySampler } from '../../src/lib/collectors/battery.js';
import { BatteryLedger } from '../../src/lib/engine/batteryledger.js';

const N = Number(ARGV[0] ?? 40);

/** CPU ns of every thread of this process, from schedstat. */
function cpuNs() {
    let ns = 0;
    const en = Gio.File.new_for_path('/proc/self/task').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = en.next_file(null); info; info = en.next_file(null)) {
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/self/task/${info.get_name()}/schedstat`);
            ns += Number(new TextDecoder().decode(bytes).split(' ')[0]);
        } catch {
            // a worker thread that ended meanwhile
        }
    }
    en.close(null);
    return ns;
}

async function measure(name, fn) {
    await fn(); // warm-up: JIT, caches, first-call baselines
    const c0 = cpuNs();
    const t0 = GLib.get_monotonic_time();
    for (let i = 0; i < N; i++) await fn(i);
    const cpu = (cpuNs() - c0) / N / 1e6;
    const wall = (GLib.get_monotonic_time() - t0) / N / 1000;
    print(`${name.padEnd(34)} ${cpu.toFixed(2).padStart(7)} ms CPU  ${wall.toFixed(2).padStart(7)} ms wall`);
    return cpu;
}

const loop = new GLib.MainLoop(null, false);
(async () => {
    const usage = new AppUsageSampler();
    const first = await usage.sample({ withPids: true, withMemory: true });
    const pids = first.units.reduce((n, u) => n + (u.pids?.length ?? 0), 0);
    print(`${first.units.length} session units, ${pids} processes in them; ${N} samples each\n`);
    let total = 0;
    // Every unit read whole each time: a fresh sampler has no idle cache.
    total += await measure('apps: CPU, processes, memory', () => new AppUsageSampler().sample({ withPids: true, withMemory: true }));
    const unitPids = new Map(first.units.map(u => [u.unit, u.pids ?? []]));
    const gpu = new GpuUsageSampler();
    total += await measure('apps: GPU time (fdinfo)', () => gpu.sample(unitPids));
    const io = new AppIoSampler();
    total += await measure('apps: disk bytes (/proc/<pid>/io)', () => {
        io.reset();
        return io.sample(first.units);
    });
    const machine = new MachineUsageSampler();
    total += await measure('machine: memory, swap, stall, disks', () => machine.sample());
    const net = new NetworkSampler();
    total += await measure('network', () => net.sample());
    const thermal = new ThermalSampler();
    total += await measure('temperature', () => thermal.sample(false));
    const power = new PowerSampler();
    total += await measure('processor power (RAPL)', () => power.sample());
    const battery = new BatterySampler();
    total += await measure('battery', () => battery.sample());

    // The ledger: one sample in, and the hourly save's serialisation.
    const ledger = new BatteryLedger();
    const units = first.units;
    let mono = 1e9;
    let wall = Date.now() - N * 30e3;
    total += await measure('ledger: ingest one sample', () => {
        mono += 30e6;
        wall += 30e3;
        ledger.ingest({ mono, wall, usage: { total: mono, system: mono / 10, units }, packageW: 5, battery: null, machine: null, net: null });
    });
    const full = new BatteryLedger();
    for (let h = 0; h < 14 * 24; h++) {
        full.ingest({ mono: 1e9 + h * 3600e6, wall: Date.now() - (14 * 24 - h) * 3600e3, usage: { total: h * 1e9, system: h * 1e8, units }, packageW: 5, battery: null });
    }
    await measure('ledger: serialise (hourly save)', () => JSON.stringify(full));
    print(`\nper sample, every 30 s: ${total.toFixed(2)} ms CPU = ${(total / 30000 * 100).toFixed(3)} % of one core`);
    loop.quit();
})().catch(e => {
    print(`failed: ${e.message}\n${e.stack}`);
    loop.quit();
});
loop.run();
