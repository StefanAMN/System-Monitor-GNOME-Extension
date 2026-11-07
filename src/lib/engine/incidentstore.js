// Local storage for the recorder's completed incident windows.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { logOnce } from '../common/utils.js';
import { INCIDENT_LIMIT, INCIDENT_METRICS, INCIDENT_SLOTS, INCIDENT_STEP_SECONDS } from './incidents.js';

const VERSION = 1;
const MAX_BYTES = 64 * 1024;
// GLib.DateTime can display through the last millisecond of year 9999.
const MAX_DATE_MS = 253402300799999;
const TRIGGERS = new Set(['manual', 'cpu', 'memory', 'io']);
const PRIORITY = GLib.PRIORITY_DEFAULT;

// An old extension instance can still be writing after disable(). Share its
// queue with the next instance, keeping only the latest waiting snapshot.
const writes = new Map();

export function incidentPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'resource-pulse', 'incidents.json']);
}

function asyncCall(object, operation, ...args) {
    return new Promise((resolve, reject) => {
        const finish = operation === 'replace_contents_bytes' ? 'replace_contents' : operation;
        object[`${operation}_async`](...args, (source, result) => {
            try {
                resolve(source[`${finish}_finish`](result));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function matches(error, code) {
    return error.matches?.(Gio.IOErrorEnum, code) ?? false;
}

async function makeParents(dir) {
    if (!dir) return;
    try {
        await asyncCall(dir, 'make_directory', PRIORITY, null);
    } catch (error) {
        if (matches(error, Gio.IOErrorEnum.EXISTS)) return;
        if (!matches(error, Gio.IOErrorEnum.NOT_FOUND)) throw error;
        await makeParents(dir.get_parent());
        await makeParents(dir);
    }
}

// Both directions project onto the same bounded shape. Never persist fields
// outside the recorder's eight machine-wide measurements.
function snapshots(captures) {
    if (!Array.isArray(captures)) throw new Error('invalid capture list');
    const result = [];
    for (const capture of captures.slice(0, INCIDENT_LIMIT)) {
        if (!Number.isSafeInteger(capture?.at) || capture.at < 0 || capture.at > MAX_DATE_MS ||
            !TRIGGERS.has(capture.trigger) || capture.intervalSeconds !== INCIDENT_STEP_SECONDS ||
            !Array.isArray(capture.rows) || capture.rows.length !== INCIDENT_SLOTS)
            throw new Error('invalid capture');
        const rows = [];
        for (const row of capture.rows) {
            if (!Array.isArray(row) || row.length !== INCIDENT_METRICS.length)
                throw new Error('invalid capture sample');
            const values = [];
            for (const value of row) {
                if (value !== null && !Number.isFinite(value)) throw new Error('invalid capture value');
                values.push(value);
            }
            rows.push(values);
        }
        result.push({ at: capture.at, trigger: capture.trigger, intervalSeconds: INCIDENT_STEP_SECONDS, rows });
    }
    // The recorder orders by capture creation. Wall time can go backwards.
    return result;
}

/** Read at most MAX_BYTES + one byte, even if the file grows after the stat. */
async function read(file) {
    let info;
    try {
        info = await asyncCall(file, 'query_info', 'standard::type,standard::size,etag::value',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, null);
    } catch (error) {
        if (matches(error, Gio.IOErrorEnum.NOT_FOUND)) return { captures: [], etag: null };
        throw error;
    }
    if (info.get_file_type() !== Gio.FileType.REGULAR) throw new Error('incident history is not a regular file');
    if (info.get_size() > MAX_BYTES) throw new Error('incident history exceeds 64 KiB');

    const stream = await asyncCall(file, 'read', PRIORITY, null);
    const bytes = new Uint8Array(MAX_BYTES + 1);
    let length = 0;
    try {
        while (length < bytes.length) {
            const chunk = await asyncCall(stream, 'read_bytes', bytes.length - length, PRIORITY, null);
            if (chunk.get_size() === 0) break;
            bytes.set(chunk.get_data(), length);
            length += chunk.get_size();
        }
    } finally {
        await asyncCall(stream, 'close', PRIORITY, null);
    }
    if (length > MAX_BYTES) throw new Error('incident history exceeds 64 KiB');

    const etag = info.get_etag();
    let doc;
    try {
        doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    } catch {
        // JSON syntax errors may quote the file's contents. Keep logs generic.
        return { captures: [], etag, problem: 'invalid incident history JSON' };
    }
    if (Number.isSafeInteger(doc?.version) && doc.version !== VERSION)
        throw new Error(`unsupported incident history version ${doc.version}`);
    try {
        if (doc?.version !== VERSION) throw new Error('missing incident history version');
        return { captures: snapshots(doc.captures), etag };
    } catch (error) {
        return { captures: [], etag, problem: error.message };
    }
}

async function drain(path, queue) {
    while (queue.current) {
        const job = queue.current;
        const saved = await job.store._write(job.bytes);
        queue.current = queue.pending;
        queue.pending = null;
        if (!queue.current) writes.delete(path);
        job.resolve(saved);
    }
}

export class IncidentStore {
    constructor(path = incidentPath(), onProblem = message => logOnce(message)) {
        this._file = Gio.File.new_for_path(path);
        this.path = this._file.get_path();
        this._onProblem = onProblem;
        this._reported = new Set();
    }

    _report(problem) {
        if (!problem || this._reported.has(problem) || this._reported.size >= 8) return;
        this._reported.add(problem);
        const message = `ResourcePulse: ${this.path}: ${problem}`;
        try {
            this._onProblem(message);
        } catch {
            logOnce(message);
        }
    }

    /** Read the completed history, waiting for any earlier save of this path. */
    async load() {
        for (let queue = writes.get(this.path); queue; queue = writes.get(this.path))
            await (queue.pending ?? queue.current).done;
        try {
            const { captures, problem } = await read(this._file);
            this._report(problem);
            return captures;
        } catch (error) {
            this._report(error.message);
            return [];
        }
    }

    /** Persist the snapshot. Concurrent calls coalesce into the latest one. */
    save(captures) {
        let bytes;
        try {
            const contents = JSON.stringify({ version: VERSION, captures: snapshots(captures) });
            bytes = new GLib.Bytes(new TextEncoder().encode(contents));
            if (bytes.get_size() > MAX_BYTES) throw new Error('incident history exceeds 64 KiB');
        } catch (error) {
            this._report(error.message);
            return Promise.resolve(false);
        }

        const queue = writes.get(this.path);
        if (queue?.pending) {
            queue.pending.bytes = bytes;
            queue.pending.store = this;
            return queue.pending.done;
        }
        const job = { store: this, bytes, resolve: null, done: null };
        job.done = new Promise(resolve => { job.resolve = resolve; });
        if (queue) {
            queue.pending = job;
        } else {
            const created = { current: job, pending: null };
            writes.set(this.path, created);
            drain(this.path, created);
        }
        return job.done;
    }

    async _write(bytes) {
        try {
            const { etag, problem } = await read(this._file);
            this._report(problem);
            await makeParents(this._file.get_parent());
            const flags = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;
            await asyncCall(this._file, 'replace_contents_bytes', bytes, etag, false, flags, null);
            return true;
        } catch (error) {
            this._report(error.message);
            return false;
        }
    }
}
