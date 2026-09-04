// The battery ledger: turns readings of per-app CPU time, CPU package energy
// and battery energy into hourly totals per app, kept for 14 days.
//
// Attribution is an estimate. CPU package energy above an idle baseline is
// shared among apps by CPU time; the baseline ("idle and platform") and all
// battery energy the package does not account for (display, radios, the
// rest) are not given to any app. Without readable package energy only CPU
// time is recorded.
//
// Engine layer: no widgets; file I/O only in loadLedger / saveLedger.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const LEDGER_VERSION = 1;
export const DAYS_KEPT = 14;
// One bucket per hour and power source (AC / battery): fixed upper bound.
export const MAX_BUCKETS = DAYS_KEPT * 24 * 2;
// Apps kept per bucket once it is closed; the rest are summed into MORE.
export const APPS_PER_BUCKET = 30;
// While a bucket is open it may hold more, so a late heavy app is not
// lumped in with the rest; still bounded.
const OPEN_BUCKET_APPS = 2 * APPS_PER_BUCKET;
const HOUR_MS = 3600 * 1000;

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

export class LedgerFormatError extends Error {}

function hourStart(wallMs) {
    const d = new Date(wallMs);
    d.setMinutes(0, 0, 0);
    return d.getTime();
}

function emptyBucket(start, onBattery) {
    // s: seconds covered; bw: battery Wh delivered; pw: CPU package Wh;
    // iw: of which idle baseline; gw: battery Wh over gaps (locked, asleep);
    // cpu: machine CPU µs; a: id -> [cpu µs, foreground cpu µs, Wh]
    return { t: start, b: onBattery, s: 0, bw: 0, pw: 0, iw: 0, gw: 0, cpu: 0, energy: false, a: {} };
}

export class BatteryLedger {
    constructor(state = null) {
        this.buckets = state?.buckets ?? [];
        this.baselineW = state?.baselineW ?? null;
        // Counters of the previous sample, by unit; not persisted (they are
        // meaningless in another process).
        this._prevUnits = null;
        this._prevMono = 0;
        this._prevWall = 0;
        this._prevTotal = null;
        this._prevSystem = null;
        this._prevBatteryWh = state?.last?.batteryWh ?? null;
        this._lastSeenWall = state?.last?.wall ?? null;
        this._powerSamples = new Float64Array(BASELINE_SAMPLES);
        this._powerCount = 0;
        this._powerHead = 0;
        this._sortScratch = new Float64Array(BASELINE_SAMPLES);
    }

    /** Parse a saved ledger. @throws {LedgerFormatError} */
    static fromJSON(text) {
        let obj;
        try {
            obj = JSON.parse(text);
        } catch (e) {
            throw new LedgerFormatError(`not JSON: ${e.message}`);
        }
        if (obj?.version !== LEDGER_VERSION)
            throw new LedgerFormatError(`version ${obj?.version} is not ${LEDGER_VERSION}`);
        if (!Array.isArray(obj.buckets) || !obj.buckets.every(b => Number.isFinite(b?.t) && typeof b.a === 'object'))
            throw new LedgerFormatError('buckets are malformed');
        return new BatteryLedger(obj);
    }

    toJSON() {
        return {
            version: LEDGER_VERSION,
            baselineW: this.baselineW,
            last: { wall: this._prevWall || this._lastSeenWall, batteryWh: this._prevBatteryWh },
            buckets: this.buckets,
        };
    }

    clear() {
        this.buckets = [];
    }

