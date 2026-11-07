import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { INCIDENT_LIMIT, INCIDENT_METRICS, INCIDENT_SLOTS, INCIDENT_STEP_SECONDS } from '../../src/lib/engine/incidents.js';
import { IncidentStore } from '../../src/lib/engine/incidentstore.js';

const root = GLib.dir_make_tmp('rp-incidents-XXXXXX');
const loop = new GLib.MainLoop(null, false);
let passed = 0;
let failed = false;

function check(condition, description) {
    if (!condition) throw new Error(description);
    passed++;
}

const capture = (at, trigger = 'manual') => ({
    at, trigger, intervalSeconds: INCIDENT_STEP_SECONDS,
    rows: Array.from({ length: INCIDENT_SLOTS }, () => INCIDENT_METRICS.map((_, i) => i === 1 ? null : i)),
});
const fileText = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);

async function run() {
    const path = `${root}/a/b/incidents.json`;
    const problems = [];
    const store = new IncidentStore(path, problem => problems.push(problem));
    check((await store.load()).length === 0 && problems.length === 0, 'missing history starts empty without an error');

    const old = capture(200);
    const latest = { ...capture(100, 'memory'), command: 'private data' };
    const older = Array.from({ length: INCIDENT_LIMIT }, (_, i) => capture(99 - i));
    const saving = store.save([latest, old, ...older]);
    latest.rows[0][0] = 999;
    check(await saving, 'save creates missing parent directories');
    let restored = await store.load();
    check(restored.length === INCIDENT_LIMIT && restored[0].at === 100 && restored[1].at === 200,
        'history is capped and preserves creation order across a backward clock correction');
    check(restored[0].rows[0][0] === 0 && restored[0].rows[0][1] === null, 'save snapshots values and preserves missing measurements');
    check(!fileText(path).includes('private data'), 'only recorder fields reach the history file');
    const file = Gio.File.new_for_path(path);
    const mode = () => file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o777;
    check(mode() === 0o600, 'new history is private');
    GLib.chmod(path, 0o644);

    const first = store.save([capture(300)]);
    const middle = store.save([capture(400)]);
    const reopened = new IncidentStore(path, problem => problems.push(problem));
    const last = reopened.save([capture(500, 'io')]);
    check(middle === last, 'queued saves share the latest pending snapshot across instances');
    restored = await reopened.load();
    check(restored.length === 1 && restored[0].at === 500, 'reopening waits for earlier writes');
    check(await first && await middle && await last, 'all accepted saves settle');
    check(mode() === 0o600, 'replacement also makes an existing history private');
    const untouched = fileText(path);
    const invalid = capture(600);
    invalid.rows[0][0] = Infinity;
    check(!await store.save([invalid]) && fileText(path) === untouched, 'invalid measurements cannot replace a good snapshot');
    const datePath = `${root}/a/b/dates.json`;
    GLib.file_set_contents(datePath, JSON.stringify({ version: 1, captures: [capture(253402300800000)] }));
    const dates = new IncidentStore(datePath, problem => problems.push(problem));
    check((await dates.load()).length === 0, 'timestamps beyond year 9999 cannot reach the display');

    const corrupt = '{"version":1,"captures":[{"at":0,"trigger":"manual","intervalSeconds":2,"rows":[[1]]}]}';
    GLib.file_set_contents(path, corrupt);
    const before = problems.length;
    check((await store.load()).length === 0 && problems.length === before + 1, 'wrong row shape is rejected');
    check((await store.load()).length === 0 && problems.length === before + 1, 'repeated errors do not spam');
    check(fileText(path) === corrupt, 'a read failure does not alter the original file');
    check(await store.save([capture(700)]), 'a new capture can replace corrupted version-1 history');

    const future = '{"version":2,"captures":[],"future":true}';
    GLib.file_set_contents(path, future);
    check((await store.load()).length === 0, 'unknown versions are unavailable');
    check(!await store.save([capture(800)]) && fileText(path) === future, 'unknown versions stay untouched');
    const large = ' '.repeat(64 * 1024 + 1);
    GLib.file_set_contents(path, large);
    check((await store.load()).length === 0, 'oversized input is rejected');
    check(!await store.save([capture(900)]) && fileText(path) === large, 'oversized input cannot be overwritten');

    const linkPath = `${root}/link`;
    Gio.File.new_for_path(linkPath).make_symbolic_link(path, null);
    const link = new IncidentStore(linkPath, problem => problems.push(problem));
    check((await link.load()).length === 0 && !await link.save([capture(1000)]), 'history does not follow a file symlink');
    check(fileText(path) === large, 'symlink target is untouched');
    print(`incident store: ${passed} passed`);
}

run().catch(error => {
    printerr(`${error.message}\n${error.stack}`);
    failed = true;
}).finally(() => {
    GLib.unlink(`${root}/link`);
    GLib.unlink(`${root}/a/b/incidents.json`);
    GLib.unlink(`${root}/a/b/dates.json`);
    GLib.rmdir(`${root}/a/b`);
    GLib.rmdir(`${root}/a`);
    GLib.rmdir(root);
    loop.quit();
});
loop.run();
if (failed) System.exit(1);
