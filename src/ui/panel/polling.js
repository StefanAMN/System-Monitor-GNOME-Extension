// The poll loop (Aggregator side): which collectors run, history (live and bucketed), network day totals, battery tracking, and gliding the shown values.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { appBottlenecks } from '../../lib/engine/appbottlenecks.js';
import { BatteryTracker } from '../../lib/engine/batterytracker.js';
import { powerReadout, thermalUnavailable, sampleNote } from '../../lib/common/present.js';
import { RANGES, HISTORY_TIERS, BucketSeries } from '../../lib/engine/longhistory.js';
import { SAMPLE_KEYS, freshSample, recordLiveSample } from '../../lib/engine/samples.js';
import { RingBuffer } from '../../lib/engine/ringbuffer.js';
import { DisplayAverage, interpolateReading, glideBuffer } from '../../lib/engine/smoothing.js';
import { saveNetUsage, netUsagePath } from '../../lib/engine/netusage.js';
import { Sparkline } from './widgets.js';
import { formatTemp } from '../../lib/common/format.js';
import { _, fill } from '../../lib/common/i18n.js';
import { logOnce } from '../../lib/common/utils.js';
import { HISTORY_CAPACITY, GPU_CHARTS, MIN_RESAMPLE_US, POLL_DEADLINE_MS, ALERT_DISK_EVERY_US, ALERT_GPU_EVERY_US, GPU_EVERY_US, PROCESS_EVERY_US, MIN_GAP_US, GLIDE_MAX_US, BACKGROUND_EVERY_US, NET_USAGE_SAVE_US, GLIDE_FRAME_MS, PROCESS_ROWS, SEARCH_ROWS, SPARK_SCALES, CHART_NAMES } from './constants.js';

export class PollingMethods {
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

        // Samples taken at another cadence would distort the live time axis.
        if (this._sampleSeconds !== interval) {
            for (const key of this._histKeys) this._hist[key].clear();
            this._historyAt = null;
        }
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
        if (!topBarOnly) {
            this._updateDashboardUI(data, frame);
            if (!frame) {
                const now = GLib.get_monotonic_time();
                for (const [key, card] of Object.entries(this._summaryCards ?? {})) {
                    card.sampleNote = sampleNote(data, key, now);
                    card.valueLabel.opacity = card.sampleNote ? 160 : 255;
                }
                if (this._sampleStatusLabel) {
                    const note = sampleNote(data, this._activeTab, now);
                    this._sampleStatusLabel.text = note;
                    this._sampleStatusLabel.visible = !!note;
                }
            }
        }
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

    _captureIncident() {
        const started = this._incidents.startManual(GLib.get_monotonic_time(), Date.now());
        if (started) {
            this._scheduleIncidentFinish();
            this._updateIncidentPage();
        }
        return started;
    }

    _cancelIncidentApps() {
        if (this._incidentAppTimer) GLib.source_remove(this._incidentAppTimer);
        this._incidentAppTimer = 0;
        this._incidentApps?.cancel();
    }

