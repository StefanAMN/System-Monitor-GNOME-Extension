// Test-only driver, loaded by `./scripts/dev.sh test-overhead` inside an isolated
// headless shell. It runs in the gnome-shell process, so /proc/self is the
// shell: the extension's cost is the difference between windows with it
// disabled and enabled. CPU includes reaped children (cutime/cstime), so
// the process sampler's short-lived `cat` counts too.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TARGET = 'resource-pulse@stefanamn.github.io';
const ALL_METRICS = ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu'];
const TABS = ['overview', 'cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu'];
const CLK_TCK = 100;

// Budgets, in percent of one core. Menu closed is the steady state the
// project rule ("< 1% CPU") is about; an open menu repaints graphs and
// spawns the process sampler, so it gets a separate, explicit budget.
const BUDGET_CLOSED = 1.0;
const BUDGET_OPEN = 5.0;

const WINDOW_S = parseInt(GLib.getenv('RP_OVERHEAD_WINDOW') || '30', 10);
const SOAK_S = parseInt(GLib.getenv('RP_SOAK') || '1200', 10);
// Only the soak: the CPU windows need a quiet machine, the memory checks do
// not, so soaks can run side by side (and on CI runners).
const SOAK_ONLY = GLib.getenv('RP_SOAK_ONLY') === '1';
// Test-only: keep one small object per reading, as a leak would, to prove
// the heap census catches it.
const SOAK_LEAK = GLib.getenv('RP_SOAK_LEAK') === '1';
// A JavaScript cell kind (Object, Array, Function, ...) leaks when it grows
// by more than this many cells per 100 polls in both halves of the steady
// phase; a cache that fills once grows in one half only.
const LEAK_CELLS_PER_100_POLLS = 40;
// RSS is a sanity bound only: allocator retention moves it without a leak.
const RSS_SLOPE_LIMIT = 0.5;

let started = false;

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

function report(msg) {
    console.log(`RP-OVERHEAD ${msg}`);
}

function readText(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function cpuTicks() {
    const stat = readText('/proc/self/stat');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // utime, stime, cutime, cstime
    return Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]);
}

function rssMb() {
    const m = readText('/proc/self/status').match(/^VmRSS:\s+(\d+) kB/m);
    return m ? parseInt(m[1], 10) / 1024 : 0;
}

function fdCount() {
    const en = Gio.File.new_for_path('/proc/self/fd')
        .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let n = 0;
    while (en.next_file(null)) n++;
    en.close(null);
    return n;
}

/** Actor counts per named region of the menu, to say where growth happened. */
function regionCounts(ext) {
    const regions = { overview: ext._overviewPage, settings: ext._settingsPage, header: ext._detailHeader };
    for (const [key, section] of Object.entries(ext._detailSections || {})) regions[`tab:${key}`] = section;
    const out = {};
    for (const [key, actor] of Object.entries(regions)) if (actor) out[key] = actorCount(actor);
    out.total = actorCount(ext._indicator.menu.box);
    return out;
}

function regionDiff(a, b) {
    return Object.keys(b).filter(k => a[k] !== b[k]).map(k => `${k} ${a[k]}->${b[k]}`).join(', ');
}

function actorCount(actor) {
    let n = 1;
    for (const child of actor.get_children()) n += actorCount(child);
    return n;
}

/** Shell CPU over a window, in percent of one core. */
async function measureCpu(seconds) {
    const t0 = GLib.get_monotonic_time();
    const c0 = cpuTicks();
    await sleep(seconds * 1000);
    const dt = (GLib.get_monotonic_time() - t0) / 1e6;
    return ((cpuTicks() - c0) / CLK_TCK / dt) * 100;
}

function rp() {
    return Main.extensionManager.lookup(TARGET)?.stateObj;
}

function showTab(ext, tab) {
    ext._activeTab = tab;
    ext._updateTabVisibility();
}

/**
 * Robust slope (Theil–Sen): the median of the slopes between every pair of
 * points, so one GC or allocator step does not tilt it.
 */
function medianSlope(points) {
    const slopes = [];
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            if (points[j].t > points[i].t) slopes.push((points[j].v - points[i].v) / (points[j].t - points[i].t));
        }
    }
    if (!slopes.length) return 0;
    slopes.sort((a, b) => a - b);
    const mid = slopes.length >> 1;
    return slopes.length % 2 ? slopes[mid] : (slopes[mid - 1] + slopes[mid]) / 2;
}

