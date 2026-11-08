import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { readProcFile } from '../../src/lib/common/utils.js';
import { F_STARTTIME, parseStatBlob } from '../../src/lib/collectors/process.js';
import { parseSmapsRollup, ProcessMemoryInspector } from '../../src/lib/collectors/processmemory.js';

const KIB = 1024;
const rollup = (pss, clean, dirty) => `Pss: ${pss} kB\nPrivate_Clean: ${clean} kB\nPrivate_Dirty: ${dirty} kB\n`;
let passed = 0;
function check(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
}

async function run() {
    const parsed = parseSmapsRollup(`${rollup(300, 100, 50)}Private_Hugetlb: 2048 kB\n`);
    check(parsed.privateBytes === 150 * KIB && parsed.sharedBytes === 150 * KIB && parsed.pss === 300 * KIB,
        'resident private and proportional shared sum to PSS, excluding explicit HugeTLB');
    check(parseSmapsRollup(rollup(0, 0, 0))?.pss === 0, 'zero is a valid sample');
    check(parseSmapsRollup('Pss_Dirty: 40 kB\nPrivate_Clean: 20 kB\n') === null, 'partial rollup must not read as zero');
    check(parseSmapsRollup(rollup(50, 100, 10)) === null, 'inconsistent private/PSS counters are unavailable');
    check(parseSmapsRollup(rollup(-1, 0, 0)) === null, 'invalid negative counters are unavailable');

    const root = GLib.dir_make_tmp('rp-smaps-XXXXXX');
    const pids = [];
    const member = (pid, start, text, { state = 'S', name = 'rp (odd)\nname', recordedStart = start } = {}) => {
        const path = `${root}/${pid}`;
        pids.push(pid);
        GLib.mkdir_with_parents(path, 0o700);
        const fields = Array(22).fill('0');
        fields[0] = state;
        fields[F_STARTTIME] = String(start);
        GLib.file_set_contents(`${path}/stat`, `${pid} (${name}) ${fields.join(' ')}\n`);
        if (text !== null) GLib.file_set_contents(`${path}/smaps_rollup`, text);
        return { pid, start: recordedStart };
    };
    try {
        const members = [
            member(70001, 100, rollup(300, 100, 50)),
            member(70002, 200, rollup(90, 20, 40)),
            member(70003, 300, rollup(500, 100, 100), { recordedStart: 299 }),
            member(70004, 400, null),
            member(70005, 500, rollup(500, 100, 100), { state: 'Z' }),
            { pid: 70006, start: 600 },
        ];
        if (Gio.Credentials.new().get_unix_user() !== 0) {
            members.push(member(70007, 700, rollup(500, 100, 100)));
            GLib.chmod(`${root}/70007/smaps_rollup`, 0);
        }
        const inspector = new ProcessMemoryInspector(root);
        const result = await inspector.sample(members);
        check(result.measured === 2 && result.total === members.length, 'report partial coverage for disappeared, denied, zombie and reused PIDs');
        check(result.privateBytes === 210 * KIB && result.sharedBytes === 180 * KIB && result.pss === 390 * KIB,
            'only valid readable members contribute to group memory');
        const unavailable = await inspector.sample(members.slice(2));
        check(unavailable.measured === 0 && unavailable.total === members.length - 2, 'all unavailable members remain visible in coverage');

        const pending = inspector.sample(members);
        check(await inspector.sample(members) === null, 'one read in flight at a time');
        inspector.cancel();
        check(await pending === null, 'cancellation discards the reading');
        check((await inspector.sample(members)).measured === 2, 'inspection can restart after cancellation');
    } finally {
        for (const pid of pids) {
            GLib.unlink(`${root}/${pid}/smaps_rollup`);
            GLib.unlink(`${root}/${pid}/stat`);
            GLib.rmdir(`${root}/${pid}`);
        }
        GLib.rmdir(root);
    }

    if (GLib.file_test('/proc/self/smaps_rollup', GLib.FileTest.EXISTS)) {
        const [self] = parseStatBlob(readProcFile('/proc/self/stat'));
        const result = await new ProcessMemoryInspector().sample([self]);
        check(result.measured === 1 && result.pss > 0 && result.privateBytes + result.sharedBytes === result.pss,
            'real /proc smaps_rollup yields a resident memory breakdown');
    }
    print(`Process memory: ${passed} passed`);
}

const loop = new GLib.MainLoop(null, false);
let failed = false;
run().catch(e => {
    failed = true;
    printerr(`${e.message}\n${e.stack}`);
}).finally(() => loop.quit());
loop.run();
if (failed) System.exit(1);
