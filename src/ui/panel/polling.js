// The poll loop (Aggregator side): which collectors run, history (live and 1 h / 24 h), network day totals, battery tracking, and gliding the shown values.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { BatteryTracker } from '../../lib/engine/batterytracker.js';
import { powerReadout, thermalUnavailable } from '../../lib/common/present.js';
import { RANGES, BucketSeries } from '../../lib/engine/longhistory.js';
import { RingBuffer } from '../../lib/engine/ringbuffer.js';
import { DisplayAverage, interpolateReading, glideBuffer } from '../../lib/engine/smoothing.js';
import { saveNetUsage, netUsagePath } from '../../lib/engine/netusage.js';
import { Sparkline } from './widgets.js';
import { formatTemp } from '../../lib/common/format.js';
import { _, fill } from '../../lib/common/i18n.js';
import { logOnce } from '../../lib/common/utils.js';
import { HISTORY_CAPACITY, GPU_CHARTS, MIN_RESAMPLE_US, POLL_DEADLINE_MS, ALERT_DISK_EVERY_US, ALERT_GPU_EVERY_US, GPU_EVERY_US, PROCESS_EVERY_US, MIN_GAP_US, GLIDE_MAX_US, BACKGROUND_EVERY_US, NET_USAGE_SAVE_US, GLIDE_FRAME_MS, PROCESS_ROWS, SEARCH_ROWS, SPARK_SCALES, CHART_NAMES } from './constants.js';

export class PollingMethods {
    /** Pinned metrics as stored, minus unknown keys and duplicates. */
    /** Start or stop battery tracking to match the setting. */
    _syncTracking() {
        const wanted = this._settings.get_boolean('battery-tracking');
        if (wanted && !this._tracker) {
            const windows = Shell.WindowTracker.get_default();
            this._tracker = new BatteryTracker({
                battery: this._bat,
                thermal: this._thm,
                hotAbove: () => this._settings.get_int('threshold-temp'),
                idleMs: () => global.backend.get_core_idle_monitor().get_idletime(),
                focus: {
                    current: () => windows.focus_app?.get_id()?.replace(/\.desktop$/, '') ?? null,
                    connect: callback => windows.connect('notify::focus-app', callback),
                    disconnect: id => windows.disconnect(id),
                },
            });
            this._tracker.start().catch(e => console.error(`ResourcePulse: battery tracking did not start: ${e.message}`));
        } else if (!wanted && this._tracker) {
            // Switched off: the time until it is switched on again is not a gap.
            this._tracker.stop({ forget: true });
            this._tracker = null;
        }
        this._refreshTopApp();
    }

