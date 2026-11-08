// Detailed memory is a one-shot read. smaps_rollup walks process mappings
// under a kernel lock, so run it in a GIO worker, one process at a time.
import Gio from 'gi://Gio';

import { logOnce, noteReadError, readFileAsync } from '../common/utils.js';
import { parseStatBlob } from './process.js';

/** Private resident bytes, plus the proportional share of shared bytes. */
export function parseSmapsRollup(text) {
    const bytes = name => {
        const match = new RegExp(`^${name}:[ \\t]+(\\d+)[ \\t]+kB[ \\t]*$`, 'm').exec(text);
        return match ? Number(match[1]) * 1024 : NaN;
    };
    const pss = bytes('Pss');
    const privateBytes = bytes('Private_Clean') + bytes('Private_Dirty');
    if (!Number.isSafeInteger(pss) || !Number.isSafeInteger(privateBytes) || pss < privateBytes) return null;
    // The kernel excludes explicit HugeTLB pages from these three fields.
    return { privateBytes, sharedBytes: pss - privateBytes, pss };
}

/** A process still has the identity recorded when the row was sampled. */
function matchesMember(text, member) {
    const [row] = parseStatBlob(text);
    return row?.pid === member.pid && row.start === member.start && !['Z', 'X', 'x'].includes(row.state);
}

export class ProcessMemoryInspector {
    constructor(proc = '/proc') {
        this._proc = proc;
        this._cancellable = null;
    }

    get busy() {
        return this._cancellable !== null;
    }

    cancel() {
        this._cancellable?.cancel();
    }

    /**
     * Totals of the readable members of a row, or null if cancelled/busy.
     * A group means processes with the same name at the last list sample.
     * @param {{pid: number, start: number}[]} members
     */
    async sample(members) {
        if (this.busy) return null;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const result = { measured: 0, total: members.length, privateBytes: 0, sharedBytes: 0, pss: 0 };
        try {
            for (const member of members) {
                if (cancellable.is_cancelled()) return null;
                if (!Number.isSafeInteger(member.pid) || member.pid < 1 || !Number.isSafeInteger(member.start) || member.start < 0) continue;
                const base = `${this._proc}/${member.pid}`;
                try {
                    if (!matchesMember(await readFileAsync(`${base}/stat`, cancellable), member)) continue;
                    const memory = parseSmapsRollup(await readFileAsync(`${base}/smaps_rollup`, cancellable));
                    if (!memory) continue;
                    // A PID may disappear or be reused between stat and smaps_rollup.
                    if (!matchesMember(await readFileAsync(`${base}/stat`, cancellable), member)) continue;
                    result.measured++;
                    result.privateBytes += memory.privateBytes;
                    result.sharedBytes += memory.sharedBytes;
                    result.pss += memory.pss;
                } catch (e) {
                    if (cancellable.is_cancelled()) return null;
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED))
                        logOnce('ResourcePulse: some process memory readings are not permitted');
                    else noteReadError(e);
                }
            }
            return cancellable.is_cancelled() ? null : result;
        } finally {
            this._cancellable = null;
        }
    }
}
