// The one privileged action this extension can trigger, kept in a single
// place so the panel menu and the preferences window run the same thing.
//
// Security note: making energy_uj world-readable lets any local process
// observe CPU package energy at high resolution, which is a known side
// channel (PLATYPUS, CVE-2020-8694); kernels restrict it to root for that
// reason. It is opt-in, and RAPL_FIX_WARNING must be shown before running it.

const RULE_PATH = '/etc/udev/rules.d/99-powercap-read.rules';
const RULE = 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod a+r /sys/class/powercap/%k/energy_uj"';

const SCRIPT = `set -e
printf '%s\\n' '${RULE}' > ${RULE_PATH}
udevadm control --reload-rules
udevadm trigger --subsystem-match=powercap
chmod a+r /sys/class/powercap/*/energy_uj 2>/dev/null || true
`;

export const RAPL_FIX_ARGV = ['pkexec', '/bin/sh', '-c', SCRIPT];

export const RAPL_FIX_WARNING =
    'Makes CPU energy counters readable by every local program (a known side channel). ' +
    `Undo by deleting ${RULE_PATH}.`;