/**
 * Live JavaScript cells in the shell by kind (Object, Array, Function,
 * string, ...), after a full collection. The heap dump runs to tens of MB,
 * so another process (awk) counts it and the shell does not parse it.
 */
async function heapCensus() {
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), `rp-heap-${GLib.get_monotonic_time()}.txt`]);
    System.gc();
    System.dumpHeap(path);
    try {
        const proc = Gio.Subprocess.new(['awk',
            '/^# zone/ { cells = 1 } cells && /^0x[0-9a-f]+ [BGW] / { n[$3]++ } END { for (k in n) print n[k], k }', path],
        Gio.SubprocessFlags.STDOUT_PIPE);
        const [, out] = await new Promise((resolve, reject) => proc.communicate_utf8_async(null, null, (obj, res) => {
            try {
                resolve(obj.communicate_utf8_finish(res));
            } catch (e) {
                reject(e);
            }
        }));
        check(proc.get_successful(), `heap census: awk failed (exit ${proc.get_exit_status()})`);
        const counts = {};
        for (const line of out.trim().split('\n')) {
            const [n, kind] = line.split(' ');
            if (kind) counts[kind] = Number(n);
        }
        check(counts.Object > 0, `heap census: no objects counted in ${path}`);
        return counts;
    } finally {
        Gio.File.new_for_path(path).delete(null);
    }
}

/** Growth per kind between two censuses, in cells per 100 polls. */
function growth(a, b, polls) {
    const out = {};
    for (const kind of new Set([...Object.keys(a), ...Object.keys(b)]))
        out[kind] = ((b[kind] ?? 0) - (a[kind] ?? 0)) * 100 / polls;
    return out;
}

async function overhead() {
    let ext = rp();
    check(ext, 'target extension not enabled');
    ext._settings.set_int('poll-interval', 2);
    ext._settings.set_strv('pinned-metrics', ALL_METRICS);

    // Baseline: same shell, extension disabled.
    Main.extensionManager.disableExtension(TARGET);
    await sleep(5000);
    const base = await measureCpu(WINDOW_S);
    report(`baseline (extension disabled): ${base.toFixed(2)}% of one core`);

    Main.extensionManager.enableExtension(TARGET);
    await sleep(5000);
    ext = rp();
    check(ext?._indicator, 'target did not re-enable');

    const closed = await measureCpu(WINDOW_S) - base;
    report(`menu closed, all 8 metrics pinned, 2 s interval: +${closed.toFixed(2)}% (budget ${BUDGET_CLOSED}%)`);

    ext._indicator.menu.open();
    showTab(ext, 'overview');
    await sleep(3000);
    const open = await measureCpu(WINDOW_S) - base;
    report(`menu open on overview: +${open.toFixed(2)}% (budget ${BUDGET_OPEN}%)`);

    showTab(ext, 'cpu');
    await sleep(3000);
    const cpuTab = await measureCpu(WINDOW_S) - base;
    report(`menu open on CPU tab (process sampler running): +${cpuTab.toFixed(2)}% (budget ${BUDGET_OPEN}%)`);

    // A search on that page: one letter matches many processes, so up to
    // ten rows instead of five.
    ext._procSearch.cpu.entry.text = 'e';
    await sleep(3000);
    const searching = await measureCpu(WINDOW_S) - base;
    report(`menu open on CPU tab, searching: +${searching.toFixed(2)}% (budget ${BUDGET_OPEN}%)`);
    ext._procSearch.cpu.entry.text = '';

    showTab(ext, 'overview');
    ext._indicator.menu.close();
    await sleep(1000);

    // Battery tracking takes one sample every 30 s whatever the menu does:
    // its cost is measured per sample (40 back to back, so the 10 ms tick of
    // /proc/self/stat resolves it) and added to the menu-closed figure. It
    // stays on for the churn and soak below.
    ext._settings.set_boolean('battery-tracking', true);
    for (let i = 0; i < 40 && !ext._tracker?.lastSample; i++) await sleep(250);
    check(ext._tracker?.lastSample, 'battery tracking did not start');
    const SAMPLES = 40;
    const c0 = cpuTicks();
    for (let i = 0; i < SAMPLES; i++) await ext._tracker.tick();
    const perSampleMs = (cpuTicks() - c0) * (1000 / CLK_TCK) / SAMPLES;
    const tracking = perSampleMs / (30 * 1000) * 100;
    report(`battery tracking: ${perSampleMs.toFixed(1)} ms CPU per sample (apps ${ext._tracker.lastSample.appsAvailable ? 'read' : 'not available'}), ` +
        `+${tracking.toFixed(3)}% at one sample per 30 s; menu closed with tracking +${(closed + tracking).toFixed(2)}% (budget ${BUDGET_CLOSED}%)`);
    check(closed + tracking <= BUDGET_CLOSED, `menu-closed overhead with tracking ${(closed + tracking).toFixed(2)}% exceeds ${BUDGET_CLOSED}%`);

    check(closed <= BUDGET_CLOSED, `menu-closed overhead ${closed.toFixed(2)}% exceeds ${BUDGET_CLOSED}%`);
    check(open <= BUDGET_OPEN, `menu-open overhead ${open.toFixed(2)}% exceeds ${BUDGET_OPEN}%`);
    check(cpuTab <= BUDGET_OPEN, `CPU-tab overhead ${cpuTab.toFixed(2)}% exceeds ${BUDGET_OPEN}%`);
    check(searching <= BUDGET_OPEN, `CPU-tab overhead while searching ${searching.toFixed(2)}% exceeds ${BUDGET_OPEN}%`);
}

