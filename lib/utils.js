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

/**
 * Asynchronously list directory entries (file/folder names).
 * Fails soft by returning an empty array on error.
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
                    let info;
                    while ((info = enumerator.next_file(null))) {
                        files.push(info.get_name());
                    }
                    resolve(files);
                } catch (_e) {
                    resolve([]);
                }
            }
        );
    });
}

/**
 * Asynchronously execute a subprocess with non-blocking I/O.
 * @param {string[]} argv
 * @returns {Promise<{success: boolean, stdout: string, stderr: string}>}
 */
export function runSubprocess(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (obj, res) => {
                try {
                    const [, stdout, stderr] = obj.communicate_utf8_finish(res);
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
