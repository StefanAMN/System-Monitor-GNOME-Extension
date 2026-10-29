// Constants shared by the panel modules (moved from extension.js).
import { N_, translated } from '../../lib/common/i18n.js';

// ─── Polling / history constants ─────────────────────────────────────────────

export const HISTORY_CAPACITY = 60;
// On-demand refreshes closer than this to the previous sample reuse it:
// counter deltas over a few milliseconds are mostly noise.
export const MIN_RESAMPLE_US = 500000;
// A collector that has not answered by then is skipped for this poll (its
// previous value stands in) so one stuck read cannot freeze every metric.
export const POLL_DEADLINE_MS = 3000;
// Free panel space required beyond a hidden top-bar label's own width before
// it is shown again, so a value changing width cannot make it flap.
export const TOP_BAR_FIT_MARGIN_PX = 16;
// Height of the trend graph / detail line of an overview card.
export const CARD_SLOT_HEIGHT = 22;
export const METRIC_NAMES = translated({
    cpu: N_('CPU'), memory: N_('Memory'), battery: N_('Battery'), power: N_('Power'),
    disk: N_('Disk'), network: N_('Network'), thermal: N_('Temperature'), gpu: N_('GPU')
});
// Alerts watch metrics that are not pinned too; the slower ones less often.
export const ALERT_DISK_EVERY_US = 60e6;
export const ALERT_GPU_EVERY_US = 30e6;
// The two reads that cost most (nvidia-smi is a process of its own, the process
// list walks /proc) are not repeated faster than this at short intervals, a
// little under a second so that a 1 s timer still reads them each time.
export const GPU_EVERY_US = 900000;
export const PROCESS_EVERY_US = 900000;
// A metric silent for longer than 2.5 intervals was not being read; below
// this floor a busy moment of the shell is not that.
export const MIN_GAP_US = 2.5e6;
// Network, battery and power are read this often while not shown, so the
// 1 h / 24 h charts and the network day totals have no holes.
export const BACKGROUND_EVERY_US = 60e6;
// Network day totals are written at most this often (and on disable).
export const NET_USAGE_SAVE_US = 5 * 60e6;
// Gliding between readings. Any visible change redraws the open panel, and
// in the software-rendered test shell each redraw costs about 0.5 % of a
// core per frame per second whatever changed (measured: one label or one
// bar at 15 fps, +7-8 %). 4 frames a second (8 steps per 2 s glide) stays
// within the menu-open budget. With the menu closed there are no frames at
// all: gliding the top bar cost about 0.4 % around the clock, which broke
// the 1 % menu-closed budget; it shows the averaged values once per reading.
export const GLIDE_FRAME_MS = 250;
// A glide lasts one interval, but no longer than this: at 30 s the values
// would still be on their way when the next reading came.
export const GLIDE_MAX_US = 2e6;
// Rows in each top-process list (the sampler is asked for this many).
export const PROCESS_ROWS = 5;
// Rows a process search shows at most (matches, busiest first).
export const SEARCH_ROWS = 10;
// Share of time (PSI "some", 10 s average) in which programs waited for
// memory that raises an alert: well past the occasional reclaim stall.
export const PRESSURE_LIMIT = 20;
// The processor slowed down to cool this share of the time, for 30 s: an alert.
export const THROTTLE_LIMIT = 20;
// Panel page, the top-bar value painted red, and wording per alert.
// Ids and labels together, so the labels (N_) are translated where read.
export const ALERTS = {
    cpu: { tab: 'cpu', value: 'cpu', name: N_('CPU'), title: N_('CPU usage is high') },
    memory: { tab: 'memory', value: 'memory', name: N_('Memory'), title: N_('Memory is almost full') },
    thermal: { tab: 'thermal', value: 'thermal', name: N_('Temperature'), title: N_('The processor is hot') },
    gpu: { tab: 'gpu', value: 'gpu', name: N_('GPU'), title: N_('GPU usage is high') },
    disk: { tab: 'disk', value: 'disk', name: N_('Disk /'), title: N_('Disk space is running out') },
    // Programs waiting for memory: the ⚠ and its tooltip say so, but the
    // memory value is not painted red, as its percentage can be far from its
    // limit (a 29 % value in red read as a false warning).
    pressure: { tab: 'memory', value: null, name: N_('Waiting for memory'), title: N_('The system is short of memory') },
    battery: { tab: 'battery', value: 'battery', name: N_('Battery'), title: N_('The battery is low') },
    // Slowed down to cool: the temperature itself may be under its limit, so no value turns red.
    throttle: { tab: 'thermal', value: null, name: N_('Slowed by heat'), title: N_('The processor slows down to cool') },
};
// GPUs with a chart of their own on a machine with several (their series are
// allocated when they appear, so this bounds the memory).
export const GPU_CHARTS = 4;
export const HISTORY_KEYS = ['cpu', 'mem', 'bat', 'batRate', 'pwr', 'dskRead', 'dskWrite', 'netRx', 'netTx', 'thm', 'gpu'];

export const WATT_SCALE = { autoScale: true, maxVal: 10, formatValue: v => `${v < 10 ? v.toFixed(1) : Math.round(v)}W` };
export const MBS_SCALE = { autoScale: true, maxVal: 1, formatValue: v => (v < 10 ? v.toFixed(1) : `${Math.round(v)}`) };
export const KBS_SCALE = { autoScale: true, maxVal: 10, formatValue: v => (v >= 1000 ? `${(v / 1000).toFixed(1)}M` : `${Math.round(v)}K`) };
// Per-history axis: unit of the stored samples and the floor of the auto scale.
export const SPARK_SCALES = {
    batRate: WATT_SCALE,
    pwr: WATT_SCALE,
    dskRead: MBS_SCALE,
    dskWrite: MBS_SCALE,
    netRx: KBS_SCALE,
    netTx: KBS_SCALE
};
// What a screen reader calls each detail chart (the values are in the rows).
export const CHART_NAMES = translated({
    cpu: N_('CPU usage'), mem: N_('Memory use'), bat: N_('Battery charge'), batRate: N_('Battery charge rate'), pwr: N_('Power draw'),
    dskRead: N_('Disk read rate'), dskWrite: N_('Disk write rate'), netRx: N_('Download rate'), netTx: N_('Upload rate'),
    thm: N_('Temperature'), gpu: N_('GPU usage')
});
// Opening the preferences window: tries, and the pause between them, when
// GNOME's preferences service is quitting as the request arrives.
export const PREFS_OPEN_ATTEMPTS = 3;
export const PREFS_RETRY_MS = 500;
