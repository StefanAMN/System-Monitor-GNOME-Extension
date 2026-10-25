// The battery ledger: turns readings of per-app CPU time, CPU package energy
// and battery energy into hourly totals per app, kept for 14 days.
//
// Attribution is an estimate. CPU package energy above an idle baseline is
// shared among apps by CPU time; the baseline ("idle and platform") and all
// battery energy the package does not account for (display, radios, the
// rest) are not given to any app. Without readable package energy only CPU
// time is recorded.
//
// Since version 2 each hour also holds what the diagnostics need beyond the
// battery: memory per app and for the machine, swap traffic, stall times,
// network bytes and the time the user was away; later version 2 files also
// disk bytes per app and for the machine, and the processor temperature.
// Fields a file lacks read as 0 (no data), so older files still load.
//
// Engine layer: no widgets; file I/O only in loadLedger / saveLedger.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { counterDelta } from '../collectors/network.js';

export const LEDGER_VERSION = 2;
const READABLE_VERSIONS = [1, 2];
export const DAYS_KEPT = 14;
// One bucket per hour and power source (AC / battery): fixed upper bound.
export const MAX_BUCKETS = DAYS_KEPT * 24 * 2;
// Apps kept per bucket once it is closed; the rest are summed into MORE.
export const APPS_PER_BUCKET = 30;
// While a bucket is open it may hold more, so a late heavy app is not
// lumped in with the rest; still bounded.
const OPEN_BUCKET_APPS = 2 * APPS_PER_BUCKET;
// Of the apps kept, up to this many are the largest by memory, so an app that
// holds memory without using the CPU is not lumped in with the rest.
export const MEMORY_PLACES = 10;
// An app holding less is not recorded for memory (session services, helpers).
export const MEMORY_MIN_MIB = 16;
const MIB = 1024 * 1024;
const HOUR_MS = 3600 * 1000;

// Five-minute totals for the charts' finer bars: machine figures only (no
// apps), for the last 48 hours, AC and battery apart like the hourly ones.
export const FINE_MS = 5 * 60 * 1000;
export const FINE_KEPT_MS = 48 * HOUR_MS;
export const MAX_FINE = (FINE_KEPT_MS / FINE_MS) * 2;
// Fields a five-minute bucket sums, as the hourly bucket does; and the
// highest values it keeps.
const FINE_SUMS = ['s', 'bw', 'pw', 'iw', 'gw', 'hs', 'uw', 'gpu', 'cpu', 'ms', 'mu', 'si', 'so', 'ps', 'pc', 'pm', 'pf', 'pi',
    'ns', 'rx', 'tx', 'is', 'ir', 'it', 'ds', 'dr', 'dw', 'tt', 'ta'];
const FINE_MAXES = ['mx', 'mt', 'sx', 'st', 'tm'];

// Pseudo-app ids. They cannot clash with desktop ids, which never start with '@'.
export const SYSTEM = '@system'; // system services (system.slice)
export const OTHER = '@other'; // kernel, other users: machine total minus everything named
export const MORE = '@more'; // apps beyond APPS_PER_BUCKET in a closed bucket

// A gap longer than this between two samples is not attributed: the
// extension was disabled (screen lock) or the machine slept.
export const MAX_SAMPLE_GAP_S = 120;
// Package power samples the idle baseline is learnt from (2 h at 30 s).
const BASELINE_SAMPLES = 240;
const BASELINE_MIN_SAMPLES = 20;
const BASELINE_PERCENTILE = 0.1;

/** Low percentile of the last BASELINE_SAMPLES values, in fixed buffers. */
class LowPercentile {
    constructor() {
        this._values = new Float64Array(BASELINE_SAMPLES);
        this._scratch = new Float64Array(BASELINE_SAMPLES);
        this._count = 0;
        this._head = 0;
    }

    /** @returns {?number} the percentile, or null while there are too few values */
    add(value) {
        this._values[this._head] = value;
        this._head = (this._head + 1) % BASELINE_SAMPLES;
        if (this._count < BASELINE_SAMPLES) this._count++;
        if (this._count < BASELINE_MIN_SAMPLES) return null;
        const scratch = this._scratch.subarray(0, this._count);
        scratch.set(this._values.subarray(0, this._count));
        scratch.sort();
        return scratch[Math.floor(this._count * BASELINE_PERCENTILE)];
    }
}

export class LedgerFormatError extends Error {}

function hourStart(wallMs) {
    const d = new Date(wallMs);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}

