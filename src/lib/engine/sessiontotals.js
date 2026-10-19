// Figures that cover the login session (network totals, the power average and
// peak) carried across the screen lock, during which GNOME disables
// extensions. disable() writes them to a small file in the runtime directory
// (per user, gone at logout) and the next enable() of the same session takes
// them back: no module state outlives disable(), as the review rules ask.
//
// "The same session" is the same shell process in the same boot: a lock keeps
// it, a new login or a reboot does not. Engine layer.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { noteReadError } from '../common/utils.js';

const VERSION = 1;

/** The session: boot id, and the shell process's id and start time (ticks since boot). */
export function sessionIdentity(bootId, pid, startTicks) {
    return `${bootId}/${pid}/${startTicks}`;
}

/** This shell's session, from /proc/self/stat (read once per enable). */
export function currentSessionIdentity(bootId) {
    const stat = new TextDecoder().decode(GLib.file_get_contents('/proc/self/stat')[1]);
    // After the command name (which may hold spaces), fields from the 3rd on.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return sessionIdentity(bootId, stat.slice(0, stat.indexOf(' ')), fields[19]);
}

export function sessionStatePath() {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'resource-pulse-session.json']);
}

/**
 * @param {string} identity sessionIdentity()
 * @param {{net: {rx: number, tx: number, counters: object[]}, power: object}} figures
 */
export function sessionStateText(identity, figures) {
    return JSON.stringify({ version: VERSION, session: identity, ...figures });
}

/**
 * The figures saved by this session, or null: another session's file (an
 * earlier login, before a reboot), an older format or a damaged file.
 * @returns {?{net: {rx: number, tx: number, counters: {iface: string, rxBytes: number, txBytes: number}[]}, power: object}}
 */
export function parseSessionState(text, identity) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return null;
    }
    if (doc?.version !== VERSION || doc.session !== identity) return null;
    const n = v => Number.isFinite(v) && v >= 0;
    const net = doc.net;
    if (!net || !n(net.rx) || !n(net.tx) || !Array.isArray(net.counters)) return null;
    const counters = net.counters.filter(c => typeof c?.iface === 'string' && n(c.rxBytes) && n(c.txBytes));
    return { net: { rx: net.rx, tx: net.tx, counters }, power: doc.power ?? null };
}

/** The figures saved by this session, or null. */
export function loadSessionState(path, identity) {
    return new Promise(resolve => Gio.File.new_for_path(path).load_contents_async(null, (obj, res) => {
        try {
            const [, bytes] = obj.load_contents_finish(res);
            resolve(parseSessionState(new TextDecoder().decode(bytes), identity));
        } catch (e) {
            // No file yet is the normal case (the first enable of a session).
            noteReadError(e);
            resolve(null);
        }
    }));
}

/** Written from disable(), which cannot wait: synchronously, a few hundred bytes to tmpfs. */
export function saveSessionState(path, identity, figures) {
    GLib.file_set_contents(path, sessionStateText(identity, figures));
}
