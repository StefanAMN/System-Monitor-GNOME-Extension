// Making the CPU energy counters readable: something only root can do, so the
// extension does not do it. The preferences window shows these commands and
// copies them for the user to run in a terminal (extensions.gnome.org's rules:
// privileged subprocesses are avoided at all costs, and must never run a
// script a user process could change, as one written in this file could).
//
// Security note: making energy_uj world-readable lets any local process
// observe CPU package energy at high resolution, which is a known side
// channel (PLATYPUS, CVE-2020-8694); kernels restrict it to root for that
// reason. It is opt-in, and raplFixWarning() is shown with the commands.
import { _, fill } from './i18n.js';

const RULE_PATH = '/etc/udev/rules.d/99-powercap-read.rules';
const RULE = 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod a+r /sys/class/powercap/%k/energy_uj"';

/**
 * The commands, one per line: the udev rule that opens the counters at every
 * boot, then the same for this boot. (Re-running the rule now would need
 * "add" events; udevadm trigger sends "change" by default.)
 */
export const RAPL_FIX_COMMANDS = [
    `echo '${RULE}' | sudo tee ${RULE_PATH}`,
    'sudo chmod a+r /sys/class/powercap/*/energy_uj',
].join('\n');

export function raplFixWarning() {
    return fill(_('Makes CPU energy counters readable by every local program (a known side channel). Undo by deleting {path}.'), { path: RULE_PATH });
}