function emptyBucket(start, onBattery) {
    // s: seconds covered; bw: battery Wh delivered; pw: CPU package Wh;
    // iw: of which idle baseline; gw: battery Wh over gaps (locked, asleep);
    // hs: seconds the CPU was above the temperature alert;
    // uw: graphics Wh shared by GPU time (part of pw); gpu: GPU busy ns of named units;
    // cpu: machine CPU µs; a: id -> [cpu µs, foreground cpu µs, Wh, GPU ns, memory MiB·s, max memory MiB,
    //   disk bytes read, disk bytes written]
    // Since version 2: ms: seconds memory was read over; mu: memory in use MiB·s; mx: its max MiB;
    // mt: installed MiB; sx: swap in use, max MiB; st: swap size MiB; si / so: MiB swapped in / out;
    // ps: seconds stall times were read over; pc, pm, pf, pi: seconds stalled on CPU, memory
    // (some, full) and I/O; ns: seconds network was read over; rx / tx: bytes;
    // is: seconds the user was away; ir / it: bytes while away;
    // ds: seconds disks were read over; dr / dw: bytes the physical disks read / wrote;
    // tt: seconds the temperature was read over; tm: highest °C; ta: °C·s (time-weighted average × tt).
    return {
        t: start, b: onBattery, s: 0, bw: 0, pw: 0, iw: 0, gw: 0, hs: 0, uw: 0, gpu: 0, cpu: 0, energy: false, a: {},
        ms: 0, mu: 0, mx: 0, mt: 0, sx: 0, st: 0, si: 0, so: 0,
        ps: 0, pc: 0, pm: 0, pf: 0, pi: 0, ns: 0, rx: 0, tx: 0, is: 0, ir: 0, it: 0,
        ds: 0, dr: 0, dw: 0, tt: 0, tm: 0, ta: 0,
    };
}

export class BatteryLedger {
    constructor(state = null) {
        this.buckets = state?.buckets ?? [];
        this.fine = Array.isArray(state?.fine) ? state.fine : [];
        this.baselineW = state?.baselineW ?? null;
        this.uncoreBaselineW = state?.uncoreBaselineW ?? null;
        this._prevGpu = null;
        this._uncoreLow = new LowPercentile();
        // Counters of the previous sample, by unit; not persisted (they are
        // meaningless in another process).
        this._prevUnits = null;
        this._prevMono = 0;
        this._prevWall = 0;
        this._prevTotal = null;
        this._prevSystem = null;
        this._prevMachine = null;
        this._prevNet = null;
        this._prevDisks = null;
        this._prevBatteryWh = state?.last?.batteryWh ?? null;
        this._lastSeenWall = state?.last?.wall ?? null;
        this._packageLow = new LowPercentile();
        this.loadedVersion = LEDGER_VERSION;
    }

    /** Parse a saved ledger. @throws {LedgerFormatError} */
    static fromJSON(text) {
        let obj;
        try {
            obj = JSON.parse(text);
        } catch (e) {
            throw new LedgerFormatError(`not JSON: ${e.message}`);
        }
        if (!READABLE_VERSIONS.includes(obj?.version))
            throw new LedgerFormatError(`version ${obj?.version} is not one of ${READABLE_VERSIONS.join(', ')}`);
        if (!Array.isArray(obj.buckets) || !obj.buckets.every(b => Number.isFinite(b?.t) && typeof b.a === 'object'))
            throw new LedgerFormatError('buckets are malformed');
        // Five-minute totals are optional (newer files); bad ones are dropped, not fatal.
        if (obj.fine !== undefined && !(Array.isArray(obj.fine) && obj.fine.every(b => Number.isFinite(b?.t)))) obj.fine = [];
        const ledger = new BatteryLedger(obj);
        ledger.loadedVersion = obj.version;
        return ledger;
    }

    toJSON() {
        return {
            version: LEDGER_VERSION,
            baselineW: this.baselineW,
            uncoreBaselineW: this.uncoreBaselineW,
            last: { wall: this._prevWall || this._lastSeenWall, batteryWh: this._prevBatteryWh },
            buckets: this.buckets,
            fine: this.fine,
        };
    }

    clear() {
        this.buckets = [];
        this.fine = [];
    }

