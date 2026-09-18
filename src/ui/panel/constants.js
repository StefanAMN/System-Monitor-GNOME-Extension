// Constants shared by the panel modules (moved from extension.js).

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
export const METRIC_NAMES = {
    cpu: 'CPU', memory: 'Memory', battery: 'Battery', power: 'Power',
    disk: 'Disk', network: 'Network', thermal: 'Temperature', gpu: 'GPU'
};
// Alerts watch metrics that are not pinned too; the slower ones less often.
export const ALERT_DISK_EVERY_US = 60e6;
export const ALERT_GPU_EVERY_US = 30e6;
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
// Rows in each top-process list (the sampler is asked for this many).
export const PROCESS_ROWS = 5;
// Share of time (PSI "some", 10 s average) in which programs waited for
// memory that raises an alert: well past the occasional reclaim stall.
export const PRESSURE_LIMIT = 20;
// Panel page and wording per alert.
export const ALERTS = {
    cpu: { tab: 'cpu', name: 'CPU', title: 'CPU usage is high' },
    memory: { tab: 'memory', name: 'Memory', title: 'Memory is almost full' },
    thermal: { tab: 'thermal', name: 'Temperature', title: 'The processor is hot' },
    gpu: { tab: 'gpu', name: 'GPU', title: 'GPU usage is high' },
    disk: { tab: 'disk', name: 'Disk /', title: 'Disk space is running out' },
    pressure: { tab: 'memory', name: 'Waiting for memory', title: 'The system is short of memory' },
};
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
