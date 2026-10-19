import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const textDecoder = new TextDecoder('utf-8');

/**
 * Asynchronously read a file and decode as UTF-8 string using a shared TextDecoder.
 * Fails soft by rejecting the promise.
 * @param {string} path
 * @returns {Promise<string>}
 */
export function readFileAsync(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
            try {
                const [, contents] = obj.load_contents_finish(res);
                resolve(textDecoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const reportedReadErrors = new Set();
const loggedOnce = new Set();

/**
 * Log `message` the first time only: for an error the polling loop can hit
 * on every poll (a collector failing the same way), which would otherwise
 * flood the journal. Bounded like noteReadError.
 * @param {string} message
 * @param {'warn'|'error'} [level]
 * @returns {boolean} true when it was logged
 */
export function logOnce(message, level = 'warn') {
    if (loggedOnce.has(message) || loggedOnce.size >= 200) return false;
    loggedOnce.add(message);
    console[level](message);
    return true;
}

/**
 * Forget what this module logged and cached, so nothing found in one session
 * outlives disable() (the review rules: dynamic module data is cleared there).
 */
export function resetUtils() {
    reportedReadErrors.clear();
    loggedOnce.clear();
    sysconfPromise = null;
}

/**
 * For the catch block around an optional read. A file that is simply not
 * there is the expected outcome on hardware without that feature and stays
 * silent; anything else (permission denied, I/O error, a parsing bug) is
 * logged once per distinct message, so it is visible in the journal without
 * flooding it from the polling loop.
 * @returns {boolean} true when the error was logged
 */
export function noteReadError(e) {
    if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
        e?.matches?.(GLib.FileError, GLib.FileError.NOENT)) return false;
    const message = e?.message ?? String(e);
    // Bounded: distinct messages are per path, and paths are finite.
    if (reportedReadErrors.has(message) || reportedReadErrors.size >= 200) return false;
    reportedReadErrors.add(message);
    console.warn(`ResourcePulse: ${message}`);
    return true;
}

/**
 * Asynchronously list directory entries (file/folder names).
 * Fails soft by returning an empty array on error (a missing directory
 * silently, anything else logged once).
 * @param {string} path
 * @returns {Promise<string[]>}
 */
export function listDirAsync(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.enumerate_children_async(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => {
                try {
                    const enumerator = obj.enumerate_children_finish(res);
                    const files = [];
                    try {
                        let info;
                        while ((info = enumerator.next_file(null))) {
                            files.push(info.get_name());
                        }
                    } finally {
                        // Without this the directory fd stays open until the
                        // enumerator is garbage collected.
                        enumerator.close(null);
                    }
                    resolve(files);
                } catch (e) {
                    noteReadError(e);
                    resolve([]);
                }
            }
        );
    });
}

/**
 * Asynchronously check whether a path exists (follows symlinks).
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export function existsAsync(path) {
    return new Promise((resolve) => {
        Gio.File.new_for_path(path).query_info_async(
            'standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => {
                try {
                    obj.query_info_finish(res);
                    resolve(true);
                } catch (e) {
                    noteReadError(e);
                    resolve(false);
                }
            }
        );
    });
}

/**
 * Asynchronously execute a subprocess with non-blocking I/O.
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] kill the child if it has not exited by
 *   then (0 = wait forever). A killed child resolves with success false.
 * @param {{cancel?: Function}} [opts.handle] receives cancel() while the child
 *   runs: it kills the child and drops the timer (for a caller's teardown).
 * @returns {Promise<{success: boolean, stdout: string, stderr: string}>}
 */
export function runSubprocess(argv, { timeoutMs = 0, handle = null } = {}) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
            let timerId = 0;
            let killed = false;
            const kill = () => {
                killed = true;
                if (timerId) {
                    GLib.source_remove(timerId);
                    timerId = 0;
                }
                proc.force_exit();
            };
            if (timeoutMs > 0) {
                timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                    timerId = 0;
                    kill();
                    return GLib.SOURCE_REMOVE;
                });
            }
            if (handle) handle.cancel = kill;
            proc.communicate_utf8_async(null, null, (obj, res) => {
                if (timerId) {
                    GLib.source_remove(timerId);
                    timerId = 0;
                }
                if (handle) handle.cancel = null;
                try {
                    const [, stdout, stderr] = obj.communicate_utf8_finish(res);
                    if (killed)
                        resolve({ success: false, stdout: '', stderr: `${argv[0]} did not finish and was killed` });
                    else
                        resolve({ success: true, stdout: stdout || '', stderr: stderr || '' });
                } catch (e) {
                    resolve({ success: false, stdout: '', stderr: e.message });
                }
            });
        } catch (e) {
            resolve({ success: false, stdout: '', stderr: e.message });
        }
    });
}

let sysconfPromise = null;

/**
 * Kernel constants needed to turn /proc counters into real units.
 * Resolved once per shell session.
 * @returns {Promise<{clkTck: number, pageSize: number}>}
 */
export function getSysconf() {
    if (!sysconfPromise) {
        sysconfPromise = runSubprocess(['getconf', '-a'], { timeoutMs: 5000 }).then(res => {
            const pick = (name, fallback) => {
                const m = res.stdout.match(new RegExp(`^${name}\\s+(\\d+)`, 'm'));
                return m ? parseInt(m[1], 10) : fallback;
            };
            return { clkTck: pick('CLK_TCK', 100), pageSize: pick('PAGESIZE', 4096) };
        });
    }
    return sysconfPromise;
}