    /** The five-minute bucket for `wallMs` (created, older ones pruned). */
    _fineBucket(wallMs, onBattery) {
        const start = Math.floor(wallMs / FINE_MS) * FINE_MS;
        const last = this.fine[this.fine.length - 1];
        if (last && last.t === start && last.b === onBattery) return last;
        let bucket = this.fine.find(b => b.t === start && b.b === onBattery);
        if (!bucket) {
            bucket = { t: start, b: onBattery, energy: false };
            for (const key of [...FINE_SUMS, ...FINE_MAXES]) bucket[key] = 0;
            this.fine.push(bucket);
            const oldest = start - FINE_KEPT_MS;
            if (this.fine[0].t <= oldest) this.fine = this.fine.filter(b => b.t > oldest);
            if (this.fine.length > MAX_FINE) this.fine.splice(0, this.fine.length - MAX_FINE);
        }
        return bucket;
    }

    /**
     * Forget the previous sample (tracking was switched off): the next
     * sample starts afresh instead of reporting the time in between as a gap.
     */
    forgetLast() {
        this._prevUnits = null;
        this._prevGpu = null;
        this._prevMachine = null;
        this._prevNet = null;
        this._prevDisks = null;
        this._prevBatteryWh = null;
        this._lastSeenWall = null;
        this._prevWall = 0;
    }

    /** Give a bucket loaded from an older file the fields it lacks. */
    _upgrade(bucket) {
        if (bucket.ms === undefined)
            Object.assign(bucket, { ms: 0, mu: 0, mx: 0, mt: 0, sx: 0, st: 0, si: 0, so: 0, ps: 0, pc: 0, pm: 0, pf: 0, pi: 0, ns: 0, rx: 0, tx: 0, is: 0, ir: 0, it: 0 });
        if (bucket.ds === undefined) Object.assign(bucket, { ds: 0, dr: 0, dw: 0, tt: 0, tm: 0, ta: 0 });
    }

    _bucket(wallMs, onBattery) {
        const start = hourStart(wallMs);
        const last = this.buckets[this.buckets.length - 1];
        if (last && last.t === start && last.b === onBattery) return last;
        let bucket = this.buckets.find(b => b.t === start && b.b === onBattery);
        if (!bucket) {
            // A new hour closes the open buckets of the previous one.
            for (const b of this.buckets) if (b.t < start) this._closeBucket(b);
            bucket = emptyBucket(start, onBattery);
            this.buckets.push(bucket);
            this._prune(wallMs);
        }
        return bucket;
    }

    /**
     * Keep APPS_PER_BUCKET apps of a bucket: up to MEMORY_PLACES of the largest
     * by memory, the rest the largest by energy and CPU time. The others are
     * summed into MORE.
     */
    _closeBucket(bucket) {
        const ids = Object.keys(bucket.a).filter(id => !id.startsWith('@'));
        if (ids.length <= APPS_PER_BUCKET) return;
        const keep = new Set(ids.filter(id => (bucket.a[id][5] ?? 0) > 0)
            .sort((x, y) => bucket.a[y][5] - bucket.a[x][5]).slice(0, MEMORY_PLACES));
        ids.sort((x, y) => (bucket.a[y][2] - bucket.a[x][2]) || (bucket.a[y][0] - bucket.a[x][0]));
        for (const id of ids) {
            if (keep.size >= APPS_PER_BUCKET) break;
            keep.add(id);
        }
        for (const id of ids) {
            if (keep.has(id)) continue;
            const [cpu, fg, wh, gpu = 0, mibS = 0, maxMib = 0, read = 0, written = 0] = bucket.a[id];
            const more = this._add(bucket, MORE, cpu, fg, wh, gpu, true);
            // The rest's max is the sum of theirs: an upper bound.
            more[4] += mibS;
            more[5] += maxMib;
            more[6] += read;
            more[7] += written;
            delete bucket.a[id];
        }
    }

    _prune(wallMs) {
        const oldest = hourStart(wallMs) - DAYS_KEPT * 24 * HOUR_MS;
        this.buckets = this.buckets.filter(b => b.t > oldest);
        if (this.buckets.length > MAX_BUCKETS) this.buckets.splice(0, this.buckets.length - MAX_BUCKETS);
    }