    _startPolling() {
        if (this._timeoutId) GLib.source_remove(this._timeoutId);
        const intervalMs = this._settings.get_int('poll-interval-ms');
        const interval = intervalMs / 1000;
        this._glideUs = Math.min(intervalMs * 1000, GLIDE_MAX_US);
        this._gapUs = Math.max(2.5 * intervalMs * 1000, MIN_GAP_US);

        // Samples taken at another cadence would distort the time axis.
        for (const key of this._histKeys) this._hist[key].clear();
        const span = Math.round(interval * HISTORY_CAPACITY);
        // Translators: how much a chart shows, kept short: "2m", "60s".
        const spanLabel = span > 60 && span % 60 === 0 ? fill(_('{m}m'), { m: span / 60 }) : fill(_('{s}s'), { s: span });
        this._spanLabel = spanLabel;
        this._sampleSeconds = interval;
        this._pwrStats.maxGapS = this._gapUs / 1e6;
        for (const spark of this._sparklines) {
            spark.setSpanLabel(spanLabel);
            spark.setSampleSeconds(interval);
        }
        this._applyRange();

        this._poll();
        const tick = () => {
            this._poll(true);
            return GLib.SOURCE_CONTINUE;
        };
        // Whole seconds wake together with the rest of the session's timers.
        this._timeoutId = intervalMs % 1000 === 0
            ? GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, tick)
            : GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, tick);
    }

    _deferPoll(waitUs) {
        if (this._deferredPollId || this._indicatorGone) return;
        this._deferredPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(waitUs / 1000), () => {
            this._deferredPollId = null;
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {boolean} [topBarOnly] menu closed: the panel is not drawn
     * @param {boolean} [frame] a glide frame, not a new reading: the charts
     *   (Cairo, costly to repaint) change only with a new sample
     */
    _render(data, topBarOnly = false, frame = false) {
        this._updateTopBarUI(data, frame);
        if (!topBarOnly) this._updateDashboardUI(data, frame);
        // A glide's start shows the last reading; its end (below) the new one.
        if (!frame && !this._glideId) this._nameValues();
    }

    _smoothOn() {
        return this._settings?.get_boolean('smooth-transitions') ?? false;
    }

    /** The reading as shown right now: part of the way through the glide. */
    _shownNow(now = GLib.get_monotonic_time(), out = null) {
        if (!this._shownTo) return null;
        const t = this._glideUs > 0 ? (now - this._shownAt) / this._glideUs : 1;
        return interpolateReading(this._shownFrom, this._shownTo, t, out);
    }

    /**
     * A new reading: glide from what is shown now to it (CPU, GPU, power,
     * network and disk averaged over 10 s first) over one polling interval, at most
     * GLIDE_MAX_US, so the values arrive by the time the next reading does.
     */
    _present(data) {
        const now = GLib.get_monotonic_time();
        if (!this._smoothOn()) {
            this._shownFrom = null;
            this._shownTo = data;
            this._average = null;
            this._render(data);
            return;
        }
        this._average ??= new DisplayAverage();
        const target = this._average.add(data, now);
        if (!this._menuOpen) {
            // Closed: averaged values, once per reading, no frames.
            this._shownFrom = null;
            this._shownTo = target;
            this._shownAt = now;
            this._render(target, true);
            return;
        }
        this._shownFrom = this._shownNow(now);
        this._shownTo = target;
        this._shownAt = now;
        this._render(this._shownNow(now));
        this._runGlide();
    }

    /** Frames, while the menu is open, until the glide has arrived. */
    _runGlide() {
        if (this._glideId || this._indicatorGone) return;
        this._glideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLIDE_FRAME_MS, () => {
            const now = GLib.get_monotonic_time();
            const done = !this._smoothOn() || !this._menuOpen || now - this._shownAt >= this._glideUs;
            // Frames write into one reused buffer; a new reading copies it
            // as the next glide's start (_present), so no frame allocates a
            // whole new reading.
            this._glideBuf ??= glideBuffer();
            const shown = done ? this._shownTo : this._shownNow(now, this._glideBuf);
            if (shown) this._render(shown, !this._menuOpen, true);
            if (done) {
                this._glideId = 0;
                this._nameValues();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _pushHistory(key, value, now) {
        // A metric that was not sampled for a while (unpinned with the menu
        // closed) restarts its graph instead of joining stale and fresh points.
        const last = this._histStamp[key] || 0;
        if (last && now - last > this._gapUs) this._hist[key].clear();
        this._histStamp[key] = now;
        this._hist[key].push(value);
    }

    _recordHistory(data, need, now) {
        const MB = 1000000;
        if (need.cpu) this._pushHistory('cpu', data.cpu.total, now);
        if (need.mem) this._pushHistory('mem', data.mem.percent, now);
        if (need.bat && data.bat.present) {
            this._pushHistory('bat', data.bat.percent, now);
            this._pushHistory('batRate', data.bat.energyRate || 0, now);
        }
        if (need.pwr && (data.pwr.raplSupported || data.pwr.systemPower !== null))
            this._pushHistory('pwr', data.pwr.systemPower ?? data.pwr.packagePower ?? 0, now);
        if (need.dsk) {
            this._pushHistory('dskRead', data.dsk.readRate / MB, now);
            this._pushHistory('dskWrite', data.dsk.writeRate / MB, now);
        }
        if (need.net) {
            this._pushHistory('netRx', data.net.total.rxRate / 1000, now);
            this._pushHistory('netTx', data.net.total.txRate / 1000, now);
        }
        if (need.thm) this._pushHistory('thm', data.thm.packageTemp, now);
        if (need.gpu && data.gpu.present) {
            this._pushHistory('gpu', data.gpu.percent, now);
            if (data.gpu.gpus?.length > 1) {
                for (const g of data.gpu.gpus) {
                    const hist = this._gpuHistKey(g.key);
                    if (hist) this._pushHistory(hist, g.percent, now);
                }
            }
        }
    }

    /**
     * The series of one GPU of several: allocated once, when it first appears,
     * for at most GPU_CHARTS GPUs. Null for a GPU past those.
     */
    _gpuHistKey(key) {
        const known = this._gpuHist.get(key);
        if (known || this._gpuHist.size >= GPU_CHARTS) return known ?? null;
        const hist = `gpu:${key}`;
        this._gpuHist.set(key, hist);
        this._hist[hist] = new RingBuffer(HISTORY_CAPACITY);
        for (const [range, spec] of Object.entries(RANGES)) {
            if (spec) this._long[range][hist] = new BucketSeries(spec.bucketUs, spec.capacity);
        }
        this._histKeys.push(hist);
        return hist;
    }

    /**
     * Feed the 1 h / 24 h buckets with what this poll read; series of
     * metrics not read now only move on in time (their empty buckets become
     * gaps).
     */
    _recordLong(data, need, now) {
        const MB = 1000000;
        const values = {};
        if (need.cpu) values.cpu = data.cpu.total;
        if (need.mem) values.mem = data.mem.percent;
        if (need.bat && data.bat.present) {
            values.bat = data.bat.percent;
            values.batRate = data.bat.energyRate || 0;
        }
        if (need.pwr && (data.pwr.raplSupported || data.pwr.systemPower !== null))
            values.pwr = data.pwr.systemPower ?? data.pwr.packagePower ?? NaN;
        if (need.dsk) {
            values.dskRead = data.dsk.readRate / MB;
            values.dskWrite = data.dsk.writeRate / MB;
        }
        if (need.net) {
            values.netRx = data.net.total.rxRate / 1000;
            values.netTx = data.net.total.txRate / 1000;
        }
        if (need.thm && !thermalUnavailable(data.thm)) values.thm = data.thm.packageTemp;
        if (need.gpu && data.gpu.present) {
            values.gpu = data.gpu.percent;
            if (data.gpu.gpus?.length > 1) {
                for (const g of data.gpu.gpus) {
                    const hist = this._gpuHistKey(g.key);
                    if (hist) values[hist] = g.percent;
                }
            }
        }
        for (const series of Object.values(this._long)) {
            for (const key of this._histKeys) {
                if (key in values) series[key].add(values[key], now);
                else series[key].advance(now);
            }
        }
    }

    /** Add this reading's traffic to today's total; save now and then. */
    _countNetUsage(net, now) {
        // Both are read when the extension is enabled; until then nothing is counted.
        if (!this._netUsage || this._bootId === null) return;
        const physical = Object.entries(net.interfaces)
            .filter(([, i]) => !i.isVirtual)
            .map(([iface, i]) => ({ iface, rxBytes: i.rxBytes, txBytes: i.txBytes }));
        const day = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        if (this._netUsage.ingest(physical, this._bootId, day)) this._netUsageDirty = true;
        if (this._netUsageDirty && now - this._netUsageSavedAt >= NET_USAGE_SAVE_US) this._saveNetUsage(now);
    }

    _saveNetUsage(now = GLib.get_monotonic_time()) {
        if (!this._netUsage) return;
        this._netUsageSavedAt = now;
        this._netUsageDirty = false;
        saveNetUsage(netUsagePath(), this._netUsage).catch(e =>
            console.warn(`ResourcePulse: cannot save network usage: ${e.message}`));
    }

    /** Point the detail charts at the chosen range. */
    _applyRange() {
        const spec = RANGES[this._range];
        for (const spark of this._sparklines) {
            if (!spark.options.showGrid) continue;
            spark.history = spec ? this._long[this._range][spark.histKey] : this._hist[spark.histKey];
            spark.setSampleSeconds(spec ? spec.bucketUs / 1e6 : this._sampleSeconds);
            spark.setSpanLabel(spec ? _(spec.label) : this._spanLabel);
            spark.refresh();
        }
        for (const [range, button] of Object.entries(this._rangeButtons ?? {})) {
            if (range === this._range) button.add_style_class_name('rp-range-on');
            else button.remove_style_class_name('rp-range-on');
            button.checked = range === this._range;
        }
        if (this._rangeButtons?.live) this._rangeButtons.live.label = this._spanLabel || _('live');
    }

    /**
     * Run one collector under the poll's deadline. If it has not answered in
     * time the fallback (its previous value) is used, and it is not started
     * again until the outstanding call settles, so a hung read costs one
     * pending promise instead of one more per poll.
     * @param {string} key collector name
     * @param {Promise<void>} deadline resolves when the poll's time is up
     * @param {function(): Promise} start begins the sample
     * @param {*} fallback value to use when the collector is late or stuck
     */
    _guarded(key, deadline, start, fallback) {
        const outstanding = this._outstanding;
        if (outstanding[key]) return fallback;
        const sample = start();
        let settled = false;
        const settle = () => {
            settled = true;
            if (outstanding[key] === sample) delete outstanding[key];
        };
        outstanding[key] = sample;
        sample.then(settle, settle);
        return Promise.race([sample, deadline.then(() => {
            if (!settled)
                logOnce(`ResourcePulse: ${key} collector did not answer within ${POLL_DEADLINE_MS} ms; showing its last value`);
            return fallback;
        })]);
    }

    /**
     * Sample and render. Only one poll runs at a time.
     * tick=true is the periodic timer sample, the only kind recorded in
     * history so the time axis stays uniform. tick=false is an on-demand
     * refresh (menu opened, setting changed, refresh button).
     */
    async _poll(tick = false) {
        if (!this._settings || !this._indicator || this._indicatorGone) return;
        const now = GLib.get_monotonic_time();
        if (tick) {
            if (this._pollInFlight) {
                // The running on-demand sample stands in for this tick.
                this._recordPending = true;
                return;
            }
        } else {
            const wait = this._pollInFlight
                ? MIN_RESAMPLE_US
                : MIN_RESAMPLE_US - (now - this._lastPollTime);
            if (wait > 0) {
                if (this._lastData) this._render(this._shownNow() ?? this._lastData);
                this._deferPoll(wait);
                return;
            }
        }

        const gen = this._gen;
        this._pollInFlight = true;
        this._lastPollTime = now;
        try {
            const pinned = this._pinnedMetrics();
            const isOpen = this._menuOpen;
            const tab = this._activeTab;

            const isDetailedCpu = isOpen && tab === 'cpu';
            const isDetailedMem = isOpen && tab === 'memory';
            const isDetailedDsk = isOpen && tab === 'disk';
            const isDetailedThm = isOpen && tab === 'thermal';

            // While the menu is open every sampler runs so all graphs keep a
            // continuous history; only the expensive detail reads follow the tab.
            const shown = {
                cpu: isOpen || pinned.includes('cpu'),
                mem: isOpen || pinned.includes('memory'),
                bat: isOpen || pinned.includes('battery') || pinned.includes('power'),
                dsk: isOpen || pinned.includes('disk'),
                net: isOpen || pinned.includes('network'),
                thm: isOpen || pinned.includes('thermal'),
                gpu: isOpen || pinned.includes('gpu'),
                pwr: isOpen || pinned.includes('power')
            };
            // Alerts also watch what is not shown: the cheap metrics on every
            // poll, disk space and the GPU less often. Graphs record only
            // what is shown, so their time axis stays continuous.
            const due = (key, every) => now - this._alertSampled[key] >= every;
            const need = {
                ...shown,
                cpu: true,
                mem: true,
                thm: true,
                dsk: shown.dsk || due('dsk', ALERT_DISK_EVERY_US),
                gpu: due('gpu', shown.gpu ? GPU_EVERY_US : ALERT_GPU_EVERY_US),
                net: shown.net || due('net', BACKGROUND_EVERY_US),
                bat: shown.bat || due('bat', BACKGROUND_EVERY_US),
            };
            need.pwr = shown.pwr || due('pwr', BACKGROUND_EVERY_US);
            for (const key of ['dsk', 'gpu', 'net', 'bat', 'pwr']) if (need[key]) this._alertSampled[key] = now;

            const deadline = new Promise(resolve => {
                this._pollDeadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_DEADLINE_MS, () => {
                    this._pollDeadlineId = null;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            });
            const last = {
                cpu: this._lastCpu || { total: 0, cores: [], loadavg: [0, 0, 0], uptime: 0 },
                mem: this._lastMem || { percent: 0, total: 0, used: 0 },
                bat: this._lastBat || { present: false },
                dsk: this._lastDsk || { mounts: [], readRate: 0, writeRate: 0 },
                net: this._lastNet || { total: { rxRate: 0, txRate: 0 }, interfaces: {} },
                thm: this._lastThm || { packageTemp: 0, sensors: [], fans: [] },
                gpu: this._lastGpu || { present: false, percent: 0 },
                pwr: this._lastPwr || { raplSupported: false, packagePower: null, systemPower: null }
            };

            const [cpu, mem, bat, dsk, net, thm, gpu] = await Promise.all([
                need.cpu ? this._guarded('cpu', deadline, () => this._cpu.sample(isDetailedCpu, isOpen), last.cpu) : last.cpu,
                need.mem ? this._guarded('memory', deadline, () => this._mem.sample(isDetailedMem), last.mem) : last.mem,
                need.bat ? this._guarded('battery', deadline, () => this._bat.sample(), last.bat) : last.bat,
                need.dsk ? this._guarded('disk', deadline, () => this._dsk.sample(isDetailedDsk), last.dsk) : last.dsk,
                need.net ? this._guarded('network', deadline, () => this._net.sample(), last.net) : last.net,
                need.thm ? this._guarded('thermal', deadline, () => this._thm.sample(isDetailedThm), last.thm) : last.thm,
                need.gpu ? this._guarded('gpu', deadline, () => this._gpu.sample(), last.gpu) : last.gpu
            ]);
            if (gen !== this._gen) return;

            if (need.cpu) this._lastCpu = cpu;
            if (need.mem) this._lastMem = mem;
            if (need.bat) this._lastBat = bat;
            if (need.dsk) this._lastDsk = dsk;
            if (need.net) this._lastNet = net;
            if (need.thm) this._lastThm = thm;
            if (need.gpu) this._lastGpu = gpu;

            // Three small reads; feeds the load rows and the memory alert.
            const psi = await this._guarded('pressure', deadline, () => this._psi.sample(), this._lastPsi ?? null);
            if (gen !== this._gen) return;
            this._lastPsi = psi;
            // One small file per processor package: how much of the time it was slowed to cool.
            const throttle = await this._guarded('throttle', deadline, () => this._throttle.sample(), this._lastThrottle ?? null);
            if (gen !== this._gen) return;
            this._lastThrottle = throttle;

            const pwr = need.pwr
                ? await this._guarded('power', deadline, () => this._pwr.sample(bat), last.pwr)
                : last.pwr;
            if (gen !== this._gen) return;
            if (need.pwr) {
                this._lastPwr = pwr;
                // One entry per sample, here in the engine: the render path
                // also runs for re-draws of an old sample.
                const draw = powerReadout(pwr).value;
                if (draw > 0) this._pwrStats.add(draw, now);
            }

            let processes = [];
            let procSort = null;
            let procFilter = '';
            let procWarmingUp = false;
            let ioDenied = 0;
            if (isDetailedCpu || isDetailedMem || isDetailedDsk) {
                // A baseline older than a couple of intervals (the menu sat
                // on another tab) would turn the rates into long averages.
                // The open page's search, if any: matches instead of the busiest five.
                const filter = this._procFilters?.[isDetailedMem ? 'memory' : isDetailedDsk ? 'disk' : 'cpu'] ?? '';
                procSort = isDetailedMem ? 'memory' : isDetailedDsk ? 'disk' : 'cpu';
                procFilter = filter;
                const held = this._procHeld;
                if (tick && held?.sort === procSort && held.filter === filter && now - held.at < PROCESS_EVERY_US) {
                    // Too soon for a new list: this reading shows the last one.
                    processes = held.processes;
                    ioDenied = held.ioDenied;
                } else {
                    const procResult = await this._guarded('processes', deadline,
                        () => this._proc.sample(mem.total, isDetailedMem, filter ? SEARCH_ROWS : PROCESS_ROWS, this._gapUs / 1e6, { io: isDetailedDsk, filter }), null);
                    if (gen !== this._gen) return;
                    // null: the sampler was destroyed or is still reading.
                    // CPU and disk rates need two readings; memory is valid from the first.
                    procWarmingUp = !!procResult?.warmingUp && !isDetailedMem;
                    if (procResult && !procWarmingUp) {
                        processes = procResult.top;
                        ioDenied = procResult.ioDenied;
                        this._procHeld = { at: now, sort: procSort, filter, processes, ioDenied };
                    } else {
                        procSort = null;
                        procFilter = '';
                    }
                }
            } else if (!isOpen) {
                // Deltas across a closed menu would be averages over minutes.
                this._proc.reset();
            }

            if (need.net) this._countNetUsage(net, now);

            const data = { cpu, mem, bat, pwr, dsk, net, thm, gpu, psi, throttle, processes, procSort, procFilter, ioDenied };
            if (tick || this._recordPending) {
                this._recordHistory(data, shown, now);
                this._recordLong(data, need, now);
            }
            this._lastData = data;
            this._present(data);
            this._updateAlerts(data, now);
            // Fetch the second reading now instead of at the next tick.
            if (procWarmingUp) this._deferPoll(MIN_RESAMPLE_US);
        } catch (e) {
            logOnce(`ResourcePulse poll error: ${e.message}`, 'error');
        } finally {
            if (gen === this._gen) {
                this._pollInFlight = false;
                this._recordPending = false;
                if (this._pollDeadlineId) {
                    GLib.source_remove(this._pollDeadlineId);
                    this._pollDeadlineId = null;
                }
            }
        }
    }

    _newSparkline(key, height, options = {}) {
        const scale = key === 'thm'
            ? { paddingLeft: 38, formatValue: v => formatTemp(v, this._settings?.get_string('unit-temp') || 'C') }
            : SPARK_SCALES[key];
        const spark = new Sparkline(this._hist[key], height, Object.assign({}, options, scale));
        spark.histKey = key;
        // The detail charts answer the pointer, so they need a name.
        if (options.showGrid) spark.accessible_name = fill(_('{chart} over time'), { chart: CHART_NAMES[key] ?? CHART_NAMES.gpu });
        // Pages are built on first visit, after polling has started.
        if (this._spanLabel) spark.setSpanLabel(this._spanLabel);
        if (this._sampleSeconds) spark.setSampleSeconds(this._sampleSeconds);
        this._sparklines.push(spark);
        if (options.showGrid && this._range !== 'live') this._applyRange();
        return spark;
    }
}