    _sampleIncidentApps(capture) {
        const isCurrent = () => this._incidents?.active === capture && !this._indicatorGone;
        const report = e => logOnce(`ResourcePulse: app bottleneck sample: ${e.message}`);
        this._incidentApps.begin().then(before => {
            if (!before || !isCurrent()) return;
            // The first read includes the kernel's recent PSI trend. Pair it
            // with another just after the trigger, within the capture window.
            this._incidentAppTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 6000, () => {
                this._incidentAppTimer = 0;
                if (isCurrent()) {
                    this._incidentApps.end(before).then(after => {
                        if (isCurrent()) capture.apps = appBottlenecks(before, after);
                    }).catch(report);
                }
                return GLib.SOURCE_REMOVE;
            });
        }).catch(report);
    }

    _scheduleIncidentFinish() {
        if (this._incidentFinishId || !this._incidents.active) return;
        this._sampleIncidentApps(this._incidents.active);
        // Leave time for an in-flight reading measured before the deadline.
        // At the longest cadence there may be no periodic poll in this grace period.
        const remainingMs = Math.ceil((this._incidents.active.end - GLib.get_monotonic_time()) / 1000);
        this._incidentFinishId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, remainingMs + POLL_DEADLINE_MS), () => {
            this._incidentFinishId = 0;
            if (this._incidents.finish(GLib.get_monotonic_time())) this._saveIncidents();
            if (this._menuOpen && this._activeTab === 'incidents') this._updateIncidentPage();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveIncidents() {
        this._cancelIncidentApps();
        if (this._incidentFinishId) GLib.source_remove(this._incidentFinishId);
        this._incidentFinishId = 0;
        // Startup merges and writes any captures completed during the file read.
        if (this._incidentsLoaded) this._incidentStore.save(this._incidents.captures);
    }

    _recordHistory(data, now, tick) {
        const intervalUs = this._sampleSeconds * 1e6;
        const missed = tick && this._historyAt !== null
            ? Math.max(0, Math.round((now - this._historyAt) / intervalUs) - 1) : 0;
        if (tick) this._historyAt = now;
        const record = (key, value, metric, rate = null) => {
            const sample = data.samples[metric];
            if (!sample.fresh || (rate && !(rate.rateElapsedUs > 0))) value = NaN;
            const at = rate?.rateEndUs ?? sample.sampledAt ?? now;
            if (tick) recordLiveSample(this._hist[key], value, at, now, intervalUs, missed);

            const measured = Number.isFinite(value);
            if (!tick && !measured) return;
            for (const tier of this._historyTiers) {
                const series = tier[key];
                if (measured) {
                    if (rate) series.addRate(value, at, rate.rateElapsedUs);
                    else series.add(value, at);
                }
                if (tick) series.advance(now);
            }
        };

        // An on-demand read moves the transfer counters' baselines too.
        // Include its interval in the long ranges without adding a live tick.
        const { dsk, net } = data;
        record('dskRead', dsk.readRate / 1e6, 'dsk', dsk);
        record('dskWrite', dsk.writeRate / 1e6, 'dsk', dsk);
        record('netRx', net.total.rxRate / 1000, 'net', net);
        record('netTx', net.total.txRate / 1000, 'net', net);
        if (!tick) return;

        const { cpu, mem, bat, pwr, thm, gpu } = data;
        record('cpu', cpu.cores?.length ? cpu.total : NaN, 'cpu');
        record('mem', mem.total > 0 ? mem.percent : NaN, 'mem');
        record('bat', bat.present ? bat.percent : NaN, 'bat');
        record('batRate', bat.present ? bat.energyRate || 0 : NaN, 'bat');
        record('pwr', data.samples.pwr.fresh ? powerReadout(pwr).value ?? NaN : NaN, 'pwr');
        record('thm', thermalUnavailable(thm) ? NaN : thm.packageTemp, 'thm');
        record('gpu', gpu.present ? gpu.percent : NaN, 'gpu');
        const gpus = gpu.present ? gpu.gpus : null;
        if (gpus?.length > 1) {
            for (const device of gpus) this._gpuHistKey(device.key);
        }
        for (const [key, hist] of this._gpuHist) {
            record(hist, gpus?.find(device => device.key === key)?.percent ?? NaN, 'gpu');
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
        for (const [tier, spec] of Object.entries(HISTORY_TIERS)) {
            this._long[tier][hist] = new BucketSeries(spec.bucketUs, spec.capacity);
        }
        this._histKeys.push(hist);
        return hist;
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
            spark.history = spec ? this._long[spec.tier][spark.histKey].window(spec.capacity) : this._hist[spark.histKey];
            spark.setSampleSeconds(spec ? spec.bucketUs / 1e6 : this._sampleSeconds);
            spark.setSpanLabel(spec ? _(spec.label) : this._spanLabel);
            spark.refresh();
        }
        for (const [range, button] of Object.entries(this._rangeButtons ?? {})) {
            if (range === this._range) button.add_style_class_name('rp-range-on');
            else button.remove_style_class_name('rp-range-on');
            button.checked = range === this._range;
        }
        if (this._rangeValue) {
            const label = spec ? _(spec.label) : this._spanLabel || _('Live');
            this._rangeValue.text = label;
            this._detailRangeBox.accessible_name = fill(_('Chart range: {span}'), { span: label });
        }
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
    async _guarded(key, deadline, start, fallback, samples = null, context = null) {
        const result = await this._samples.read(key, deadline, start, fallback, context);
        if (samples) samples[key] = result;
        return result.value;
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
            // poll, disk space and the GPU less often. History uses the
            // fresh readings from this schedule, including background reads.
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

            const samples = {};
            const read = (key, start, fallback, context = null) => this._guarded(key, deadline, start, fallback, samples, context);
            // Independent reads do not wait behind a GPU or mount query.
            const psiPromise = read('pressure', () => this._psi.sample(), this._lastPsi ?? null);
            const throttlePromise = read('throttle', () => this._throttle.sample(), this._lastThrottle ?? null);
            const batteryPromise = need.bat ? read('battery', () => this._bat.sample(), last.bat) : Promise.resolve(last.bat);
            const powerPromise = need.pwr ? batteryPromise.then(battery => {
                if (gen !== this._gen) return last.pwr;
                return read('power', () => this._pwr.sample(samples.battery?.fresh ? battery : null), last.pwr);
            }) : Promise.resolve(last.pwr);
            const [cpu, mem, bat, dsk, net, thm, gpu, psi, throttle, pwr] = await Promise.all([
                need.cpu ? read('cpu', () => this._cpu.sample(isDetailedCpu, isOpen), last.cpu) : last.cpu,
                need.mem ? read('memory', () => this._mem.sample(isDetailedMem), last.mem) : last.mem,
                batteryPromise,
                need.dsk ? read('disk', () => this._dsk.sample(isDetailedDsk), last.dsk) : last.dsk,
                need.net ? read('network', () => this._net.sample(), last.net) : last.net,
                need.thm ? read('thermal', () => this._thm.sample(isDetailedThm), last.thm) : last.thm,
                need.gpu ? read('gpu', () => this._gpu.sample(), last.gpu) : last.gpu,
                psiPromise, throttlePromise, powerPromise
            ]);
            if (gen !== this._gen) return;

            if (need.cpu) this._lastCpu = cpu;
            if (need.mem) this._lastMem = mem;
            if (need.bat) this._lastBat = bat;
            if (need.dsk) this._lastDsk = dsk;
            if (need.net) this._lastNet = net;
            if (need.thm) this._lastThm = thm;
            if (need.gpu) this._lastGpu = gpu;

            this._lastPsi = psi;
            this._lastThrottle = throttle;
            if (need.pwr) this._lastPwr = pwr;

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
                    const procResult = await read('processes',
                        () => this._proc.sample(mem.total, isDetailedMem, filter ? SEARCH_ROWS : PROCESS_ROWS, this._gapUs / 1e6, { io: isDetailedDsk, filter }), null, `${this._processEpoch ?? 0}:${procSort}:${filter}`);
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
                // Late rows from before this reset are not current on reopen.
                this._processEpoch = (this._processEpoch ?? 0) + 1;
            }

            const data = { cpu, mem, bat, pwr, dsk, net, thm, gpu, psi, throttle, processes, procSort, procFilter, ioDenied };
            data.samples = {};
            for (const [key, collector] of Object.entries(SAMPLE_KEYS)) {
                const result = samples[collector] ?? this._samples.held(collector, data[key]);
                data.samples[key] = { fresh: result.fresh, status: result.status, sampledAt: result.sampledAt };
            }
            if (freshSample(data, 'net')) this._countNetUsage(net, now);
            if (need.pwr) {
                const draw = freshSample(data, 'pwr') ? powerReadout(pwr).value : null;
                if (draw !== null) this._pwrStats.add(draw, data.samples.pwr.sampledAt);
                else this._pwrStats.breakInterval();
            }
            const record = tick || this._recordPending;
            if (record) {
                if (this._incidents.observe(data, GLib.get_monotonic_time(), Date.now(), this._gapUs))
                    this._saveIncidents();
                else
                    this._scheduleIncidentFinish();
            }
            this._recordHistory(data, now, record);
            this._lastData = data;
            if (this._menuOpen && this._activeTab === 'incidents') this._updateIncidentPage();
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