    _add(bucket, id, cpu, fg, wh, gpu = 0, force = false) {
        let entry = bucket.a[id];
        if (!entry) {
            const named = Object.keys(bucket.a).length;
            if (!force && !id.startsWith('@') && named >= OPEN_BUCKET_APPS) return this._add(bucket, MORE, cpu, fg, wh, gpu, true);
            entry = bucket.a[id] = [0, 0, 0, 0, 0, 0, 0, 0];
        }
        entry[0] += cpu;
        entry[1] += fg;
        entry[2] += wh;
        // Entries saved before GPU time was recorded have three fields, before
        // memory was recorded four, before disk bytes six.
        entry[3] = (entry[3] ?? 0) + gpu;
        entry[4] ??= 0;
        entry[5] ??= 0;
        entry[6] ??= 0;
        entry[7] ??= 0;
        return entry;
    }

    /** Disk bytes per app (summed over its units) since the previous reading. */
    _addAppIo(bucket, units, appIo) {
        if (!appIo || appIo.size === 0) return;
        const idOf = new Map(units.map(u => [u.unit, u.id]));
        for (const [unit, { read, write }] of appIo) {
            const id = idOf.get(unit);
            if (id === undefined) continue;
            const entry = this._add(bucket, id, 0, 0, 0);
            entry[6] += read;
            entry[7] += write;
        }
    }

    /** Bytes the physical disks read and wrote since the previous reading. */
    _addDisks(bucket, disks, prev, dt) {
        if (!disks || !prev) return;
        let read = 0;
        let written = 0;
        for (const { name, readBytes, writtenBytes } of disks) {
            const before = prev.get(name);
            // A disk attached since the last reading counts from the next one.
            if (!before) continue;
            read += counterDelta(readBytes, before.read);
            written += counterDelta(writtenBytes, before.written);
        }
        bucket.ds += dt;
        bucket.dr += read;
        bucket.dw += written;
    }

    /** Memory of each app (summed over its units) and of the machine over `dt` seconds. */
    _addMemory(bucket, units, machine, dt) {
        const perApp = new Map();
        for (const u of units) {
            if (Number.isFinite(u.memory)) perApp.set(u.id, (perApp.get(u.id) ?? 0) + u.memory);
        }
        for (const [id, bytes] of perApp) {
            const mib = bytes / MIB;
            if (mib < MEMORY_MIN_MIB) continue;
            const entry = this._add(bucket, id, 0, 0, 0);
            entry[4] += mib * dt;
            entry[5] = Math.max(entry[5], mib);
        }
        if (Number.isFinite(machine?.memUsed) && Number.isFinite(machine.memTotal)) {
            bucket.ms += dt;
            bucket.mu += machine.memUsed / MIB * dt;
            bucket.mx = Math.max(bucket.mx, machine.memUsed / MIB);
            bucket.mt = Math.max(bucket.mt, machine.memTotal / MIB);
        }
        if (Number.isFinite(machine?.swapUsed) && Number.isFinite(machine.swapTotal)) {
            bucket.sx = Math.max(bucket.sx, machine.swapUsed / MIB);
            bucket.st = Math.max(bucket.st, machine.swapTotal / MIB);
        }
    }

    /** Swap traffic and stall times since the previous reading. */
    _addCounters(bucket, machine, prev, dt) {
        if (!machine || !prev) return;
        const delta = (cur, before) => (Number.isFinite(cur) && Number.isFinite(before) ? counterDelta(cur, before) : null);
        const swapIn = delta(machine.swapInBytes, prev.swapInBytes);
        const swapOut = delta(machine.swapOutBytes, prev.swapOutBytes);
        if (swapIn !== null) bucket.si += swapIn / MIB;
        if (swapOut !== null) bucket.so += swapOut / MIB;
        const p = machine.pressure;
        const q = prev.pressure;
        if (p && q) {
            // µs stalled; never more than the interval (a counter reset reads as 0).
            const stall = key => Math.min(dt, (delta(p[key], q[key]) ?? 0) / 1e6);
            bucket.ps += dt;
            bucket.pc += stall('cpu');
            bucket.pm += stall('memory');
            bucket.pf += stall('memoryFull');
            bucket.pi += stall('io');
        }
    }

    /** Network bytes since the previous reading; with `idle`, also counted as while away. */
    _addNetwork(bucket, net, prev, dt, idle) {
        if (!net || !prev) return;
        let rx = 0;
        let tx = 0;
        for (const { iface, rxBytes, txBytes } of net) {
            // An interface that appeared since the last reading counts from
            // the next one: its counters started before it was seen.
            const before = prev.get(iface);
            if (!before) continue;
            rx += counterDelta(rxBytes, before.rx);
            tx += counterDelta(txBytes, before.tx);
        }
        bucket.ns += dt;
        bucket.rx += rx;
        bucket.tx += tx;
        if (idle) {
            bucket.ir += rx;
            bucket.it += tx;
        }
    }

