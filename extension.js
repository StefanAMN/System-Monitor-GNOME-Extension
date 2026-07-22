import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Cairo from 'cairo';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import { CpuSampler } from './lib/cpu.js';
import { MemorySampler } from './lib/memory.js';
import { BatterySampler } from './lib/battery.js';
import { PowerSampler } from './lib/power.js';
import { DiskSampler } from './lib/disk.js';
import { NetworkSampler } from './lib/network.js';
import { ThermalSampler } from './lib/thermal.js';
import { GpuSampler } from './lib/gpu.js';

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatBytes(bytes, useGiB = false) {
    if (bytes === 0) return '0 B';
    const k = useGiB ? 1024 : 1000;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    const suffix = useGiB && i > 0
        ? sizes[i].replace('K', 'Ki').replace('M', 'Mi').replace('G', 'Gi').replace('T', 'Ti')
        : sizes[i];
    return `${val.toFixed(1)} ${suffix}`;
}

function formatSpeed(bytesPerSec) {
    if (bytesPerSec === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return `${(bytesPerSec / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatTemp(celsius, unit = 'C') {
    if (unit === 'F') return `${Math.round((celsius * 9) / 5 + 32)}°F`;
    return `${Math.round(celsius)}°C`;
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function runSubprocess(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (obj, res) => {
                try {
                    const [, stdout] = obj.communicate_utf8_finish(res);
                    resolve(stdout || '');
                } catch (_e) { resolve(''); }
            });
        } catch (_e) { resolve(''); }
    });
}

// ─── Custom Cairo Widgets ─────────────────────────────────────────────────────

const Sparkline = GObject.registerClass({
    GTypeName: 'ResourcePulseSparkline',
}, class Sparkline extends St.DrawingArea {
    _init(width = 400, height = 100, maxVal = 100, autoScale = false, options = {}) {
        super._init({ style_class: 'resource-pulse-sparkline', width, height });
        this.history = [];
        this.maxVal = maxVal;
        this.autoScale = autoScale;
        this.scaleLabel = '';
        this.options = Object.assign({
            showGrid: false,
            color: [0.208, 0.518, 0.894, 1.0], // Default blue
            fillOpacity: 0.12,
            lineWidth: 1.5,
            gridRows: 4,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: options.showGrid ? 12 : 2,
            paddingBottom: 0
        }, options);
        this.connect('repaint', this._draw.bind(this));
    }

    addSample(val) {
        this.history.push(val);
        if (this.history.length > 60) this.history.shift();
        this.queue_repaint();
    }

    setScaleLabel(label) {
        if (this.scaleLabel !== label) {
            this.scaleLabel = label;
            this.queue_repaint();
        }
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();

        const opt = this.options;
        const color = opt.color;
        const padL = opt.paddingLeft || 0;
        const padR = opt.paddingRight || 0;
        const padT = opt.paddingTop || 0;
        const padB = opt.paddingBottom || 0;

        const graphW = w - padL - padR;
        const graphH = h - padT - padB;

        // Draw background grid if showGrid is true
        if (opt.showGrid) {
            cr.setLineWidth(1);
            cr.setSourceRGBA(1, 1, 1, 0.08); // Grid color

            // Border
            cr.rectangle(padL, padT, graphW, graphH);
            cr.stroke();

            // Horizontal lines and labels
            const gridRows = opt.gridRows || 4;
            cr.setFontSize(10);
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
            
            for (let i = 0; i <= gridRows; i++) {
                const ratio = i / gridRows;
                const y = padT + graphH - (ratio * graphH);
                
                if (i > 0 && i < gridRows) {
                    cr.moveTo(padL, y);
                    cr.lineTo(padL + graphW, y);
                    cr.stroke();
                }

                const pct = Math.round(ratio * this.maxVal);
                const lbl = `${pct}%`;
                const extents = cr.textExtents(lbl);
                cr.setSourceRGBA(1, 1, 1, 0.6);
                cr.moveTo(padL - extents.width - 6, y + extents.height / 2 - 1);
                cr.showText(lbl);
                cr.setSourceRGBA(1, 1, 1, 0.08); // Reset grid color
            }

            // X-axis labels (60s and 0s)
            cr.setSourceRGBA(1, 1, 1, 0.6);
            const lblLeft = "60s";
            const extL = cr.textExtents(lblLeft);
            cr.moveTo(padL, padT + graphH + extL.height + 4);
            cr.showText(lblLeft);

            const lblRight = "0s";
            const extR = cr.textExtents(lblRight);
            cr.moveTo(padL + graphW - extR.width, padT + graphH + extR.height + 4);
            cr.showText(lblRight);
        }

        if (this.history.length < 2) { cr.restore(); return; }

        let max = this.maxVal;
        if (this.autoScale) {
            const localMax = Math.max(...this.history);
            if (localMax > max) max = localMax;
        }
        if (max <= 0) max = 1;

        const step = graphW / 59;
        const getPoint = (i) => {
            const val = this.history[i];
            const x = padL + i * step;
            const y = padT + graphH - (val / max) * graphH;
            return [x, y];
        };

        // Draw gradient area
        cr.moveTo(padL, padT + graphH);
        for (let i = 0; i < this.history.length; i++) {
            const [x, y] = getPoint(i);
            cr.lineTo(x, y);
        }
        cr.lineTo(padL + (this.history.length - 1) * step, padT + graphH);
        cr.closePath();
        cr.setSourceRGBA(color[0], color[1], color[2], opt.fillOpacity);
        cr.fill();

        // Draw line
        cr.setLineWidth(opt.lineWidth);
        cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
        for (let i = 0; i < this.history.length; i++) {
            const [x, y] = getPoint(i);
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        cr.restore();
    }
});

const ProgressBar = GObject.registerClass({
    GTypeName: 'ResourcePulseProgressBar',
}, class ProgressBar extends St.DrawingArea {
    _init(height = 6, r = 0.2, g = 0.51, b = 0.89) {
        super._init({ style_class: 'resource-pulse-progress-track', height, x_expand: true });
        this.pct = 0;
        this.r = r; this.g = g; this.b = b;
        this.connect('repaint', this._draw.bind(this));
    }
    setColor(r, g, b) {
        if (this.r !== r || this.g !== g || this.b !== b) {
            this.r = r; this.g = g; this.b = b;
            this.queue_repaint();
        }
    }
    setPercent(pct) {
        pct = Math.max(0, Math.min(100, pct));
        if (this.pct !== pct) {
            this.pct = pct;
            this.queue_repaint();
        }
    }
    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();
        
        // Track
        cr.setSourceRGBA(0, 0, 0, 0.3);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(w - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();

        // Fill
        const fillW = Math.max(h, w * (this.pct / 100));
        cr.setSourceRGBA(this.r, this.g, this.b, 1.0);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(fillW - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();
        
        cr.restore();
    }
});

// ─── Extension Class ──────────────────────────────────────────────────────────

export default class ResourcePulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Samplers
        this._cpu = new CpuSampler();
        this._mem = new MemorySampler();
        this._bat = new BatterySampler();
        this._pwr = new PowerSampler();
        this._dsk = new DiskSampler();
        this._net = new NetworkSampler();
        this._thm = new ThermalSampler();
        this._gpu = new GpuSampler();

        // Panel indicator
        this._indicator = new PanelMenu.Button(0.0, 'Resource Pulse', false);
        this._indicatorBox = new St.BoxLayout({ style_class: 'resource-pulse-indicator-box' });
        this._indicator.add_child(this._indicatorBox);
        this._topBarWidgets = {};

        // Dropdown container
        this._menuSection = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        this._menuContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-menu-section'
        });
        this._menuSection.add_child(this._menuContainer);
        this._indicator.menu.box.add_style_class_name('resource-pulse-popup');
        this._indicator.menu.addMenuItem(this._menuSection);

        // Build UI
        this._activeTab = 'overview';
        this._coreWidgets = null;
        this._procWidgets = [];
        this._buildOverview();
        this._buildDetails();
        this._updateTabVisibility();

        // Track menu open
        this._menuOpen = false;
        this._openStateId = this._indicator.menu.connect('open-state-changed', (menu, open) => {
            this._menuOpen = open;
            if (open) this._poll();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Settings listeners
        this._pinnedId = this._settings.connect('changed::pinned-metrics', () => this._rebuildTopBar());
        this._compactId = this._settings.connect('changed::compact-label', () => this._rebuildTopBar());
        this._pollId = this._settings.connect('changed::poll-interval', () => this._startPolling());
        this._openMenuId = this._settings.connect('changed::action-open-menu', () => {
            if (this._settings.get_boolean('action-open-menu')) {
                this._settings.set_boolean('action-open-menu', false);
                this._activeTab = 'overview';
                this._updateTabVisibility();
                this._indicator.menu.open();
            }
        });

        this._rebuildTopBar();
        this._startPolling();
    }

    disable() {
        if (this._pinnedId) this._settings.disconnect(this._pinnedId);
        if (this._compactId) this._settings.disconnect(this._compactId);
        if (this._pollId) this._settings.disconnect(this._pollId);
        if (this._openMenuId) this._settings.disconnect(this._openMenuId);

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._openStateId) this._indicator.menu.disconnect(this._openStateId);

        this._indicator.destroy();
        this._indicator = null;
        this._indicatorBox = null;
        this._topBarWidgets = {};
        this._settings = null;
        this._coreWidgets = null;
        this._procWidgets = [];
        this._cpu = null;
        this._mem = null;
        this._bat = null;
        this._pwr = null;
        this._dsk = null;
        this._net = null;
        this._thm = null;
        this._gpu = null;
    }

    _startPolling() {
        if (this._timeoutId) GLib.source_remove(this._timeoutId);
        const interval = this._settings.get_int('poll-interval') || 2;
        this._poll();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _poll() {
        try {
            const pinned = this._settings?.get_strv('pinned-metrics') || ['cpu', 'memory'];
            const isOpen = this._menuOpen;

            const needCpu = isOpen || pinned.includes('cpu');
            const needMem = isOpen || pinned.includes('memory');
            const needBat = isOpen || pinned.includes('battery') || pinned.includes('power');
            const needDsk = isOpen || pinned.includes('disk');
            const needNet = isOpen || pinned.includes('network');
            const needThm = isOpen || pinned.includes('thermal');
            const needGpu = isOpen || pinned.includes('gpu');
            const needPwr = isOpen || pinned.includes('power');

            const [cpu, mem, bat, dsk, net, thm, gpu] = await Promise.all([
                needCpu ? this._cpu.sample() : Promise.resolve(this._lastCpu || { total: 0, cores: [] }),
                needMem ? this._mem.sample() : Promise.resolve(this._lastMem || { percent: 0, total: 0, used: 0 }),
                needBat ? this._bat.sample() : Promise.resolve(this._lastBat || { present: false }),
                needDsk ? this._dsk.sample() : Promise.resolve(this._lastDsk || { mounts: [], readRate: 0, writeRate: 0 }),
                needNet ? this._net.sample() : Promise.resolve(this._lastNet || { total: { rxRate: 0, txRate: 0 }, interfaces: {} }),
                needThm ? this._thm.sample() : Promise.resolve(this._lastThm || { packageTemp: 0, sensors: [], fans: [] }),
                needGpu ? this._gpu.sample() : Promise.resolve(this._lastGpu || { present: false, percent: 0 })
            ]);

            if (needCpu) this._lastCpu = cpu;
            if (needMem) this._lastMem = mem;
            if (needBat) this._lastBat = bat;
            if (needDsk) this._lastDsk = dsk;
            if (needNet) this._lastNet = net;
            if (needThm) this._lastThm = thm;
            if (needGpu) this._lastGpu = gpu;

            const pwr = needPwr ? await this._pwr.sample(bat) : (this._lastPwr || { raplSupported: false, packagePower: null, systemPower: null });
            if (needPwr) this._lastPwr = pwr;

            let processes = [];
            if (this._menuOpen && this._activeTab === 'cpu') {
                if (!this._prevProcStats) {
                    this._prevProcStats = {};
                    this._prevProcTime = 0;
                }
                const cmd = "awk -F '[()]' '{split($1, p, \" \"); pid=p[1]; name=$2; split($3, a, \" \"); ticks=a[12]+a[13]; rss=a[22]; print pid, ticks, rss, name}' /proc/[0-9]*/stat";
                const stdout = await runSubprocess(['bash', '-c', cmd]);
                if (stdout) {
                    const now = GLib.get_monotonic_time();
                    const dt = this._prevProcTime > 0 ? (now - this._prevProcTime) / 1000000.0 : 0;
                    this._prevProcTime = now;

                    const lines = stdout.trim().split('\n');
                    let currentStats = {};
                    let allProcs = [];

                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4) {
                            const pid = parts[0];
                            const ticks = parseInt(parts[1], 10);
                            const rss = parseInt(parts[2], 10);
                            const name = parts.slice(3).join(' ');

                            currentStats[pid] = ticks;

                            if (this._prevProcStats[pid] !== undefined && dt > 0) {
                                const deltaTicks = ticks - this._prevProcStats[pid];
                                const cpuPct = Math.max(0, deltaTicks / dt);
                                const memPct = mem.total > 0 ? ((rss * 4096) / mem.total) * 100 : 0;
                                
                                // Only show processes using CPU to avoid clutter
                                if (cpuPct > 0.1 || memPct > 1.0) {
                                    allProcs.push({
                                        pid: pid,
                                        cpu: cpuPct,
                                        mem: memPct,
                                        comm: name
                                    });
                                }
                            }
                        }
                    }
                    this._prevProcStats = currentStats;

                    // Sort by CPU usage, grab top 5
                    allProcs.sort((a, b) => b.cpu - a.cpu);
                    processes = allProcs.slice(0, 5);
                }
            }

            const data = { cpu, mem, bat, pwr, dsk, net, thm, gpu, processes };
            this._updateTopBarUI(data);
            this._updateDashboardUI(data);
        } catch (e) {
            console.error(`ResourcePulse poll error: ${e.message}`);
        }
    }

    _getIconName(key) {
        const map = {
            cpu: 'utilities-system-monitor-symbolic',
            memory: 'media-flash-symbolic',
            battery: 'battery-good-symbolic',
            power: 'thunderbolt-symbolic',
            disk: 'drive-harddisk-symbolic',
            network: 'network-transmit-receive-symbolic',
            thermal: 'sensors-temperature-symbolic',
            gpu: 'video-display-symbolic'
        };
        return map[key] || 'image-missing-symbolic';
    }

    _rebuildTopBar() {
        this._indicatorBox.destroy_all_children();
        this._topBarWidgets = {};

        const pinned = this._settings.get_strv('pinned-metrics') || [];
        const compact = this._settings.get_boolean('compact-label');

        pinned.forEach((key, index) => {
            if (index > 0) {
                this._indicatorBox.add_child(new St.Label({
                    text: '|',
                    style_class: 'resource-pulse-divider',
                    y_align: Clutter.ActorAlign.CENTER
                }));
            }

            const box = new St.BoxLayout();
            const icon = new St.Icon({
                icon_name: this._getIconName(key),
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER
            });
            box.add_child(icon);

            let label = null;
            if (!compact) {
                label = new St.Label({
                    text: '--',
                    style_class: 'resource-pulse-label',
                    y_align: Clutter.ActorAlign.CENTER
                });
                box.add_child(label);
            }

            this._indicatorBox.add_child(box);
            this._topBarWidgets[key] = { label, icon };
        });
    }

    _updateTopBarUI(data) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const cpuWarn = this._settings.get_int('threshold-cpu') || 90;
        const memWarn = this._settings.get_int('threshold-mem') || 90;
        const tempWarn = this._settings.get_int('threshold-temp') || 80;

        Object.keys(this._topBarWidgets).forEach(key => {
            const widget = this._topBarWidgets[key];
            if (!widget.label) return;

            let text = '--';
            if (key === 'cpu' && data.cpu) text = `${Math.round(data.cpu.total)}%`;
            else if (key === 'memory' && data.mem) text = `${Math.round(data.mem.percent)}%`;
            else if (key === 'battery' && data.bat && data.bat.present) {
                text = `${Math.round(data.bat.percent)}%`;
                widget.icon.icon_name = data.bat.state === 'charging'
                    ? 'battery-good-charging-symbolic' : 'battery-good-symbolic';
            }
            else if (key === 'power' && data.pwr) {
                const draw = data.pwr.systemPower !== null ? data.pwr.systemPower : (data.pwr.packagePower || 0);
                text = draw > 0 ? `${draw.toFixed(1)}W` : '0W';
            }
            else if (key === 'disk' && data.dsk && data.dsk.mounts.length > 0)
                text = `${Math.round(data.dsk.mounts[0].percent)}%`;
            else if (key === 'network' && data.net) text = formatSpeed(data.net.total.rxRate);
            else if (key === 'thermal' && data.thm) text = formatTemp(data.thm.temp, tempUnit);
            else if (key === 'gpu' && data.gpu) text = data.gpu.present ? `${Math.round(data.gpu.percent)}%` : 'N/A';

            widget.label.text = text;

            let warn = false;
            if (key === 'cpu' && data.cpu && data.cpu.total >= cpuWarn) warn = true;
            if (key === 'memory' && data.mem && data.mem.percent >= memWarn) warn = true;
            if (key === 'thermal' && data.thm && data.thm.temp >= tempWarn) warn = true;
            widget.label.style = warn ? 'color: #e01b24;' : '';
        });
    }

    // ── Overview Page ─────────────────────────────────────────────────────────


    _addClickAnimations(actor) {
        if (!actor) return;
        actor.set_pivot_point(0.5, 0.5);

        actor.connect('enter-event', () => {
            actor.ease({
                scale_x: 1.03,
                scale_y: 1.03,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('leave-event', () => {
            actor.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('button-press-event', () => {
            actor.ease({
                scale_x: 0.95,
                scale_y: 0.95,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('button-release-event', () => {
            actor.ease({
                scale_x: 1.03,
                scale_y: 1.03,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildOverview() {
        this._overviewPage = new St.BoxLayout({ vertical: true });

        // Header container (System Overview, Refresh, Menu)
        const headerBox = new St.BoxLayout({ style: 'margin-bottom: 12px;', y_align: Clutter.ActorAlign.CENTER });
        const titleLbl = new St.Label({ text: 'System Overview', style: 'font-size: 1.3em; font-weight: bold; color: #ffffff;', x_expand: true });
        headerBox.add_child(titleLbl);

        const refreshBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 50%; padding: 6px;', reactive: true });
        const refreshIcon = new St.Icon({ icon_name: 'view-refresh-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        refreshIcon.set_pivot_point(0.5, 0.5);
        refreshBtn.add_child(refreshIcon);
        refreshBtn.connect('clicked', () => {
            this._poll();
            refreshIcon.rotation_angle_z = 0;
            refreshIcon.ease({
                rotation_angle_z: 360,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        });

        const menuBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 50%; padding: 6px; margin-left: 6px;', reactive: true });
        const menuIcon = new St.Icon({ icon_name: 'view-more-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        menuIcon.set_pivot_point(0.5, 0.5);
        menuBtn.add_child(menuIcon);
        menuBtn.connect('clicked', () => {
            menuIcon.rotation_angle_z = 0;
            menuIcon.ease({
                rotation_angle_z: 180,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            this.openPreferences();
            this._indicator.menu.close();
        });

        this._addClickAnimations(refreshBtn);
        headerBox.add_child(refreshBtn);
        this._addClickAnimations(menuBtn);
        headerBox.add_child(menuBtn);
        this._overviewPage.add_child(headerBox);

        // Horizontal Row for CPU, Memory, Battery
        this._primaryRow = new St.BoxLayout({ style: 'spacing: 12px; margin-bottom: 12px;' });
        this._overviewPage.add_child(this._primaryRow);

        this._summaryCards = {};

        // 1. CPU Card
        const cpuCard = new St.BoxLayout({
            style: 'background-color: #1f2937; border: 1px solid rgba(53, 132, 228, 0.4); border-radius: 12px; padding: 12px;',
            vertical: true, reactive: true, can_focus: true
        });
        const cpuHead = new St.BoxLayout({ style: 'spacing: 6px;' });
        const cpuIcon = new St.Icon({ icon_name: this._getIconName('cpu'), style: 'icon-size: 16px; color: #3584e4;' });
        cpuHead.add_child(cpuIcon);
        cpuHead.add_child(new St.Label({ text: 'CPU', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;' }));
        cpuCard.add_child(cpuHead);
        const cpuVal = new St.Label({ text: '--%', style: 'font-size: 1.9em; font-weight: bold; color: #ffffff;' });
        cpuCard.add_child(cpuVal);
        const cpuSpark = new Sparkline(110, 38, 100, false, { color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.15 });
        cpuSpark.x_expand = true;
        cpuCard.add_child(cpuSpark);
        const cpuBar = new ProgressBar(4, 0.208, 0.518, 0.894);
        cpuCard.add_child(cpuBar);
        cpuCard.connect('button-press-event', () => {
            this._activeTab = 'cpu';
            this._updateTabVisibility();
            return Clutter.EVENT_STOP;
        });
        this._addClickAnimations(cpuCard);
        this._primaryRow.add_child(cpuCard);
        this._summaryCards['cpu'] = { box: cpuCard, valueLabel: cpuVal, pbar: cpuBar, spark: cpuSpark };

        // 2. Memory Card
        const memCard = new St.BoxLayout({
            style: 'background-color: #1e1a2e; border: 1px solid rgba(145, 65, 172, 0.4); border-radius: 12px; padding: 12px;',
            vertical: true, reactive: true, can_focus: true
        });
        const memHead = new St.BoxLayout({ style: 'spacing: 6px;' });
        const memIcon = new St.Icon({ icon_name: this._getIconName('memory'), style: 'icon-size: 16px; color: #9141ac;' });
        memHead.add_child(memIcon);
        memHead.add_child(new St.Label({ text: 'Memory', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;' }));
        memCard.add_child(memHead);
        const memVal = new St.Label({ text: '--%', style: 'font-size: 1.9em; font-weight: bold; color: #ffffff;' });
        memCard.add_child(memVal);
        const memSpark = new Sparkline(110, 38, 100, false, { color: [0.569, 0.255, 0.675, 1.0], fillOpacity: 0.15 });
        memSpark.x_expand = true;
        memCard.add_child(memSpark);
        const memBar = new ProgressBar(4, 0.569, 0.255, 0.675);
        memCard.add_child(memBar);
        memCard.connect('button-press-event', () => {
            this._activeTab = 'memory';
            this._updateTabVisibility();
            return Clutter.EVENT_STOP;
        });
        this._addClickAnimations(memCard);
        this._primaryRow.add_child(memCard);
        this._summaryCards['memory'] = { box: memCard, valueLabel: memVal, pbar: memBar, spark: memSpark };

        // 3. Battery Card
        const batCard = new St.BoxLayout({
            style: 'background-color: #192820; border: 1px solid rgba(46, 194, 126, 0.4); border-radius: 12px; padding: 12px;',
            vertical: true, reactive: true, can_focus: true
        });
        const batHead = new St.BoxLayout({ style: 'spacing: 6px;' });
        const batIcon = new St.Icon({ icon_name: this._getIconName('battery'), style: 'icon-size: 16px; color: #2ec27e;' });
        batHead.add_child(batIcon);
        const batTitle = new St.Label({ text: 'Battery', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true });
        batHead.add_child(batTitle);
        batHead.add_child(new St.Icon({ icon_name: 'battery-good-symbolic', style: 'icon-size: 14px; color: rgba(255,255,255,0.4);' }));
        batCard.add_child(batHead);
        const batVal = new St.Label({ text: '--%', style: 'font-size: 1.9em; font-weight: bold; color: #ffffff;' });
        batCard.add_child(batVal);
        const batBar = new ProgressBar(6, 0.18, 0.76, 0.494);
        batCard.add_child(batBar);
        const batStatus = new St.Label({ text: 'Discharging', style: 'font-size: 0.75em; color: #8c8c94; margin-top: 2px;' });
        batCard.add_child(batStatus);
        batCard.connect('button-press-event', () => {
            this._activeTab = 'battery';
            this._updateTabVisibility();
            return Clutter.EVENT_STOP;
        });
        this._addClickAnimations(batCard);
        this._primaryRow.add_child(batCard);
        this._summaryCards['battery'] = { box: batCard, valueLabel: batVal, pbar: batBar, statusLbl: batStatus };

        // Secondary Grid Layout (2x2)
        const grid = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        this._secondaryBox = new St.Widget({ layout_manager: grid, style_class: 'resource-pulse-secondary-grid' });
        this._overviewPage.add_child(this._secondaryBox);

        const secondaryMetrics = [
            { key: 'disk', label: 'Disk', tint: 'tint-disk', r: 0.96, g: 0.83, b: 0.18 },
            { key: 'network', label: 'Network', tint: 'tint-network', r: 0.88, g: 0.11, b: 0.14 },
            { key: 'thermal', label: 'Thermal', tint: 'tint-thermal', r: 1.0, g: 0.47, b: 0.0 },
            { key: 'power', label: 'Power', tint: 'tint-power', r: 0.96, g: 0.83, b: 0.18 },
            { key: 'gpu', label: 'GPU', tint: 'tint-gpu', r: 0.2, g: 0.82, b: 0.48 }
        ];

        secondaryMetrics.forEach((m, idx) => {
            // Dark tinted backgrounds per metric type
            const bgMap = {
                disk:    { bg: '#22200a', border: 'rgba(246,211,45,0.35)' },
                network: { bg: '#22100f', border: 'rgba(224,27,36,0.35)' },
                thermal: { bg: '#221608', border: 'rgba(255,120,0,0.35)' },
                power:   { bg: '#22200a', border: 'rgba(246,211,45,0.35)' },
                gpu:     { bg: '#0b2014', border: 'rgba(51,209,122,0.35)' }
            };
            const colors = bgMap[m.key] || { bg: '#222', border: 'rgba(255,255,255,0.15)' };
            const card = new St.BoxLayout({
                style: `background-color: ${colors.bg}; border: 1px solid ${colors.border}; border-radius: 12px; padding: 12px;`,
                vertical: true, reactive: true, can_focus: true
            });

            const iconColorMap = {
                disk: '#f6d32d', network: '#e01b24', thermal: '#ff7800', power: '#f6d32d', gpu: '#33d17a'
            };
            const head = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;' });
            head.add_child(new St.Icon({ icon_name: this._getIconName(m.key), style: `icon-size: 16px; color: ${iconColorMap[m.key] || '#fff'};` }));
            head.add_child(new St.Label({ text: m.label, style: 'font-size: 0.85em; font-weight: 600; color: #a0a0b8;' }));
            card.add_child(head);

            const val = new St.Label({ text: '--', style: 'font-size: 1.5em; font-weight: bold; color: #ffffff; margin-bottom: 2px;' });
            card.add_child(val);

            const subtext = new St.Label({ text: '', style: 'font-size: 0.75em; color: #8c8c94; margin-bottom: 4px;', visible: false });
            card.add_child(subtext);

            const pbar = new ProgressBar(4, m.r, m.g, m.b);
            card.add_child(pbar);

            card.connect('button-press-event', () => {
                this._activeTab = m.key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            });

            this._addClickAnimations(card);
            grid.attach(card, idx % 2, Math.floor(idx / 2), 1, 1);
            this._summaryCards[m.key] = { box: card, valueLabel: val, subLabel: subtext, pbar };
        });

        // Hardware Info Card
        this._hwCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px; margin-top: 10px;', vertical: true });

        const hwTop = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });

        // Dynamic Chip badge
        this._chipBox = new St.BoxLayout({ style: 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;', vertical: true });
        this._chipLabel1 = new St.Label({ text: 'intel', style: 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;' });
        this._chipLabel2 = new St.Label({ text: 'CORE', style: 'font-size: 0.9em; color: #ffffff; font-weight: bold; letter-spacing: 1px;' });
        this._chipLabel3 = new St.Label({ text: 'i5', style: 'font-size: 1.1em; color: #5bc3ff; font-weight: bold;' });
        this._chipBox.add_child(this._chipLabel1);
        this._chipBox.add_child(this._chipLabel2);
        this._chipBox.add_child(this._chipLabel3);
        hwTop.add_child(this._chipBox);

        const hwDesc = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;', x_expand: true });
        this._hwName = new St.Label({ text: 'Intel Processor', style: 'font-size: 1.05em; font-weight: bold; color: #ffffff;' });
        this._hwStats = new St.Label({ text: 'Cores & Threads', style: 'font-size: 0.8em; color: #a0a0b8;' });
        hwDesc.add_child(this._hwName);
        hwDesc.add_child(this._hwStats);
        hwTop.add_child(hwDesc);
        this._hwCard.add_child(hwTop);

        // Hardware Sub Stats (Uptime, Load Average, OS)
        const hwStatsRow = new St.BoxLayout({ style: 'margin-top: 10px; spacing: 16px;', x_expand: true });

        const uptimeBox = new St.BoxLayout({ vertical: true });
        uptimeBox.add_child(new St.Label({ text: 'Uptime', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._hwUptimeVal = new St.Label({ text: '--', style: 'font-size: 1.0em; font-weight: bold; color: #ffffff;' });
        uptimeBox.add_child(this._hwUptimeVal);

        const loadBox = new St.BoxLayout({ vertical: true, x_expand: true });
        loadBox.add_child(new St.Label({ text: 'Load Average', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._hwLoadVal = new St.Label({ text: '--', style: 'font-size: 1.0em; font-weight: bold; color: #ffffff;' });
        loadBox.add_child(this._hwLoadVal);

        const osBox = new St.BoxLayout({ vertical: true });
        osBox.add_child(new St.Label({ text: 'OS', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._hwOsVal = new St.Label({ text: `GNOME ${Config.PACKAGE_VERSION.split('.')[0]}`, style: 'font-size: 1.0em; font-weight: bold; color: #ffffff;' });
        osBox.add_child(this._hwOsVal);

        hwStatsRow.add_child(uptimeBox);
        hwStatsRow.add_child(loadBox);
        hwStatsRow.add_child(osBox);
        this._hwCard.add_child(hwStatsRow);

        this._addClickAnimations(this._hwCard);
        this._overviewPage.add_child(this._hwCard);



        this._menuContainer.add_child(this._overviewPage);
    }

    // ── Details Page ──────────────────────────────────────────────────────────

    _buildDetails() {
        this._detailArea = new St.BoxLayout({
            vertical: true,
            style: 'padding: 16px; min-width: 440px; max-width: 480px;'
        });

        // Top bar for CPU detail header (matches Right Panel header)
        this._detailHeader = new St.BoxLayout({ style: 'margin-bottom: 14px; spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });

        const backBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 50%; padding: 6px;', reactive: true });
        backBtn.add_child(new St.Icon({ icon_name: 'go-previous-symbolic', style: 'icon-size: 16px; color: #ffffff;' }));
        backBtn.connect('clicked', () => {
            this._activeTab = 'overview';
            this._updateTabVisibility();
        });

        this._detailHeaderTitleBox = new St.BoxLayout({ style: 'spacing: 8px;', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._detailHeaderIcon = new St.Icon({ icon_name: 'utilities-system-monitor-symbolic', style: 'icon-size: 18px; color: #3584e4;' });
        this._detailHeaderTitle = new St.Label({ text: 'CPU', style: 'font-size: 1.1em; font-weight: bold; color: #ffffff;' });
        this._detailHeaderTitleBox.add_child(this._detailHeaderIcon);
        this._detailHeaderTitleBox.add_child(this._detailHeaderTitle);

        const optBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 50%; padding: 6px;', reactive: true });
        const optIcon = new St.Icon({ icon_name: 'view-more-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        optIcon.set_pivot_point(0.5, 0.5);
        optBtn.add_child(optIcon);
        optBtn.connect('clicked', () => {
            optIcon.rotation_angle_z = 0;
            optIcon.ease({
                rotation_angle_z: 180,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            this.openPreferences();
            this._indicator.menu.close();
        });

        this._addClickAnimations(backBtn);
        this._detailHeader.add_child(backBtn);
        this._detailHeader.add_child(this._detailHeaderTitleBox);
        this._addClickAnimations(optBtn);
        this._detailHeader.add_child(optBtn);

        this._detailArea.add_child(this._detailHeader);

        this._detailSections = {
            cpu:     this._buildCpuDetails(),
            memory:  this._buildMemoryDetails(),
            battery: this._buildBatteryDetails(),
            power:   this._buildPowerDetails(),
            disk:    this._buildDiskDetails(),
            network: this._buildNetworkDetails(),
            thermal: this._buildThermalDetails(),
            gpu:     this._buildGpuDetails(),
        };

        for (const key of Object.keys(this._detailSections)) {
            if (this._detailSections[key]) {
                this._detailArea.add_child(this._detailSections[key]);
                this._detailSections[key].visible = false;
            }
        }

        this._menuContainer.add_child(this._detailArea);
    }

    _updateTabVisibility() {
        if (this._activeTab === 'overview') {
            if (!this._overviewPage.visible) {
                this._overviewPage.opacity = 0;
                this._overviewPage.visible = true;
                this._overviewPage.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            this._detailArea.visible = false;
        } else {
            this._overviewPage.visible = false;
            if (!this._detailArea.visible) {
                this._detailArea.opacity = 0;
                this._detailArea.visible = true;
                this._detailArea.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            
            // Set header title & icon dynamically
            const iconColorMap = {
                cpu: '#3584e4', memory: '#9141ac', battery: '#2ec27e',
                power: '#f6d32d', disk: '#f6d32d', network: '#e01b24',
                thermal: '#ff7800', gpu: '#33d17a'
            };
            this._detailHeaderIcon.icon_name = this._getIconName(this._activeTab);
            this._detailHeaderIcon.style = `icon-size: 18px; color: ${iconColorMap[this._activeTab] || '#ffffff'};`;
            this._detailHeaderTitle.text = this._activeTab.charAt(0).toUpperCase() + this._activeTab.slice(1);

            for (const [key, section] of Object.entries(this._detailSections || {})) {
                if (section) section.visible = (key === this._activeTab);
            }
        }
    }

    _detailRow(labelText, valueText = '--') {
        const row = new St.BoxLayout({ style: 'padding: 4px 0; spacing: 8px;', x_expand: true });
        const lbl = new St.Label({ text: labelText, style: 'font-size: 0.85em; color: #a0a0b8;', x_expand: true });
        const val = new St.Label({ text: valueText, style: 'font-size: 0.85em; color: #ffffff; font-weight: 600;' });
        row.add_child(lbl);
        row.add_child(val);
        return { row, val };
    }

    _buildCpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });

        // CPU Usage Card
        const usageCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        const usageHead = new St.BoxLayout({ style: 'margin-bottom: 4px;' });
        usageHead.add_child(new St.Label({ text: 'CPU Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        this._cpuDetailsVal = new St.Label({ text: '--%', style: 'font-size: 1.0em; font-weight: bold; color: #3584e4;' });
        usageHead.add_child(this._cpuDetailsVal);
        usageCard.add_child(usageHead);

        // CPU Detail Grid Graph
        this._cpuSparkline = new Sparkline(400, 110, 100, false, {
            showGrid: true,
            color: [0.208, 0.518, 0.894, 1.0],
            fillOpacity: 0.1,
            lineWidth: 1.5,
            paddingLeft: 32,
            paddingBottom: 15,
            paddingTop: 8,
            paddingRight: 8
        });
        this._cpuSparkline.x_expand = true;
        usageCard.add_child(this._cpuSparkline);
        box.add_child(usageCard);

        // Per-Core Usage Card
        const coreCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        coreCard.add_child(new St.Label({ text: 'Per-Core Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 8px;' }));

        // Two-column layout for cores
        const colsBox = new St.BoxLayout({ style: 'spacing: 16px;' });
        this._cpuCoreCol1 = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        this._cpuCoreCol2 = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        colsBox.add_child(this._cpuCoreCol1);
        colsBox.add_child(this._cpuCoreCol2);
        coreCard.add_child(colsBox);
        box.add_child(coreCard);

        // Details Stats row (3 columns)
        const statsRow = new St.BoxLayout({ style: 'spacing: 8px;', x_expand: true });

        const loadBox = new St.BoxLayout({ vertical: true, x_expand: true, style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px;' });
        loadBox.add_child(new St.Icon({ icon_name: 'emblem-synchronizing-symbolic', style: 'icon-size: 14px; color: #a0a0b8; margin-bottom: 4px;' }));
        loadBox.add_child(new St.Label({ text: 'Load Average', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._cpuDetailsLoad = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        loadBox.add_child(this._cpuDetailsLoad);

        const freqBox = new St.BoxLayout({ vertical: true, x_expand: true, style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px;' });
        freqBox.add_child(new St.Icon({ icon_name: 'emblem-favorite-symbolic', style: 'icon-size: 14px; color: #a0a0b8; margin-bottom: 4px;' }));
        freqBox.add_child(new St.Label({ text: 'Frequency', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._cpuDetailsFreq = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        freqBox.add_child(this._cpuDetailsFreq);

        const uptimeBox = new St.BoxLayout({ vertical: true, x_expand: true, style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px;' });
        uptimeBox.add_child(new St.Icon({ icon_name: 'clock-symbolic', style: 'icon-size: 14px; color: #a0a0b8; margin-bottom: 4px;' }));
        uptimeBox.add_child(new St.Label({ text: 'Uptime', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._cpuDetailsUptime = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        uptimeBox.add_child(this._cpuDetailsUptime);

        statsRow.add_child(loadBox);
        statsRow.add_child(freqBox);
        statsRow.add_child(uptimeBox);
        box.add_child(statsRow);

        // Top CPU Usage Card
        const procCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        const procHead = new St.BoxLayout({ style: 'margin-bottom: 8px;', y_align: Clutter.ActorAlign.CENTER });
        procHead.add_child(new St.Label({ text: 'Top CPU Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));

        const showAllBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.07); border-radius: 20px; padding: 4px 10px;', label: 'Show All' });
        showAllBtn.child.style = 'font-size: 0.75em; color: #a0a0b8;';
        procHead.add_child(showAllBtn);
        procCard.add_child(procHead);

        this._procList = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        procCard.add_child(this._procList);
        box.add_child(procCard);

        return box;
    }

    _updateCpuCoresUI(cores, coreFreqs = []) {
        if (!this._cpuCoreCol1 || !this._cpuCoreCol2) return;
        
        if (!this._coreWidgets || this._coreWidgets.length !== cores.length) {
            this._cpuCoreCol1.destroy_all_children();
            this._cpuCoreCol2.destroy_all_children();
            this._coreWidgets = [];
            
            cores.forEach((load, i) => {
                const row = new St.BoxLayout({ style: 'spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });
                const lbl = new St.Label({ text: `Core ${i}`, style: 'font-size: 0.78em; color: #a0a0b8;', width: 45 });
                const pbar = new ProgressBar(5, 0.18, 0.76, 0.494);
                pbar.x_expand = true;
                const freqLbl = new St.Label({ text: coreFreqs[i] || '', style: 'font-size: 0.72em; color: #8c8c94;', width: 55 });
                freqLbl.x_align = Clutter.ActorAlign.END;
                const val = new St.Label({ text: `${Math.round(load)}%`, style: 'font-size: 0.78em; color: #ffffff; font-weight: 600;', width: 35 });
                val.x_align = Clutter.ActorAlign.END;

                row.add_child(lbl);
                row.add_child(pbar);
                row.add_child(freqLbl);
                row.add_child(val);

                if (i % 2 === 0) {
                    this._cpuCoreCol1.add_child(row);
                } else {
                    this._cpuCoreCol2.add_child(row);
                }
                this._coreWidgets.push({ pbar, freqLbl, val });
            });
        }
        
        cores.forEach((load, i) => {
            if (this._coreWidgets[i]) {
                const w = this._coreWidgets[i];
                w.pbar.setPercent(load);
                if (load > 75) {
                    w.pbar.setColor(0.88, 0.11, 0.14); // Red
                } else if (load > 40) {
                    w.pbar.setColor(0.96, 0.83, 0.18); // Amber
                } else {
                    w.pbar.setColor(0.18, 0.76, 0.494); // Green
                }
                if (coreFreqs[i]) w.freqLbl.text = coreFreqs[i];
                w.val.text = `${Math.round(load)}%`;
            }
        });
    }

    _buildMemoryDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'Memory Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._memSparkline = new Sparkline(400, 100, 100, false, { showGrid: true, color: [0.569, 0.255, 0.675, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._memSparkline.x_expand = true;
        sparkCard.add_child(this._memSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._memUsed = this._detailRow('Used / Total');
        statsCard.add_child(this._memUsed.row);
        this._memAvail = this._detailRow('Available');
        statsCard.add_child(this._memAvail.row);
        this._memBuffersCache = this._detailRow('Buffers / Cache');
        statsCard.add_child(this._memBuffersCache.row);
        this._memSwap = this._detailRow('Swap');
        statsCard.add_child(this._memSwap.row);
        this._memSwapActivity = this._detailRow('Swap Activity');
        statsCard.add_child(this._memSwapActivity.row);
        box.add_child(statsCard);

        const memProcCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        const memProcHead = new St.BoxLayout({ style: 'margin-bottom: 8px;' });
        memProcHead.add_child(new St.Label({ text: 'Top Memory Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        memProcCard.add_child(memProcHead);
        this._memProcList = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        memProcCard.add_child(this._memProcList);
        box.add_child(memProcCard);

        return box;
    }

    _buildBatteryDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        
        // Percent History
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'Charge Level History (%)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._batSparkline = new Sparkline(400, 90, 100, false, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._batSparkline.x_expand = true;
        sparkCard.add_child(this._batSparkline);
        box.add_child(sparkCard);

        // Power Rate History (W)
        const rateCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        rateCard.add_child(new St.Label({ text: 'Charge/Discharge Rate (W)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._batRateSparkline = new Sparkline(400, 90, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._batRateSparkline.x_expand = true;
        rateCard.add_child(this._batRateSparkline);
        box.add_child(rateCard);

        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._batState  = this._detailRow('State');
        statsCard.add_child(this._batState.row);
        this._batTimeEst = this._detailRow('Time Estimate');
        statsCard.add_child(this._batTimeEst.row);
        this._batHealth = this._detailRow('Health');
        statsCard.add_child(this._batHealth.row);
        this._batCycles = this._detailRow('Cycle Count');
        statsCard.add_child(this._batCycles.row);
        this._batCapacity = this._detailRow('Current / Full');
        statsCard.add_child(this._batCapacity.row);
        this._batDesign = this._detailRow('Design Capacity');
        statsCard.add_child(this._batDesign.row);
        box.add_child(statsCard);
        return box;
    }

    _buildPowerDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'Draw History', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._pwrSparkline = new Sparkline(400, 100, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._pwrSparkline.x_expand = true;
        sparkCard.add_child(this._pwrSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._pwrSystem  = this._detailRow('System Draw');
        statsCard.add_child(this._pwrSystem.row);
        this._pwrPackage = this._detailRow('CPU Package');
        statsCard.add_child(this._pwrPackage.row);
        this._pwrGpu     = this._detailRow('GPU Draw');
        statsCard.add_child(this._pwrGpu.row);
        this._pwrCharging = this._detailRow('Charging Rate');
        statsCard.add_child(this._pwrCharging.row);
        this._pwrPeak    = this._detailRow('Session Peak');
        statsCard.add_child(this._pwrPeak.row);
        this._pwrAvg     = this._detailRow('Session Avg');
        statsCard.add_child(this._pwrAvg.row);
        box.add_child(statsCard);
        return box;
    }

    _buildDiskDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        
        // Read Rate Sparkline
        const readCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        readCard.add_child(new St.Label({ text: 'Read Rate (MB/s)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._dskReadSparkline = new Sparkline(400, 80, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskReadSparkline.x_expand = true;
        readCard.add_child(this._dskReadSparkline);
        box.add_child(readCard);

        // Write Rate Sparkline
        const writeCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        writeCard.add_child(new St.Label({ text: 'Write Rate (MB/s)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._dskWriteSparkline = new Sparkline(400, 80, 100, true, { showGrid: true, color: [0.88, 0.11, 0.14, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskWriteSparkline.x_expand = true;
        writeCard.add_child(this._dskWriteSparkline);
        box.add_child(writeCard);

        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._dskRead  = this._detailRow('Read rate');
        statsCard.add_child(this._dskRead.row);
        this._dskWrite = this._detailRow('Write rate');
        statsCard.add_child(this._dskWrite.row);
        this._dskUsage = this._detailRow('Active Utilization');
        statsCard.add_child(this._dskUsage.row);
        box.add_child(statsCard);

        // Filesystem Mounts Card
        const mountsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        mountsCard.add_child(new St.Label({ text: 'Filesystem Mounts', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._dskMountsBox = new St.BoxLayout({ vertical: true, style: 'spacing: 8px;' });
        mountsCard.add_child(this._dskMountsBox);
        box.add_child(mountsCard);

        return box;
    }

    _buildNetworkDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        
        // Download Sparkline
        const rxCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        rxCard.add_child(new St.Label({ text: 'Download Rate', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._netRxSparkline = new Sparkline(400, 80, 100, true, { showGrid: true, color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netRxSparkline.x_expand = true;
        rxCard.add_child(this._netRxSparkline);
        box.add_child(rxCard);

        // Upload Sparkline
        const txCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        txCard.add_child(new St.Label({ text: 'Upload Rate', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._netTxSparkline = new Sparkline(400, 80, 100, true, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netTxSparkline.x_expand = true;
        txCard.add_child(this._netTxSparkline);
        box.add_child(txCard);

        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats & Session Totals', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._netRx = this._detailRow('Current Download');
        statsCard.add_child(this._netRx.row);
        this._netTx = this._detailRow('Current Upload');
        statsCard.add_child(this._netTx.row);
        this._netSessionRx = this._detailRow('Session Downloaded');
        statsCard.add_child(this._netSessionRx.row);
        this._netSessionTx = this._detailRow('Session Uploaded');
        statsCard.add_child(this._netSessionTx.row);
        box.add_child(statsCard);

        // Per-interface breakdown card
        const ifaceCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        ifaceCard.add_child(new St.Label({ text: 'Interfaces', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._netIfaceList = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;' });
        ifaceCard.add_child(this._netIfaceList);
        box.add_child(ifaceCard);

        return box;
    }

    _buildThermalDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'Temperature History', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._thmSparkline = new Sparkline(400, 100, 100, true, { showGrid: true, color: [1.0, 0.47, 0.0, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._thmSparkline.x_expand = true;
        sparkCard.add_child(this._thmSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Components', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._thmSensorsBox = new St.BoxLayout({ vertical: true });
        statsCard.add_child(this._thmSensorsBox);
        box.add_child(statsCard);

        this._thmFansCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        this._thmFansCard.add_child(new St.Label({ text: 'Fans', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._thmFansBox = new St.BoxLayout({ vertical: true });
        this._thmFansCard.add_child(this._thmFansBox);
        box.add_child(this._thmFansCard);
        
        return box;
    }

    _buildGpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'GPU Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._gpuSparkline = new Sparkline(400, 100, 100, false, { showGrid: true, color: [0.2, 0.82, 0.48, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._gpuSparkline.x_expand = true;
        sparkCard.add_child(this._gpuSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._gpuUsage = this._detailRow('Usage');
        statsCard.add_child(this._gpuUsage.row);
        this._gpuMem   = this._detailRow('VRAM');
        statsCard.add_child(this._gpuMem.row);
        this._gpuTemp  = this._detailRow('Temperature');
        statsCard.add_child(this._gpuTemp.row);
        this._gpuPower = this._detailRow('Power Draw');
        statsCard.add_child(this._gpuPower.row);
        box.add_child(statsCard);
        return box;
    }

    // ── Dashboard Update ──────────────────────────────────────────────────────

    _updateDashboardUI(data) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const memUnit  = this._settings.get_string('unit-mem')  || 'GB';
        const useGiB   = memUnit === 'GiB';

        // ── CPU ──
        if (data.cpu) {
            const cpu = data.cpu;
            if (this._summaryCards?.cpu) {
                this._summaryCards.cpu.valueLabel.text = `${Math.round(cpu.total)}%`;
                this._summaryCards.cpu.pbar.setPercent(cpu.total);
                if (this._summaryCards.cpu.spark) {
                    this._summaryCards.cpu.spark.addSample(cpu.total);
                }
            }
            if (this._cpuSparkline) {
                this._cpuSparkline.addSample(cpu.total);
                this._cpuSparkline.setScaleLabel(`Cur: ${Math.round(cpu.total)}%`);
            }
            if (this._cpuDetailsVal) this._cpuDetailsVal.text = `${Math.round(cpu.total)}%`;

            // Hardware details on Overview
            if (this._hwName) this._hwName.text = cpu.hardwareModel || 'Unknown CPU';
            if (this._hwStats) {
                const genStr = cpu.cpuGen ? `${cpu.cpuGen} · ` : '';
                this._hwStats.text = `${genStr}${cpu.coresCount} cores · ${cpu.threadsCount} threads`;
            }
            
            // Dynamic chip style (Intel vs AMD)
            if (this._chipBox) {
                const model = (cpu.hardwareModel || '').toLowerCase();
                const isAmd = model.includes('amd') || model.includes('ryzen');
                if (isAmd) {
                    this._chipBox.style = 'background-color: #d22630; border-radius: 6px; padding: 6px 10px;';
                    this._chipLabel1.text = 'AMD';
                    this._chipLabel1.style = 'font-size: 0.65em; color: #f9b8bb; font-weight: 300;';
                    this._chipLabel2.text = 'RYZEN';
                    this._chipLabel2.style = 'font-size: 0.9em; color: #ffffff; font-weight: bold;';
                    let ver = '7';
                    if (model.includes('3')) ver = '3';
                    else if (model.includes('5')) ver = '5';
                    else if (model.includes('9')) ver = '9';
                    this._chipLabel3.text = ver;
                    this._chipLabel3.style = 'font-size: 1.1em; color: #ffaaaa; font-weight: bold;';
                } else {
                    this._chipBox.style = 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;';
                    this._chipLabel1.text = 'intel';
                    this._chipLabel1.style = 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;';
                    this._chipLabel2.text = 'CORE';
                    this._chipLabel2.style = 'font-size: 0.9em; color: #ffffff; font-weight: bold;';
                    let ver = 'i5';
                    if (model.includes('i3')) ver = 'i3';
                    else if (model.includes('i7')) ver = 'i7';
                    else if (model.includes('i9')) ver = 'i9';
                    this._chipLabel3.text = ver;
                    this._chipLabel3.style = 'font-size: 1.1em; color: #5bc3ff; font-weight: bold;';
                }
            }

            if (this._hwUptimeVal) this._hwUptimeVal.text = formatUptime(cpu.uptime);
            if (this._hwLoadVal) this._hwLoadVal.text = cpu.loadavg.join(' · ');
            if (this._hwOsVal) this._hwOsVal.text = cpu.osName || `GNOME ${Config.PACKAGE_VERSION.split('.')[0]}`;

            // Details Stats row
            if (this._cpuDetailsLoad) this._cpuDetailsLoad.text = cpu.loadavg.join(' · ');
            if (this._cpuDetailsFreq) this._cpuDetailsFreq.text = cpu.frequency;
            if (this._cpuDetailsUptime) this._cpuDetailsUptime.text = formatUptime(cpu.uptime);

            if (cpu.cores) this._updateCpuCoresUI(cpu.cores, cpu.coreFreqs);
        }

        // ── Memory ──
        if (data.mem) {
            const mem = data.mem;
            if (this._summaryCards?.memory) {
                this._summaryCards.memory.valueLabel.text = `${Math.round(mem.percent)}%`;
                this._summaryCards.memory.pbar.setPercent(mem.percent);
                if (this._summaryCards.memory.spark) {
                    this._summaryCards.memory.spark.addSample(mem.percent);
                }
            }
            if (this._memSparkline) {
                this._memSparkline.addSample(mem.percent);
                this._memSparkline.setScaleLabel(`Used: ${Math.round(mem.percent)}%`);
            }
            if (this._memUsed) this._memUsed.val.text =
                `${formatBytes(mem.used, useGiB)} / ${formatBytes(mem.total, useGiB)}`;
            if (this._memAvail) this._memAvail.val.text =
                `${formatBytes(mem.available, useGiB)}`;
            if (this._memBuffersCache) this._memBuffersCache.val.text =
                `${formatBytes(mem.buffers, useGiB)} / ${formatBytes(mem.cached, useGiB)}`;
            if (this._memSwap) this._memSwap.val.text =
                `${Math.round(mem.swapPercent)}% (${formatBytes(mem.swapUsed, useGiB)} / ${formatBytes(mem.swapTotal, useGiB)})`;
            if (this._memSwapActivity) {
                const inStr = mem.swapInRate > 0 ? `${formatBytes(mem.swapInRate, false)}/s` : '0 B/s';
                const outStr = mem.swapOutRate > 0 ? `${formatBytes(mem.swapOutRate, false)}/s` : '0 B/s';
                this._memSwapActivity.val.text = (mem.swapInRate > 0 || mem.swapOutRate > 0) ? `In: ${inStr} · Out: ${outStr}` : 'Idle';
            }
        }

        // ── Battery ──
        if (data.bat) {
            const bat = data.bat;
            const sc = this._summaryCards?.battery;
            if (sc) {
                sc.box.visible = bat.present;
                if (bat.present) {
                    sc.valueLabel.text = `${Math.round(bat.percent)}%`;
                    sc.pbar.setPercent(bat.percent);
                    
                    let stateStr = bat.state === 'charging' ? 'Charging'
                        : bat.state === 'discharging' ? 'Discharging' : 'Fully Charged';
                    if (bat.timeRemaining > 0) {
                        const h = Math.floor(bat.timeRemaining / 3600);
                        const m = Math.floor((bat.timeRemaining % 3600) / 60);
                        const label = bat.state === 'charging' ? 'to full' : 'left';
                        stateStr += ` · ${h}h ${m}m ${label}`;
                    }
                    sc.statusLbl.text = stateStr;
                }
            }
            if (bat.present) {
                if (this._batSparkline) {
                    this._batSparkline.addSample(bat.percent);
                    this._batSparkline.setScaleLabel(`Cur: ${Math.round(bat.percent)}%`);
                }
                if (this._batRateSparkline) {
                    const rateW = bat.energyRate || 0;
                    this._batRateSparkline.addSample(rateW);
                    this._batRateSparkline.setScaleLabel(`Rate: ${rateW.toFixed(1)} W`);
                }
                if (this._batState) {
                    const s = bat.state === 'charging' ? 'Charging'
                        : bat.state === 'discharging' ? 'Discharging' : 'Full';
                    this._batState.val.text = s;
                }
                if (this._batTimeEst) {
                    let estText = '--';
                    if (bat.state === 'charging' && (bat.timeToFull > 0 || bat.timeRemaining > 0)) {
                        const t = bat.timeToFull || bat.timeRemaining;
                        const h = Math.floor(t / 3600);
                        const m = Math.floor((t % 3600) / 60);
                        estText = `${h}h ${m}m to full`;
                    } else if (bat.state === 'discharging' && (bat.timeToEmpty > 0 || bat.timeRemaining > 0)) {
                        const t = bat.timeToEmpty || bat.timeRemaining;
                        const h = Math.floor(t / 3600);
                        const m = Math.floor((t % 3600) / 60);
                        estText = `${h}h ${m}m remaining`;
                    } else if (bat.state === 'full') {
                        estText = 'Fully Charged';
                    }
                    this._batTimeEst.val.text = estText;
                }
                if (this._batHealth) this._batHealth.val.text = `${bat.health.toFixed(1)}%`;
                if (this._batCycles) this._batCycles.val.text = `${bat.cycleCount}`;
                if (this._batCapacity) this._batCapacity.val.text = `${bat.energy.toFixed(1)} Wh / ${bat.energyFull.toFixed(1)} Wh`;
                if (this._batDesign) this._batDesign.val.text = `${bat.energyFullDesign.toFixed(1)} Wh`;
            }
        }

        // ── Power ──
        if (data.pwr) {
            const pwr = data.pwr;
            const hasDraw = pwr.raplSupported || pwr.systemPower !== null;
            const sc = this._summaryCards?.power;
            
            const draw = pwr.systemPower !== null ? pwr.systemPower : (pwr.packagePower || 0);
            const drawStr = draw > 0 ? `${draw.toFixed(1)} W` : '0.0 W';

            const bat = data.bat;
            const isCharging = bat && bat.present && bat.state === 'charging' && bat.energyRate > 0;

            if (sc) {
                sc.box.visible = true;
                sc.valueLabel.text = drawStr;
                sc.pbar.setPercent(Math.min(100, (draw / 45) * 100)); // normalized to 45W limit
                sc.subLabel.visible = true;
                if (isCharging) {
                    sc.subLabel.text = `Charging (+${bat.energyRate.toFixed(1)} W)`;
                } else {
                    sc.subLabel.text = pwr.systemPower !== null ? 'On Battery' : 'AC Connected';
                }
            }
            if (hasDraw) {
                if (!this._pwrStats) this._pwrStats = { count: 0, sum: 0, peak: 0 };
                if (draw > 0) {
                    this._pwrStats.count++;
                    this._pwrStats.sum += draw;
                    if (draw > this._pwrStats.peak) this._pwrStats.peak = draw;
                }
                const avgDraw = this._pwrStats.count > 0 ? (this._pwrStats.sum / this._pwrStats.count) : 0;

                if (this._pwrSparkline) {
                    this._pwrSparkline.addSample(draw);
                    this._pwrSparkline.setScaleLabel(`Draw: ${drawStr}`);
                }
                if (this._pwrSystem)  this._pwrSystem.val.text  = pwr.systemPower  !== null ? `${pwr.systemPower.toFixed(1)} W`  : '--';
                if (this._pwrPackage) this._pwrPackage.val.text = pwr.packagePower !== null ? `${pwr.packagePower.toFixed(1)} W` : '--';
                
                const gpuPwr = data.gpu && data.gpu.present && data.gpu.powerDraw ? data.gpu.powerDraw : null;
                if (this._pwrGpu) this._pwrGpu.val.text = gpuPwr !== null ? `${gpuPwr.toFixed(1)} W` : '--';
                if (this._pwrCharging) {
                    if (isCharging) {
                        this._pwrCharging.val.text = `+${bat.energyRate.toFixed(1)} W`;
                    } else if (bat && bat.present && bat.state === 'full') {
                        this._pwrCharging.val.text = '0.0 W (Full)';
                    } else {
                        this._pwrCharging.val.text = '--';
                    }
                }
                if (this._pwrPeak) this._pwrPeak.val.text = `${this._pwrStats.peak.toFixed(1)} W`;
                if (this._pwrAvg) this._pwrAvg.val.text = `${avgDraw.toFixed(1)} W`;
            }
        }

        // ── Disk ──
        if (data.dsk) {
            const dsk = data.dsk;
            const diskPct = dsk.diskPercent || 0;
            const readMB  = dsk.readRate  / (1024 * 1024);
            const writeMB = dsk.writeRate / (1024 * 1024);
            const totalMB = readMB + writeMB;

            const sc = this._summaryCards?.disk;
            if (sc) {
                sc.valueLabel.text = `${Math.round(diskPct)}%`;
                sc.pbar.setPercent(diskPct);
                sc.subLabel.visible = true;
                sc.subLabel.text = `Read: ${readMB.toFixed(1)} MB/s · Write: ${writeMB.toFixed(1)} MB/s`;
            }
            if (this._dskReadSparkline) {
                this._dskReadSparkline.addSample(readMB);
                this._dskReadSparkline.setScaleLabel(`Read: ${readMB.toFixed(1)} MB/s`);
            }
            if (this._dskWriteSparkline) {
                this._dskWriteSparkline.addSample(writeMB);
                this._dskWriteSparkline.setScaleLabel(`Write: ${writeMB.toFixed(1)} MB/s`);
            }
            if (this._dskRead)  this._dskRead.val.text  = `${readMB.toFixed(2)} MB/s`;
            if (this._dskWrite) this._dskWrite.val.text = `${writeMB.toFixed(2)} MB/s`;
            if (this._dskUsage) this._dskUsage.val.text = `${Math.round(diskPct)}% (${totalMB.toFixed(1)} MB/s)`;

            if (this._dskMountsBox && dsk.mounts) {
                this._dskMountsBox.destroy_all_children();
                dsk.mounts.forEach(m => {
                    const row = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });
                    const headRow = new St.BoxLayout();
                    headRow.add_child(new St.Label({ text: m.mount, style: 'font-size: 0.8em; color: #ffffff; font-weight: 500;', x_expand: true }));
                    headRow.add_child(new St.Label({ text: `${formatBytes(m.used, useGiB)} / ${formatBytes(m.size, useGiB)} (${Math.round(m.percent)}%)`, style: 'font-size: 0.8em; color: #a0a0b8;' }));
                    row.add_child(headRow);

                    const pbar = new ProgressBar(4, 0.96, 0.83, 0.18);
                    pbar.setPercent(m.percent);
                    row.add_child(pbar);

                    this._dskMountsBox.add_child(row);
                });
            }
        }

        // ── Network ──
        if (data.net) {
            const net = data.net;
            const sc = this._summaryCards?.network;
            if (sc) {
                sc.valueLabel.text = formatSpeed(net.total.rxRate + net.total.txRate);
                sc.pbar.setPercent(Math.min(100, ((net.total.rxRate + net.total.txRate) / (10 * 1024 * 1024)) * 100)); // normalized to 10MB/s
                sc.subLabel.visible = true;
                sc.subLabel.text = `↓ ${formatSpeed(net.total.rxRate)}   ↑ ${formatSpeed(net.total.txRate)}`;
            }
            if (this._netRxSparkline) {
                this._netRxSparkline.addSample(net.total.rxRate / 1024);
                this._netRxSparkline.setScaleLabel(`DL: ${formatSpeed(net.total.rxRate)}`);
            }
            if (this._netTxSparkline) {
                this._netTxSparkline.addSample(net.total.txRate / 1024);
                this._netTxSparkline.setScaleLabel(`UL: ${formatSpeed(net.total.txRate)}`);
            }
            if (this._netRx) this._netRx.val.text = formatSpeed(net.total.rxRate);
            if (this._netTx) this._netTx.val.text = formatSpeed(net.total.txRate);
            if (this._netSessionRx) this._netSessionRx.val.text = formatBytes(net.sessionRx || 0, useGiB);
            if (this._netSessionTx) this._netSessionTx.val.text = formatBytes(net.sessionTx || 0, useGiB);

            if (this._netIfaceList && net.interfaces) {
                this._netIfaceList.destroy_all_children();
                for (const [ifaceName, ifaceData] of Object.entries(net.interfaces)) {
                    if (ifaceData.rxRate > 100 || ifaceData.txRate > 100 || /^(wlan|eth|enp|wlp)/.test(ifaceName)) {
                        const row = new St.BoxLayout({ style: 'padding: 2px 0;' });
                        row.add_child(new St.Label({ text: ifaceName, style: 'font-size: 0.8em; color: #ffffff; font-weight: 500;', width: 80 }));
                        row.add_child(new St.Label({ text: `↓ ${formatSpeed(ifaceData.rxRate)}   ↑ ${formatSpeed(ifaceData.txRate)}`, style: 'font-size: 0.8em; color: #a0a0b8;', x_expand: true }));
                        this._netIfaceList.add_child(row);
                    }
                }
            }
        }

        // ── Thermal ──
        if (data.thm) {
            const thm = data.thm;
            const sc = this._summaryCards?.thermal;
            if (sc) {
                sc.valueLabel.text = formatTemp(thm.packageTemp, tempUnit);
                sc.pbar.setPercent(Math.min(100, (thm.packageTemp / 100) * 100)); // normalized to 100C
            }
            if (this._thmSparkline) {
                this._thmSparkline.addSample(thm.packageTemp);
                this._thmSparkline.setScaleLabel(`Temp: ${formatTemp(thm.packageTemp, tempUnit)}`);
            }
            if (this._thmSensorsBox) {
                this._thmSensorsBox.destroy_all_children();
                if (thm.sensors && thm.sensors.length > 0) {
                    thm.sensors.forEach(sensor => {
                        const row = this._detailRow(sensor.label, formatTemp(sensor.temp, tempUnit));
                        this._thmSensorsBox.add_child(row.row);
                    });
                } else {
                    const row = this._detailRow('No sensors found', '--');
                    this._thmSensorsBox.add_child(row.row);
                }
            }
            if (this._thmFansCard && this._thmFansBox) {
                this._thmFansBox.destroy_all_children();
                if (thm.fans && thm.fans.length > 0) {
                    this._thmFansCard.visible = true;
                    thm.fans.forEach(fan => {
                        const row = this._detailRow(fan.label, `${fan.rpm} RPM`);
                        this._thmFansBox.add_child(row.row);
                    });
                } else {
                    this._thmFansCard.visible = false;
                }
            }
        }

        // ── GPU ──
        if (data.gpu) {
            const gpu = data.gpu;
            const sc = this._summaryCards?.gpu;
            if (sc) {
                sc.box.visible = gpu.present;
                if (gpu.present) {
                    sc.valueLabel.text = `${Math.round(gpu.percent)}%`;
                    sc.pbar.setPercent(gpu.percent);
                    sc.subLabel.visible = true;
                    sc.subLabel.text = `${gpu.brand || 'GPU'} · ${formatTemp(gpu.temp, tempUnit)}`;
                }
            }
            if (this._tabButtons?.gpu) {
                this._tabButtons.gpu.visible = gpu.present;
            }
            if (gpu.present) {
                if (this._gpuSparkline) {
                    this._gpuSparkline.addSample(gpu.percent);
                    this._gpuSparkline.setScaleLabel(`Cur: ${Math.round(gpu.percent)}%`);
                }
                if (this._gpuUsage) this._gpuUsage.val.text = `${Math.round(gpu.percent)}%`;
                if (this._gpuMem)   this._gpuMem.val.text   = `${Math.round(gpu.memPercent)}% (${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)})`;
                if (this._gpuTemp)  this._gpuTemp.val.text  = formatTemp(gpu.temp, tempUnit);
                if (this._gpuPower) this._gpuPower.val.text = gpu.powerDraw ? `${gpu.powerDraw.toFixed(1)} W` : '--';
            }
        }

        // ── Top Processes (CPU & Memory tabs) ──
        if (this._menuOpen && data.processes && data.processes.length > 0) {
            if (this._activeTab === 'cpu' && this._procList) {
                this._renderProcessListUI(this._procList, '_procWidgets', data.processes, false);
            } else if (this._activeTab === 'memory' && this._memProcList) {
                this._renderProcessListUI(this._memProcList, '_memProcWidgets', data.processes, true);
            }
        }
    }

    _renderProcessListUI(container, targetWidgetsKey, processes, isMemory = false) {
        if (!container) return;
        if (!this[targetWidgetsKey]) this[targetWidgetsKey] = [];

        if (this[targetWidgetsKey].length !== processes.length) {
            container.destroy_all_children();
            this[targetWidgetsKey] = [];
            for (let i = 0; i < processes.length; i++) {
                const item = new St.BoxLayout({ style: 'padding: 4px 0; spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });

                const iconBox = new St.BoxLayout({ style: 'width: 24px; height: 24px; background-color: rgba(255,255,255,0.06); border-radius: 6px;' });
                const icon = new St.Icon({ icon_name: 'system-run-symbolic', style: 'icon-size: 14px; color: #a0a0b8;' });
                iconBox.add_child(icon);
                item.add_child(iconBox);

                const detailsCol = new St.BoxLayout({ vertical: true, x_expand: true });
                const nameLbl = new St.Label({ style: 'font-size: 0.85em; color: #ffffff; font-weight: 500;', text: '' });
                detailsCol.add_child(nameLbl);

                const color = isMemory ? [0.569, 0.255, 0.675] : [0.208, 0.518, 0.894];
                const pbar = new ProgressBar(4, color[0], color[1], color[2]);
                detailsCol.add_child(pbar);

                item.add_child(detailsCol);

                const statLbl = new St.Label({ style: 'font-size: 0.85em; color: #a0a0b8; font-weight: 600;', width: 45 });
                statLbl.x_align = Clutter.ActorAlign.END;
                item.add_child(statLbl);

                container.add_child(item);
                this[targetWidgetsKey].push({ nameLbl, statLbl, pbar, icon });
            }
        }

        const iconMap = {
            'firefox': 'firefox-symbolic',
            'gnome-shell': 'utilities-terminal-symbolic',
            'spotify': 'audio-card-symbolic',
            'chrome': 'google-chrome-symbolic',
            'code': 'com.visualstudio.code-symbolic',
            'system': 'system-run-symbolic'
        };

        processes.forEach((proc, i) => {
            const w = this[targetWidgetsKey][i];
            if (!w) return;
            w.nameLbl.text = proc.comm;
            const valNum = isMemory ? proc.mem : proc.cpu;
            w.statLbl.text = `${valNum.toFixed(1)}%`;
            w.pbar.setPercent(valNum);

            let iconName = 'system-run-symbolic';
            const commLower = proc.comm.toLowerCase();
            for (const [key, name] of Object.entries(iconMap)) {
                if (commLower.includes(key)) {
                    iconName = name;
                    break;
                }
            }
            w.icon.icon_name = iconName;
        });
    }
}
