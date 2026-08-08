import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { getSysconf } from './utils.js';

// Lenient decoder: process names are arbitrary bytes, not guaranteed UTF-8.
const decoder = new TextDecoder('utf-8', { fatal: false });

// Offsets into the fields that follow "pid (comm) " in /proc/[pid]/stat.
// proc(5) numbers fields from 1 with state as field 3.
const F_UTIME = 14 - 3;
const F_STIME = 15 - 3;
const F_STARTTIME = 22 - 3;
const F_RSS = 24 - 3;
const MIN_FIELDS = F_RSS + 1;

/**
 * Parse the concatenation of many /proc/[pid]/stat files.
 * comm may contain spaces, parentheses and newlines, so each record is split
 * at its last ')' and a record is only complete once enough fields follow it.
 * @param {string} text
 * @returns {{pid: number, comm: string, ticks: number, start: number, rss: number}[]}
 */
export function parseStatBlob(text) {
    const out = [];
    const lines = text.split('\n');
    let pending = '';
    for (const line of lines) {
        const record = pending ? `${pending}\n${line}` : line;
        const close = record.lastIndexOf(')');
        const open = record.indexOf('(');
        if (open < 0 || close < open) {
            pending = open >= 0 ? record : '';
            continue;
        }
        const fields = record.slice(close + 2).split(' ');
        if (fields.length < MIN_FIELDS) {
            pending = record;
            continue;
        }
        pending = '';
        const pid = parseInt(record.slice(0, open), 10);
        if (!(pid > 0)) continue;
        out.push({
            pid,
            comm: record.slice(open + 1, close),
            ticks: Number(fields[F_UTIME]) + Number(fields[F_STIME]),
            start: Number(fields[F_STARTTIME]),
            rss: Number(fields[F_RSS])
        });
    }
    return out;
}

/**
 * CPU share of one process between two samples, top-style: 100 = one full core.
 * A reused PID (different start time) or a counter going backwards yields 0.
 */
export function cpuPercent(prev, cur, deltaSeconds, clkTck) {
    if (!prev || prev.start !== cur.start || !(deltaSeconds > 0)) return 0;
    const dTicks = cur.ticks - prev.ticks;
    if (!(dTicks > 0)) return 0;
    return (dTicks / clkTck / deltaSeconds) * 100;
}

function readAllStats() {
    return new Promise((resolve) => {
        try {
            // One short-lived child instead of ~N async file reads on the
            // compositor's main loop. Processes that exit mid-glob make cat
            // print ENOENT/ESRCH to stderr, which is expected and discarded.
            const proc = new Gio.Subprocess({
                argv: ['/bin/sh', '-c', 'exec cat /proc/[0-9]*/stat 2>/dev/null'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE
            });
            proc.init(null);
            proc.communicate_async(null, null, (obj, res) => {
                try {
                    const [, stdout] = obj.communicate_finish(res);
                    resolve(stdout ? decoder.decode(stdout.toArray()) : '');
                } catch (e) {
                    console.error(`Process sample failed: ${e.message}`);
                    resolve('');
                }
            });
        } catch (e) {
            console.error(`Process sample failed: ${e.message}`);
            resolve('');
        }
    });
}

export class ProcessSampler {
    constructor() {
        this._prev = new Map(); // pid -> { start, ticks, seen }
        this._prevTime = 0;
        this._seq = 0;
    }

    /**
     * @param {number} memTotal total RAM in bytes (for mem %)
     * @param {boolean} byMemory sort by resident memory instead of CPU
     * @param {number} limit rows to return
     */
    async sample(memTotal, byMemory = false, limit = 5) {
        const { clkTck, pageSize } = await getSysconf();
        const text = await readAllStats();
        const now = GLib.get_monotonic_time();
        const dt = this._prevTime > 0 ? (now - this._prevTime) / 1000000 : 0;
        const seq = ++this._seq;

        const rows = parseStatBlob(text);
        for (const row of rows) {
            const prev = this._prev.get(row.pid);
            row.cpu = cpuPercent(prev, row, dt, clkTck);
            row.rssBytes = row.rss * pageSize;
            row.mem = memTotal > 0 ? (row.rssBytes / memTotal) * 100 : 0;
            if (prev) {
                prev.start = row.start;
                prev.ticks = row.ticks;
                prev.seen = seq;
            } else {
                this._prev.set(row.pid, { start: row.start, ticks: row.ticks, seen: seq });
            }
        }
        // Exited processes must not accumulate.
        for (const [pid, prev] of this._prev) {
            if (prev.seen !== seq) this._prev.delete(pid);
        }
        this._prevTime = now;

        rows.sort(byMemory
            ? (a, b) => b.rss - a.rss
            : (a, b) => (b.cpu - a.cpu) || (b.rss - a.rss));
        return {
            warmingUp: dt === 0,
            count: rows.length,
            top: rows.slice(0, limit)
        };
    }

    reset() {
        this._prev.clear();
        this._prevTime = 0;
    }
}