    /**
     * Add one sample.
     * @param {object} s
     * @param {number} s.mono monotonic µs
     * @param {number} s.wall wall-clock ms
     * @param {object} s.usage AppUsageSampler reading ({total, system, units})
     * @param {?number} s.packageW average CPU package power since the last sample, null if unreadable
     * @param {?object} s.battery { present, onBattery, energyWh }
     * @param {Object<string, number>} [s.focusUsec] µs each app id had focus since the last sample
     * @param {boolean} [s.hot] the CPU is above the temperature alert
     * @param {?number} [s.uncoreW] average power of the package's uncore (Intel: integrated graphics), part of packageW
     * @param {?Map<string, number>} [s.gpu] cumulative GPU busy ns per unit
     * @param {?object} [s.machine] MachineUsageSampler reading
     * @param {?Array<{iface: string, rxBytes: number, txBytes: number}>} [s.net] physical interfaces
     * @param {boolean} [s.idle] the user was away (no input) through the interval
     * @param {?Map<string, {read: number, write: number}>} [s.appIo] disk bytes per unit since the
     *   previous reading (AppIoSampler)
     * @param {?number} [s.temp] the processor temperature, °C
     * @returns {boolean} whether the interval was attributed (false for the first sample and gaps)
     */
    ingest({ mono, wall, usage, packageW, battery, focusUsec = {}, hot = false, uncoreW = null, gpu = null,
        machine = null, net = null, idle = false, appIo = null, temp = null }) {
        const onBattery = !!(battery?.present && battery.onBattery);
        const batteryWh = battery?.present && Number.isFinite(battery.energyWh) ? battery.energyWh : null;
        const first = this._prevUnits === null;
        const dt = (mono - this._prevMono) / 1e6;
        const wallDt = (wall - this._prevWall) / 1000;
        // A gap: since the last save (first sample), or the timer did not
        // run (disabled, asleep: wall time moved on without monotonic time).
        const gap = first ? (this._lastSeenWall !== null) : (dt > MAX_SAMPLE_GAP_S || wallDt - dt > MAX_SAMPLE_GAP_S);
        let attributed = false;

        const bucket = this._bucket(wall, onBattery);
        // What this sample adds to the hour is added to its five minutes too.
        const hourBefore = FINE_SUMS.map(key => bucket[key] ?? 0);
        const delivered = onBattery && batteryWh !== null && this._prevBatteryWh !== null
            ? Math.max(0, this._prevBatteryWh - batteryWh) : 0;

        if (gap) {
            bucket.gw += delivered;
        } else if (!first && dt > 0 && usage.total !== null && this._prevTotal !== null) {
            attributed = true;
            bucket.s += dt;
            bucket.bw += delivered;
            if (hot) bucket.hs = (bucket.hs ?? 0) + dt;
            this._upgrade(bucket);
            if (idle) bucket.is += dt;
            this._addMemory(bucket, usage.units, machine, dt);
            this._addCounters(bucket, machine, this._prevMachine, dt);
            this._addNetwork(bucket, net, this._prevNet, dt, idle);
            this._addAppIo(bucket, usage.units, appIo);
            this._addDisks(bucket, machine?.disks, this._prevDisks, dt);
            if (Number.isFinite(temp) && temp > 0) {
                bucket.tt += dt;
                bucket.ta += temp * dt;
                bucket.tm = Math.max(bucket.tm, temp);
            }
            const totalCpu = Math.max(0, usage.total - this._prevTotal);
            bucket.cpu += totalCpu;

            // GPU busy time per unit, as deltas (a unit or GPU client that is
            // new since the last sample counts from zero).
            const gpuByApp = new Map();
            let gpuTotal = 0;
            if (gpu && this._prevGpu) {
                const idOf = new Map(usage.units.map(u => [u.unit, u.id]));
                for (const [unit, ns] of gpu) {
                    const before = this._prevGpu.get(unit);
                    const delta = before === undefined || ns < before ? ns : ns - before;
                    const id = idOf.get(unit);
                    if (delta <= 0 || id === undefined) continue;
                    gpuTotal += delta;
                    gpuByApp.set(id, (gpuByApp.get(id) ?? 0) + delta);
                }
            }

            let pool = null;
            let graphicsPool = 0;
            if (Number.isFinite(packageW)) {
                const packageWh = packageW * dt / 3600;
                const idleWh = Math.min(packageWh, (this.baselineW ?? 0) * dt / 3600);
                bucket.pw += packageWh;
                bucket.iw += idleWh;
                bucket.energy = true;
                pool = packageWh - idleWh;
                const low = this._packageLow.add(packageW);
                if (low !== null) this.baselineW = low;
                // The uncore above its own idle level goes to the apps that kept
                // the GPU busy; without GPU time it stays with the CPU share.
                if (Number.isFinite(uncoreW)) {
                    const lowUncore = this._uncoreLow.add(uncoreW);
                    if (lowUncore !== null) this.uncoreBaselineW = lowUncore;
                    if (gpuTotal > 0)
                        graphicsPool = Math.min(pool, Math.max(0, (uncoreW - (this.uncoreBaselineW ?? 0)) * dt / 3600));
                }
            }
            const cpuPool = pool !== null ? pool - graphicsPool : null;
            const whFor = cpu => (cpuPool !== null && totalCpu > 0 ? cpuPool * Math.min(1, cpu / totalCpu) : 0);
            const graphicsFor = ns => (gpuTotal > 0 ? graphicsPool * ns / gpuTotal : 0);
            bucket.uw = (bucket.uw ?? 0) + graphicsPool;
            bucket.gpu = (bucket.gpu ?? 0) + gpuTotal;

            // Per unit deltas, then summed per app id.
            let named = 0;
            const perApp = new Map();
            for (const u of usage.units) {
                const before = this._prevUnits.get(u.unit);
                // A unit born since the last sample counts from zero.
                const delta = before === undefined || u.usec < before ? u.usec : u.usec - before;
                if (delta <= 0) continue;
                named += delta;
                perApp.set(u.id, (perApp.get(u.id) ?? 0) + delta);
            }
            for (const id of gpuByApp.keys()) if (!perApp.has(id)) perApp.set(id, 0);
            for (const [id, cpu] of perApp) {
                const fg = Math.min(1, (focusUsec[id] ?? 0) / (dt * 1e6));
                const ns = gpuByApp.get(id) ?? 0;
                this._add(bucket, id, cpu, cpu * fg, whFor(cpu) + graphicsFor(ns), ns);
            }
            if (usage.system !== null && this._prevSystem !== null) {
                const sys = Math.max(0, usage.system - this._prevSystem);
                if (sys > 0) this._add(bucket, SYSTEM, sys, 0, whFor(sys));
                named += sys;
            }
            const rest = Math.max(0, totalCpu - named);
            if (rest > 0) this._add(bucket, OTHER, rest, 0, whFor(rest));
        }

        const fine = this._fineBucket(wall, onBattery);
        FINE_SUMS.forEach((key, i) => {
            fine[key] += (bucket[key] ?? 0) - hourBefore[i];
        });
        if (attributed) {
            fine.energy ||= bucket.energy;
            const highs = {
                mx: machine?.memUsed / MIB, mt: machine?.memTotal / MIB, sx: machine?.swapUsed / MIB, st: machine?.swapTotal / MIB,
                tm: Number.isFinite(temp) && temp > 0 ? temp : NaN,
            };
            for (const key of FINE_MAXES) if (Number.isFinite(highs[key])) fine[key] = Math.max(fine[key], highs[key]);
        }

        this._prevUnits = new Map(usage.units.map(u => [u.unit, u.usec]));
        if (gpu) this._prevGpu = gpu;
        this._prevMachine = machine;
        this._prevNet = net ? new Map(net.map(i => [i.iface, { rx: i.rxBytes, tx: i.txBytes }])) : null;
        this._prevDisks = machine?.disks ? new Map(machine.disks.map(d => [d.name, { read: d.readBytes, written: d.writtenBytes }])) : null;
        this._prevMono = mono;
        this._prevWall = wall;
        this._prevTotal = usage.total;
        this._prevSystem = usage.system;
        this._prevBatteryWh = batteryWh;
        this._lastSeenWall = wall;
        return attributed;
    }

