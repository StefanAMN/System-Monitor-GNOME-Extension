import { IncidentRecorder, INCIDENT_LIMIT, INCIDENT_SLOTS } from '../../src/lib/engine/incidents.js';
import { parsePressure } from '../../src/lib/collectors/pressure.js';

const US = 1e6;
const WALL = 1_800_000_000_000;
let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}

function feed(recorder, second, total, options = {}) {
    const now = second * US;
    const meta = (fresh = true, at = now) => ({ fresh, sampledAt: at });
    const data = {
        cpu: { total: options.cpu ?? 18, cores: [18] },
        mem: { total: 1e9, percent: 52, swapTotal: 1e8, swapPercent: 0 },
        dsk: { diskPercent: 30, ioSampled: options.diskAvailable ?? true },
        thm: { packageTemp: 48 },
        psi: { totals: { cpu: { some: total }, memory: { some: options.memory ?? 0 }, io: { some: 0 } } },
        samples: { cpu: meta(options.cpuFresh, options.cpuAt), mem: meta(), dsk: meta(), thm: meta(), psi: meta(options.psiFresh, options.psiAt) },
    };
    return recorder.observe(data, now, WALL + second * 1000, 5 * US);
}

const totals = {};
const average = parsePressure('some avg10=2.31 avg60=0.20 avg300=0.10 total=45678\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=bad\n', totals);
check(average.some === 2.31 && totals.some === 45678 && totals.full === null, 'averages and validated cumulative counters share the same read');

const recorder = new IncidentRecorder();
for (let s = 2; s <= 78; s += 2) feed(recorder, s, 0, { cpu: s });
check(!recorder.active, 'idle pressure does not trigger');
feed(recorder, 80, 600_000, { cpu: 88 });
check(recorder.active?.trigger === 'cpu' && recorder.active.end === 110 * US, 'a 600ms stall over a 2s interval triggers a CPU capture');
check(recorder.active.at === WALL + 80_000 && recorder.active.rows[0][0] === 20 && recorder.active.rows[30][0] === 88, 'capture contains the 60 seconds of prehistory and the trigger');
check(!recorder.startManual(81 * US, WALL), 'manual cannot replace an active capture');
feed(recorder, 82, 1_200_000, { cpuFresh: false, diskAvailable: false });
check(recorder.active.rows[31][0] === null && recorder.active.rows[31][3] === null && recorder.active.rows[31][2] === 0, 'stale values and missing disks leave gaps while a measured zero stays');
feed(recorder, 84, 1_200_000, { cpu: 93, cpuAt: 82 * US });
check(recorder.active.rows[31][0] === 93 && recorder.active.rows[32][0] === null, 'a late value fills its measured time');
check(!feed(recorder, 109, 1_200_000), 'capture stays active for the full post window');
const done = feed(recorder, 112, 1_200_000);
check(done?.rows.length === INCIDENT_SLOTS && recorder.captures[0] === done && !recorder.active, 'the next scheduled poll finalizes exactly one bounded capture');
check(done.rows[45][0] === 18 && done.rows[45][5] === null, 'the last slot contains only in-window data and pressure gaps are preserved');
feed(recorder, 114, 1_800_000);
check(!recorder.active, 'automatic cooldown suppresses a second spike');
check(recorder.startManual(114 * US, WALL + 114_000), 'manual capture is available during automatic cooldown');
feed(recorder, 145, 1_800_000);
check(recorder.captures[0].trigger === 'manual', 'manual capture completes and appears first');

const betweenPolls = new IncidentRecorder();
betweenPolls.startManual(120 * US, WALL);
check(!betweenPolls.finish(149 * US), 'deadline cannot finalize early');
const sparse = betweenPolls.finish(153 * US);
check(sparse?.rows.every(row => row.every(value => value === null)), 'a deadline between polls completes with gaps');
check(!betweenPolls.finish(154 * US), 'deadline and poll cannot finish the same capture twice');

const missing = new IncidentRecorder();
feed(missing, 2, 9_000_000);
feed(missing, 4, 9_000_000, { psiFresh: false });
feed(missing, 6, 12_000_000);
check(!missing.active, 'timeout breaks the pressure baseline');
feed(missing, 8, 1);
check(!missing.active, 'counter reset does not create a spike');
feed(missing, 10, 1, { memory: 400_000 });
check(missing.active?.trigger === 'memory', 'real memory stalls trigger after a new baseline');

const retained = new IncidentRecorder();
for (let i = 0; i < INCIDENT_LIMIT + 2; i++) {
    const second = 100 + 40 * i;
    retained.startManual(second * US, WALL + second * 1000);
    feed(retained, second + 31, 0);
}
check(retained.captures.length === INCIDENT_LIMIT && retained.captures[0].at > retained.captures.at(-1).at, 'only the newest five captures are retained');
const capacity = retained._values.length;
for (let i = 0; i < 5000; i++) feed(retained, 500 + i / 4, 0);
check(retained._values.length === capacity && retained._times.length === capacity, 'prehistory storage remains fixed at the fastest cadence');
print(`slowdown recorder: ${passed} passed`);