    /**
     * Forget the previous sample (tracking was switched off): the next
     * sample starts afresh instead of reporting the time in between as a gap.
     */
    forgetLast() {
        this._prevUnits = null;
        this._prevBatteryWh = null;
        this._lastSeenWall = null;
        this._prevWall = 0;
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

    /** Keep the largest APPS_PER_BUCKET apps of a bucket, sum the rest into MORE. */
    _closeBucket(bucket) {
        const ids = Object.keys(bucket.a).filter(id => !id.startsWith('@'));
        if (ids.length <= APPS_PER_BUCKET) return;
        ids.sort((x, y) => (bucket.a[y][2] - bucket.a[x][2]) || (bucket.a[y][0] - bucket.a[x][0]));
        for (const id of ids.slice(APPS_PER_BUCKET)) {
            this._add(bucket, MORE, bucket.a[id][0], bucket.a[id][1], bucket.a[id][2], true);
            delete bucket.a[id];
        }
    }

    _prune(wallMs) {
        const oldest = hourStart(wallMs) - DAYS_KEPT * 24 * HOUR_MS;
        this.buckets = this.buckets.filter(b => b.t > oldest);
        if (this.buckets.length > MAX_BUCKETS) this.buckets.splice(0, this.buckets.length - MAX_BUCKETS);
    }

    _add(bucket, id, cpu, fg, wh, force = false) {
        let entry = bucket.a[id];
        if (!entry) {
            const named = Object.keys(bucket.a).length;
            if (!force && !id.startsWith('@') && named >= OPEN_BUCKET_APPS) return this._add(bucket, MORE, cpu, fg, wh, true);
            entry = bucket.a[id] = [0, 0, 0];
        }
        entry[0] += cpu;
        entry[1] += fg;
        entry[2] += wh;
        return entry;
    }

    _learnBaseline(watts) {
        this._powerSamples[this._powerHead] = watts;
        this._powerHead = (this._powerHead + 1) % BASELINE_SAMPLES;
        if (this._powerCount < BASELINE_SAMPLES) this._powerCount++;
        if (this._powerCount < BASELINE_MIN_SAMPLES) return;
        const n = this._powerCount;
        const scratch = this._sortScratch.subarray(0, n);
        scratch.set(this._powerSamples.subarray(0, n));
        scratch.sort();
        this.baselineW = scratch[Math.floor(n * BASELINE_PERCENTILE)];
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
     * @returns {boolean} whether the interval was attributed (false for the first sample and gaps)
     */
    ingest({ mono, wall, usage, packageW, battery, focusUsec = {} }) {
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
        const delivered = onBattery && batteryWh !== null && this._prevBatteryWh !== null
            ? Math.max(0, this._prevBatteryWh - batteryWh) : 0;

        if (gap) {
            bucket.gw += delivered;
        } else if (!first && dt > 0 && usage.total !== null && this._prevTotal !== null) {
            attributed = true;
            bucket.s += dt;
            bucket.bw += delivered;
            const totalCpu = Math.max(0, usage.total - this._prevTotal);
            bucket.cpu += totalCpu;

            let pool = null;
            if (Number.isFinite(packageW)) {
                const packageWh = packageW * dt / 3600;
                const idleWh = Math.min(packageWh, (this.baselineW ?? 0) * dt / 3600);
                bucket.pw += packageWh;
                bucket.iw += idleWh;
                bucket.energy = true;
                pool = packageWh - idleWh;
                this._learnBaseline(packageW);
            }
            const whFor = cpu => (pool !== null && totalCpu > 0 ? pool * Math.min(1, cpu / totalCpu) : 0);

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
            for (const [id, cpu] of perApp) {
                const fg = Math.min(1, (focusUsec[id] ?? 0) / (dt * 1e6));
                this._add(bucket, id, cpu, cpu * fg, whFor(cpu));
            }
            if (usage.system !== null && this._prevSystem !== null) {
                const sys = Math.max(0, usage.system - this._prevSystem);
                if (sys > 0) this._add(bucket, SYSTEM, sys, 0, whFor(sys));
                named += sys;
            }
            const rest = Math.max(0, totalCpu - named);
            if (rest > 0) this._add(bucket, OTHER, rest, 0, whFor(rest));
        }

        this._prevUnits = new Map(usage.units.map(u => [u.unit, u.usec]));
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
        const sum = { seconds: 0, batteryWh: 0, packageWh: 0, idleWh: 0, gapWh: 0, cpu: 0, hasEnergy: false, apps: [] };
        const apps = new Map();
        for (const b of this.buckets) {
            if (b.t < from || b.t >= to || (batteryOnly && !b.b)) continue;
            sum.seconds += b.s;
            sum.batteryWh += b.bw;
            sum.packageWh += b.pw;
            sum.idleWh += b.iw;
            sum.gapWh += b.gw;
            sum.cpu += b.cpu;
            sum.hasEnergy ||= b.energy;
            for (const [id, [cpu, fg, wh]] of Object.entries(b.a)) {
                const app = apps.get(id) ?? { id, cpu: 0, fg: 0, wh: 0 };
                app.cpu += cpu;
                app.fg += fg;
                app.wh += wh;
                apps.set(id, app);
            }
        }
        sum.attributedWh = sum.packageWh - sum.idleWh;
        sum.apps = [...apps.values()].sort((x, y) => (y.wh - x.wh) || (y.cpu - x.cpu));
        for (const app of sum.apps) {
            app.cpuShare = sum.cpu > 0 ? app.cpu / sum.cpu : 0;
            // Share of what the battery delivered, when there is a battery figure.
            app.batteryShare = sum.batteryWh > 0 ? app.wh / sum.batteryWh : null;
        }
        return sum;
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
            try {
                resolve({ ledger: BatteryLedger.fromJSON(new TextDecoder().decode(text)), problem: null });
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
            }
        });
    });
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