    /**
     * Totals over a time range.
     * @param {object} [range]
     * @param {number} [range.from] wall ms, inclusive (bucket start)
     * @param {number} [range.to] wall ms, exclusive
     * @param {boolean} [range.batteryOnly]
     */
    summarize({ from = -Infinity, to = Infinity, batteryOnly = false } = {}) {
        const sum = {
            seconds: 0, batteryWh: 0, packageWh: 0, idleWh: 0, gapWh: 0, hotSeconds: 0, graphicsWh: 0, gpu: 0, cpu: 0, hasEnergy: false, apps: [],
            // Since version 2 (0 over hours from version 1 files; the *Seconds say how much was read).
            memSeconds: 0, memUsedMiBs: 0, memMaxMiB: 0, memTotalMiB: 0, swapMaxMiB: 0, swapTotalMiB: 0, swapInMiB: 0, swapOutMiB: 0,
            stallSeconds: 0, stall: { cpu: 0, memory: 0, memoryFull: 0, io: 0 },
            netSeconds: 0, rxBytes: 0, txBytes: 0, idleSeconds: 0, idleRxBytes: 0, idleTxBytes: 0,
            diskSeconds: 0, diskReadBytes: 0, diskWrittenBytes: 0, tempSeconds: 0, tempMax: 0, tempAvg: null,
        };
        const apps = new Map();
        let tempArea = 0;
        for (const b of this.buckets) {
            if (b.t < from || b.t >= to || (batteryOnly && !b.b)) continue;
            sum.seconds += b.s;
            sum.batteryWh += b.bw;
            sum.packageWh += b.pw;
            sum.idleWh += b.iw;
            sum.gapWh += b.gw;
            sum.hotSeconds += b.hs ?? 0;
            sum.graphicsWh += b.uw ?? 0;
            sum.gpu += b.gpu ?? 0;
            sum.cpu += b.cpu;
            sum.hasEnergy ||= b.energy;
            sum.memSeconds += b.ms ?? 0;
            sum.memUsedMiBs += b.mu ?? 0;
            sum.memMaxMiB = Math.max(sum.memMaxMiB, b.mx ?? 0);
            sum.memTotalMiB = Math.max(sum.memTotalMiB, b.mt ?? 0);
            sum.swapMaxMiB = Math.max(sum.swapMaxMiB, b.sx ?? 0);
            sum.swapTotalMiB = Math.max(sum.swapTotalMiB, b.st ?? 0);
            sum.swapInMiB += b.si ?? 0;
            sum.swapOutMiB += b.so ?? 0;
            sum.stallSeconds += b.ps ?? 0;
            sum.stall.cpu += b.pc ?? 0;
            sum.stall.memory += b.pm ?? 0;
            sum.stall.memoryFull += b.pf ?? 0;
            sum.stall.io += b.pi ?? 0;
            sum.netSeconds += b.ns ?? 0;
            sum.rxBytes += b.rx ?? 0;
            sum.txBytes += b.tx ?? 0;
            sum.idleSeconds += b.is ?? 0;
            sum.idleRxBytes += b.ir ?? 0;
            sum.idleTxBytes += b.it ?? 0;
            sum.diskSeconds += b.ds ?? 0;
            sum.diskReadBytes += b.dr ?? 0;
            sum.diskWrittenBytes += b.dw ?? 0;
            sum.tempSeconds += b.tt ?? 0;
            sum.tempMax = Math.max(sum.tempMax, b.tm ?? 0);
            tempArea += b.ta ?? 0;
            for (const [id, [cpu, fg, wh, gpu = 0, mibS = 0, maxMib = 0, read = 0, written = 0]] of Object.entries(b.a)) {
                const app = apps.get(id) ?? { id, cpu: 0, fg: 0, wh: 0, gpu: 0, memMiBs: 0, memMaxMiB: 0, diskRead: 0, diskWritten: 0 };
                app.cpu += cpu;
                app.fg += fg;
                app.wh += wh;
                app.gpu += gpu;
                app.memMiBs += mibS;
                app.memMaxMiB = Math.max(app.memMaxMiB, maxMib);
                app.diskRead += read;
                app.diskWritten += written;
                apps.set(id, app);
            }
        }
        sum.tempAvg = sum.tempSeconds > 0 ? tempArea / sum.tempSeconds : null;
        sum.attributedWh = sum.packageWh - sum.idleWh;
        sum.apps = [...apps.values()].sort((x, y) => (y.wh - x.wh) || (y.cpu - x.cpu));
        for (const app of sum.apps) {
            app.cpuShare = sum.cpu > 0 ? app.cpu / sum.cpu : 0;
            // Share of what the battery delivered, when there is a battery figure.
            app.batteryShare = sum.batteryWh > 0 ? app.wh / sum.batteryWh : null;
            // Average memory over the time memory was read, the hours it was not running included.
            app.memAvgMiB = sum.memSeconds > 0 ? app.memMiBs / sum.memSeconds : 0;
        }
        return sum;
    }