async function churnRound(ext) {
    for (let i = 0; i < 60; i++) {
        ext._indicator.menu.open();
        showTab(ext, TABS[i % TABS.length]);
        await sleep(120);
        showTab(ext, 'overview');
        ext._indicator.menu.close();
        await sleep(80);
    }
    await sleep(2500);
    return regionCounts(ext);
}

async function churn() {
    // Open/close and tab switching must not leave actors behind. Visit
    // every tab long enough for a sample to land first, so lazily built
    // pages and first-time process rows are not mistaken for a leak; then
    // two identical churn rounds must end with the same actor count.
    const ext = rp();
    ext._indicator.menu.open();
    for (const tab of TABS) {
        showTab(ext, tab);
        await sleep(2500);
    }
    showTab(ext, 'overview');
    ext._indicator.menu.close();
    // Lists that follow live data (active network interfaces, sensors)
    // legitimately change length between rounds, so a fixed count is the
    // wrong rule. A leak grows on every round: fail only on growth in each
    // of three consecutive rounds.
    const r1 = await churnRound(ext);
    const r2 = await churnRound(ext);
    const r3 = await churnRound(ext);
    report(`menu actors after three identical churn rounds: ${r1.total}, ${r2.total}, ${r3.total}` +
        (r3.total !== r1.total ? ` (${regionDiff(r1, r3)})` : ''));
    check(!(r2.total > r1.total && r3.total > r2.total),
        `menu actor count grew on every churn round: ${regionDiff(r1, r2)}; ${regionDiff(r2, r3)}`);
}

