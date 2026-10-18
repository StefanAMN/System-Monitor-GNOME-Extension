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
const SOAK_S = parseInt(GLib.getenv('RP_SOAK') || '600', 10);

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

function slopePerMinute(points) {
    // Least-squares slope of value over time (minutes).
    const n = points.length;
    if (n < 2) return 0;
    const mx = points.reduce((a, p) => a + p.t, 0) / n;
    const my = points.reduce((a, p) => a + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of points) {
        num += (p.t - mx) * (p.v - my);
        den += (p.t - mx) ** 2;
    }
    return den > 0 ? num / den : 0;
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
    ext._settings.set_int('poll-interval', 1);
    ext._indicator.menu.open();
    const t0 = GLib.get_monotonic_time();
    const c0 = cpuTicks();
    const samples = [];
    let tab = 0;
    for (let elapsed = 0; elapsed < SOAK_S; elapsed += 15) {
        for (let k = 0; k < 3; k++) {
            showTab(ext, TABS[tab++ % TABS.length]);
            await sleep(5000);
        }
        System.gc();
        await sleep(200);
        samples.push({
            t: (GLib.get_monotonic_time() - t0) / 60e6,
            rss: rssMb(),
            fds: fdCount(),
            actors: actorCount(ext._indicator.menu.box),
            sparks: ext._sparklines.length
        });
    }
    const cpu = ((cpuTicks() - c0) / CLK_TCK / ((GLib.get_monotonic_time() - t0) / 1e6)) * 100;
    showTab(ext, 'overview');
    ext._indicator.menu.close();
    ext._settings.set_int('poll-interval', 2);

    // Ignore the first quarter: lazy pages and caches are still being built.
    const steady = samples.slice(Math.floor(samples.length / 4));
    const first = steady[0];
    const last = steady[steady.length - 1];
    const rssSlope = slopePerMinute(steady.map(s => ({ t: s.t, v: s.rss })));
    report(`soak ${SOAK_S}s @1s interval, menu open, tabs cycling: shell CPU ${cpu.toFixed(2)}% (incl. idle shell)`);
    report(`soak RSS ${samples[0].rss.toFixed(1)} -> ${last.rss.toFixed(1)} MB, steady-state slope ${rssSlope.toFixed(3)} MB/min`);
    report(`soak fds ${first.fds} -> ${last.fds}, menu actors ${first.actors} -> ${last.actors}, sparklines ${first.sparks} -> ${last.sparks}`);

    check(steady.every(s => s.sparks === first.sparks), 'sparkline list grew during the soak');
    check(Math.max(...steady.map(s => s.actors)) === Math.min(...steady.map(s => s.actors)) ||
        steady.every(s => Math.abs(s.actors - first.actors) <= 20),
    `menu actor count drifted (${steady.map(s => s.actors).join(', ')})`);
    check(last.fds <= first.fds + 3, `fd count grew from ${first.fds} to ${last.fds}`);
    // A real leak of one allocation per poll shows up as a steady climb.
    // 0.5 MB/min is 30 MB/hour, well above allocator noise after GC.
    check(rssSlope <= 0.5, `shell RSS keeps growing at ${rssSlope.toFixed(2)} MB/min`);
}

async function run() {
    await sleep(3000);
    await overhead();
    await churn();
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