    /**
     * The hours of a range, AC and battery merged, oldest first: for rules
     * that look at how things change from hour to hour.
     * @returns {Array<{t: number, seconds: number, memSeconds: number, memMaxMiB: number,
     *   memTotalMiB: number, netSeconds: number, rxBytes: number, txBytes: number,
     *   idleSeconds: number, idleRxBytes: number, idleTxBytes: number,
     *   apps: Map<string, {cpu: number, fg: number, memMiBs: number, memMaxMiB: number}>}>}
     */
    hours({ from = -Infinity, to = Infinity } = {}) {
        const byHour = new Map();
        for (const b of this.buckets) {
            if (b.t < from || b.t >= to) continue;
            let h = byHour.get(b.t);
            if (!h) {
                h = { t: b.t, seconds: 0, memSeconds: 0, memMaxMiB: 0, memTotalMiB: 0, netSeconds: 0, rxBytes: 0, txBytes: 0,
                    idleSeconds: 0, idleRxBytes: 0, idleTxBytes: 0, apps: new Map() };
                byHour.set(b.t, h);
            }
            h.seconds += b.s;
            h.memSeconds += b.ms ?? 0;
            h.memMaxMiB = Math.max(h.memMaxMiB, b.mx ?? 0);
            h.memTotalMiB = Math.max(h.memTotalMiB, b.mt ?? 0);
            h.netSeconds += b.ns ?? 0;
            h.rxBytes += b.rx ?? 0;
            h.txBytes += b.tx ?? 0;
            h.idleSeconds += b.is ?? 0;
            h.idleRxBytes += b.ir ?? 0;
            h.idleTxBytes += b.it ?? 0;
            for (const [id, [cpu, fg, , , mibS = 0, maxMib = 0]] of Object.entries(b.a)) {
                const app = h.apps.get(id) ?? { cpu: 0, fg: 0, memMiBs: 0, memMaxMiB: 0 };
                app.cpu += cpu;
                app.fg += fg;
                app.memMiBs += mibS;
                app.memMaxMiB = Math.max(app.memMaxMiB, maxMib);
                h.apps.set(id, app);
            }
        }
        return [...byHour.values()].sort((x, y) => x.t - y.t);
    }
}