async function soak() {
    // Worst realistic case: 1 s interval, menu open, every tab visited.
    const ext = rp();
    if (SOAK_ONLY) {
        ext._settings.set_strv('pinned-metrics', ALL_METRICS);
        ext._settings.set_boolean('battery-tracking', true);
    }
    const kept = [];
    if (SOAK_LEAK) {
        const present = ext._present;
        ext._present = function (data) {
            kept.push({ at: GLib.get_monotonic_time(), cpu: data.cpu?.total });
            return present.call(this, data);
        };
    }
    ext._settings.set_int('poll-interval', 1);
    ext._indicator.menu.open();
    const t0 = GLib.get_monotonic_time();
    const c0 = cpuTicks();
    // Samples go into arrays allocated now: a record kept per step would
    // itself grow the heap the census counts (one object every 15 s, the
    // +7 objects per 100 polls the first soaks measured; a soak with the
    // extension disabled stays flat).
    const steps = Math.ceil(SOAK_S / 15);
    const samples = {
        n: 0, t: new Float64Array(steps), rss: new Float64Array(steps),
        fds: new Int32Array(steps), actors: new Int32Array(steps), sparks: new Int32Array(steps),
    };
    // Heap censuses: after a quarter (lazy pages and caches are built by
    // then), half way through the rest, and at the end.
    const censusAt = [SOAK_S / 4, SOAK_S * 5 / 8, SOAK_S];
    const censuses = [];
    let tab = 0;
    for (let elapsed = 0; elapsed < SOAK_S; elapsed += 15) {
        for (let k = 0; k < 3; k++) {
            showTab(ext, TABS[tab++ % TABS.length]);
            await sleep(5000);
        }
        System.gc();
        await sleep(200);
        const t = (GLib.get_monotonic_time() - t0) / 1e6;
        const i = samples.n++;
        samples.t[i] = t / 60;
        samples.rss[i] = rssMb();
        samples.fds[i] = fdCount();
        samples.actors[i] = actorCount(ext._indicator.menu.box);
        samples.sparks[i] = ext._sparklines.length;
        if (censuses.length < censusAt.length && elapsed + 15 >= censusAt[censuses.length])
            censuses.push({ t, cells: await heapCensus() });
    }
    const cpu = ((cpuTicks() - c0) / CLK_TCK / ((GLib.get_monotonic_time() - t0) / 1e6)) * 100;
    showTab(ext, 'overview');
    ext._indicator.menu.close();
    ext._settings.set_int('poll-interval', 2);
    if (SOAK_LEAK) delete ext._present;

    // RSS after the first half: the collector and the allocator settle
    // for minutes after the pages are built.
    const all = Array.from({ length: samples.n }, (_x, i) => ({
        t: samples.t[i], rss: samples.rss[i], fds: samples.fds[i], actors: samples.actors[i], sparks: samples.sparks[i],
    }));
    const steady = all.filter(s => s.t * 60 >= SOAK_S / 2);
    const first = steady[0];
    const last = steady[steady.length - 1];
    const rssSlope = medianSlope(steady.map(s => ({ t: s.t, v: s.rss })));
    report(`soak ${SOAK_S}s @1s interval, menu open, tabs cycling: shell CPU ${cpu.toFixed(2)}% (incl. idle shell)${SOAK_LEAK ? `, planted leak of ${kept.length} objects` : ''}`);
    report(`soak RSS ${all[0].rss.toFixed(1)} -> ${last.rss.toFixed(1)} MB, slope after the first half ${rssSlope.toFixed(3)} MB/min (median of pairs)`);
    report(`soak fds ${first.fds} -> ${last.fds}, menu actors ${first.actors} -> ${last.actors}, sparklines ${first.sparks} -> ${last.sparks}`);

    // Cells per 100 polls (one poll a second) in each half; a leak grows in both.
    check(censuses.length === 3, `heap census: ${censuses.length} of 3 taken`);
    const [c1, c2, c3] = censuses;
    const g1 = growth(c1.cells, c2.cells, c2.t - c1.t);
    const g2 = growth(c2.cells, c3.cells, c3.t - c2.t);
    const kinds = Object.keys(g2).sort((a, b) => Math.max(g2[b], g1[b]) - Math.max(g2[a], g1[a]));
    report(`soak heap: ${c1.cells.Object} -> ${c2.cells.Object} -> ${c3.cells.Object} objects; growth per 100 polls (first half / second half): ` +
        kinds.slice(0, 6).map(k => `${k} ${g1[k] >= 0 ? '+' : ''}${g1[k].toFixed(0)} / ${g2[k] >= 0 ? '+' : ''}${g2[k].toFixed(0)}`).join(', '));
    const leaking = kinds.filter(k => g1[k] > LEAK_CELLS_PER_100_POLLS && g2[k] > LEAK_CELLS_PER_100_POLLS);

    check(steady.every(s => s.sparks === first.sparks), 'sparkline list grew during the soak');
    check(Math.max(...steady.map(s => s.actors)) === Math.min(...steady.map(s => s.actors)) ||
        steady.every(s => Math.abs(s.actors - first.actors) <= 20),
    `menu actor count drifted (${steady.map(s => s.actors).join(', ')})`);
    check(last.fds <= first.fds + 3, `fd count grew from ${first.fds} to ${last.fds}`);
    check(leaking.length === 0, `JavaScript heap keeps growing: ${leaking.map(k => `${k} +${g1[k].toFixed(0)} then +${g2[k].toFixed(0)} cells per 100 polls`).join(', ')}`);
    check(rssSlope <= RSS_SLOPE_LIMIT, `shell RSS keeps growing at ${rssSlope.toFixed(2)} MB/min after the first half`);
}

async function run() {
    await sleep(3000);
    if (!SOAK_ONLY) {
        await overhead();
        await churn();
    }
    if (SOAK_S > 0) await soak();
}

export default class OverheadDriver extends Extension {
    enable() {
        if (started) return;
        started = true;
        run().then(
            () => console.log('RP-UITEST DONE'),
            e => console.log(`RP-UITEST FAIL: ${e.message}\n${e.stack}`));
    }

    disable() {}
}