/**
 * Read a saved ledger. A file that cannot be understood is moved aside (never
 * deleted) and a fresh ledger is returned with the reason.
 * @returns {Promise<{ledger: BatteryLedger, problem: ?string}>}
 */
export function loadLedger(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.load_contents_async(null, (obj, res) => {
            let text;
            try {
                [, text] = obj.load_contents_finish(res);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                    resolve({ ledger: new BatteryLedger(), problem: null });
                    return;
                }
                resolve({ ledger: new BatteryLedger(), problem: `cannot read ${path}: ${e.message}` });
                return;
            }
            let ledger;
            try {
                ledger = BatteryLedger.fromJSON(new TextDecoder().decode(text));
            } catch (e) {
                const aside = `${path}.damaged-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
                let moved = '';
                try {
                    file.move(Gio.File.new_for_path(aside), Gio.FileCopyFlags.NONE, null, null);
                    moved = `; kept as ${aside}`;
                } catch (moveError) {
                    moved = `; could not move it aside: ${moveError.message}`;
                }
                resolve({ ledger: new BatteryLedger(), problem: `${path} is damaged (${e.message})${moved}` });
                return;
            }
            resolve({ ledger, problem: ledger.loadedVersion < LEDGER_VERSION ? keepOldVersion(file, ledger.loadedVersion) : null });
        });
    });
}

/**
 * Copy a file of an older version to <path>.v<version> before it is saved in
 * the new format, so the change can be undone. An existing copy is kept.
 * @returns {?string} a problem, or null
 */
function keepOldVersion(file, version) {
    const copy = Gio.File.new_for_path(`${file.get_path()}.v${version}`);
    try {
        file.copy(copy, Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) return `cannot keep a copy of the version ${version} history: ${e.message}`;
    }
    return null;
}

/** Write the ledger atomically (temporary file, then rename). */
export function saveLedger(path, ledger) {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    return new Promise((resolve, reject) => {
        try {
            parent.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                reject(e);
                return;
            }
        }
        const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(ledger)));
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (obj, res) => {
            try {
                obj.replace_contents_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}
