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
    _init(width = 400, height = 100, maxVal = 100, autoScale = false) {
        super._init({ style_class: 'resource-pulse-sparkline', width, height });
        this.history = [];
        this.maxVal = maxVal;
        this.autoScale = autoScale;
        this.scaleLabel = '';
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

        const fgR = 0.208, fgG = 0.518, fgB = 0.894, fgA = 1.0;

        if (this.history.length < 2) { cr.restore(); return; }

        let max = this.maxVal;
        if (this.autoScale) {
            const localMax = Math.max(...this.history);
            if (localMax > max) max = localMax;
        }
        if (max <= 0) max = 1;

        const step = w / 59;

        cr.moveTo(0, h);
        for (let i = 0; i < this.history.length; i++) {
            cr.lineTo(i * step, h - (this.history[i] / max) * (h - 2));
        }
        cr.lineTo((this.history.length - 1) * step, h);
        cr.closePath();
        cr.setSourceRGBA(fgR, fgG, fgB, 0.12);
        cr.fill();

        cr.setLineWidth(1.5);
        cr.setSourceRGBA(fgR, fgG, fgB, fgA);
        for (let i = 0; i < this.history.length; i++) {
            const x = i * step;
            const y = h - (this.history[i] / max) * (h - 2);
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        if (this.scaleLabel) {
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(11);
            cr.setSourceRGBA(1, 1, 1, 0.6);
            cr.moveTo(6, 16);
            cr.showText(this.scaleLabel);
        }

        cr.restore();
    }
});

const ProgressBar = GObject.registerClass({
    GTypeName: 'ResourcePulseProgressBar',
}, class ProgressBar extends St.DrawingArea {
    _init(height = 6, r=0.2, g=0.51, b=0.89) {
        super._init({ style_class: 'resource-pulse-progress-track', height, x_expand: true });
        this.pct = 0;
        this.r = r; this.g = g; this.b = b;
        this.connect('repaint', this._draw.bind(this));
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

        this._rebuildTopBar();
        this._startPolling();
    }

    disable() {
        if (this._pinnedId) this._settings.disconnect(this._pinnedId);
        if (this._compactId) this._settings.disconnect(this._compactId);
        if (this._pollId) this._settings.disconnect(this._pollId);

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

    // ── Polling ──────────────────────────────────────────────────────────────

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
            const [cpu, mem, bat, dsk, net, thm, gpu] = await Promise.all([
                this._cpu.sample(), this._mem.sample(), this._bat.sample(),
                this._dsk.sample(), this._net.sample(), this._thm.sample(), this._gpu.sample()
            ]);
            const pwr = await this._pwr.sample(bat);

            let processes = [];
            if (this._menuOpen && this._activeTab === 'cpu') {
                const stdout = await runSubprocess(['ps', '-eo', 'pid,%cpu,%mem,comm', '--sort=-%cpu']);
                if (stdout) {
                    const lines = stdout.trim().split('\n').slice(1, 6);
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 4) {
                            processes.push({
                                pid: parts[0],
                                cpu: parseFloat(parts[1]) || 0,
                                mem: parseFloat(parts[2]) || 0,
                                comm: parts.slice(3).join(' ')
                            });
                        }
                    }
                }
            }

            const data = { cpu, mem, bat, pwr, dsk, net, thm, gpu, processes };
            this._updateTopBarUI(data);
            this._updateDashboardUI(data);
        } catch (e) {
            console.error(`ResourcePulse poll error: ${e.message}`);
        }
    }

    // ── Top Bar ───────────────────────────────────────────────────────────────

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

    _buildOverview() {
        this._overviewPage = new St.BoxLayout({ vertical: true });
        
        // Primary List (CPU, Memory, Battery)
        this._primaryList = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-primary-list' });
        this._overviewPage.add_child(this._primaryList);

        const primaryMetrics = [
            { key: 'cpu', label: 'CPU', tint: 'tint-cpu', rgb: [0.208, 0.518, 0.894] },
            { key: 'memory', label: 'Memory', tint: 'tint-memory', rgb: [0.569, 0.255, 0.675] },
            { key: 'battery', label: 'Battery', tint: 'tint-battery', rgb: [0.18, 0.76, 0.494] }
        ];

        this._summaryCards = {};

        primaryMetrics.forEach(m => {
            const card = new St.BoxLayout({
                style_class: `resource-pulse-primary-card ${m.tint}`,
                vertical: true, reactive: true, can_focus: true
            });
            const header = new St.BoxLayout({ style_class: 'resource-pulse-primary-header' });
            header.add_child(new St.Icon({
                icon_name: this._getIconName(m.key),
                style_class: `system-status-icon icon-${m.key}`,
                y_align: Clutter.ActorAlign.CENTER
            }));
            header.add_child(new St.Label({
                text: m.label,
                style_class: 'resource-pulse-primary-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            }));
            
            const valueLbl = new St.Label({ text: '-- %', style_class: 'resource-pulse-primary-value' });
            header.add_child(valueLbl);
            card.add_child(header);

            const pbar = new ProgressBar(6, m.rgb[0], m.rgb[1], m.rgb[2]);
            card.add_child(pbar);

            card.connect('button-press-event', () => {
                this._activeTab = m.key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            });

            this._primaryList.add_child(card);
            this._summaryCards[m.key] = { box: card, valueLabel: valueLbl, pbar };
        });

        // Secondary Grid (Disk, Net, Thermal, Power, GPU)
        const secondaryGrid = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        this._secondaryBox = new St.Widget({
            layout_manager: secondaryGrid,
            style_class: 'resource-pulse-secondary-grid'
        });
        this._overviewPage.add_child(this._secondaryBox);

        const secondaryMetrics = [
            { key: 'disk', label: 'Disk', tint: 'tint-disk' },
            { key: 'network', label: 'Network', tint: 'tint-network' },
            { key: 'thermal', label: 'Thermals', tint: 'tint-thermal' },
            { key: 'power', label: 'Power', tint: 'tint-power' },
            { key: 'gpu', label: 'GPU', tint: 'tint-gpu' }
        ];

        secondaryMetrics.forEach((m, i) => {
            const card = new St.BoxLayout({
                style_class: `resource-pulse-secondary-card ${m.tint}`,
                vertical: true, reactive: true, can_focus: true
            });
            
            card.add_child(new St.Label({
                text: m.label,
                style_class: 'resource-pulse-secondary-title'
            }));
            
            const valueLbl = new St.Label({
                text: '--',
                style_class: 'resource-pulse-secondary-value'
            });
            card.add_child(valueLbl);

            card.connect('button-press-event', () => {
                this._activeTab = m.key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            });

            secondaryGrid.attach(card, i % 2, Math.floor(i / 2), 1, 1);
            this._summaryCards[m.key] = { box: card, valueLabel: valueLbl };
        });

        this._menuContainer.add_child(this._overviewPage);
    }

    // ── Details Page ──────────────────────────────────────────────────────────

    _buildDetails() {
        this._detailArea = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-detail-area'
        });

        // Back button
        const backBtn = new St.Button({
            style_class: 'resource-pulse-back-button',
            label: '← Overview',
            x_align: Clutter.ActorAlign.START
        });
        backBtn.connect('clicked', () => {
            this._activeTab = 'overview';
            this._updateTabVisibility();
        });
        this._detailArea.add_child(backBtn);

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
            this._overviewPage.visible = true;
            this._detailArea.visible = false;
        } else {
            this._overviewPage.visible = false;
            this._detailArea.visible = true;
            for (const [key, section] of Object.entries(this._detailSections || {})) {
                if (section) section.visible = (key === this._activeTab);
            }
        }
    }

    _detailRow(labelText, valueText = '--') {
        const row = new St.BoxLayout({ style_class: 'resource-pulse-detail-row', x_expand: true });
        const lbl = new St.Label({ text: labelText, style_class: 'resource-pulse-detail-label', x_expand: true });
        const val = new St.Label({ text: valueText, style_class: 'resource-pulse-detail-value' });
        row.add_child(lbl);
        row.add_child(val);
        return { row, val };
    }

    _buildCpuDetails() {
        const box = new St.BoxLayout({ vertical: true });

        this._cpuHardware = new St.Label({ text: 'CPU', style_class: 'resource-pulse-hardware-header' });
        box.add_child(this._cpuHardware);
        
        box.add_child(new St.Label({ text: 'Current Usage', style_class: 'resource-pulse-sub-section-title' }));

        this._cpuSparkline = new Sparkline(400, 80, 100, false);
        this._cpuSparkline.x_expand = true;
        box.add_child(this._cpuSparkline);

        box.add_child(new St.Label({ text: 'Per-Core Usage', style_class: 'resource-pulse-sub-section-title' }));
        this._cpuCoreList = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;' });
        box.add_child(this._cpuCoreList);

        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._cpuLoadAvg = this._detailRow('Load average');
        box.add_child(this._cpuLoadAvg.row);
        this._cpuUptime = this._detailRow('Uptime');
        box.add_child(this._cpuUptime.row);

        box.add_child(new St.Label({ text: 'Top Processes', style_class: 'resource-pulse-sub-section-title' }));
        this._procList = new St.BoxLayout({ vertical: true });
        box.add_child(this._procList);

        return box;
    }

    _updateCpuCoresUI(cores) {
        if (!this._cpuCoreList) return;
        if (!this._coreWidgets || this._coreWidgets.length !== cores.length) {
            this._cpuCoreList.destroy_all_children();
            this._coreWidgets = [];
            cores.forEach((load, i) => {
                const row = new St.BoxLayout({ style: 'spacing: 10px;', y_align: Clutter.ActorAlign.CENTER, margin_bottom: 4 });
                const lbl = new St.Label({ text: `Core ${i}`, style_class: 'resource-pulse-detail-label', width: 50 });
                const pbar = new ProgressBar(6, 0.208, 0.518, 0.894);
                pbar.x_expand = true;
                const val = new St.Label({ text: `${Math.round(load)} %`, style_class: 'resource-pulse-detail-value', width: 40 });
                val.x_align = Clutter.ActorAlign.END;
                
                row.add_child(lbl);
                row.add_child(pbar);
                row.add_child(val);
                
                this._cpuCoreList.add_child(row);
                this._coreWidgets.push({ pbar, val });
            });
        }
        
        cores.forEach((load, i) => {
            if (this._coreWidgets[i]) {
                this._coreWidgets[i].pbar.setPercent(load);
                this._coreWidgets[i].val.text = `${Math.round(load)} %`;
            }
        });
    }

    _buildMemoryDetails() {
        const box = new St.BoxLayout({ vertical: true });
        box.add_child(new St.Label({ text: 'Memory', style_class: 'resource-pulse-hardware-header' }));
        box.add_child(new St.Label({ text: 'Current Usage', style_class: 'resource-pulse-sub-section-title' }));
        this._memSparkline = new Sparkline(400, 80, 100, false);
        this._memSparkline.x_expand = true;
        box.add_child(this._memSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._memUsed = this._detailRow('Used / Total');
        box.add_child(this._memUsed.row);
        this._memSwap = this._detailRow('Swap');
        box.add_child(this._memSwap.row);
        return box;
    }

    _buildBatteryDetails() {
        const box = new St.BoxLayout({ vertical: true });
        this._batHardware = new St.Label({ text: 'Battery', style_class: 'resource-pulse-hardware-header' });
        box.add_child(this._batHardware);
        box.add_child(new St.Label({ text: 'Charge History', style_class: 'resource-pulse-sub-section-title' }));
        this._batSparkline = new Sparkline(400, 80, 100, false);
        this._batSparkline.x_expand = true;
        box.add_child(this._batSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._batState  = this._detailRow('State');
        box.add_child(this._batState.row);
        this._batHealth = this._detailRow('Health');
        box.add_child(this._batHealth.row);
        return box;
    }

    _buildPowerDetails() {
        const box = new St.BoxLayout({ vertical: true });
        box.add_child(new St.Label({ text: 'Power', style_class: 'resource-pulse-hardware-header' }));
        box.add_child(new St.Label({ text: 'Draw History', style_class: 'resource-pulse-sub-section-title' }));
        this._pwrSparkline = new Sparkline(400, 80, 100, true);
        this._pwrSparkline.x_expand = true;
        box.add_child(this._pwrSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._pwrSystem  = this._detailRow('System Draw');
        box.add_child(this._pwrSystem.row);
        this._pwrPackage = this._detailRow('CPU Package');
        box.add_child(this._pwrPackage.row);
        return box;
    }

    _buildDiskDetails() {
        const box = new St.BoxLayout({ vertical: true });
        this._dskHardware = new St.Label({ text: 'Disk', style_class: 'resource-pulse-hardware-header' });
        box.add_child(this._dskHardware);
        box.add_child(new St.Label({ text: 'Write Activity', style_class: 'resource-pulse-sub-section-title' }));
        this._dskSparkline = new Sparkline(400, 80, 100, true);
        this._dskSparkline.x_expand = true;
        box.add_child(this._dskSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._dskRead  = this._detailRow('Read rate');
        box.add_child(this._dskRead.row);
        this._dskWrite = this._detailRow('Write rate');
        box.add_child(this._dskWrite.row);
        this._dskUsage = this._detailRow('Usage');
        box.add_child(this._dskUsage.row);
        return box;
    }

    _buildNetworkDetails() {
        const box = new St.BoxLayout({ vertical: true });
        this._netHardware = new St.Label({ text: 'Network', style_class: 'resource-pulse-hardware-header' });
        box.add_child(this._netHardware);
        box.add_child(new St.Label({ text: 'Download Activity', style_class: 'resource-pulse-sub-section-title' }));
        this._netSparkline = new Sparkline(400, 80, 100, true);
        this._netSparkline.x_expand = true;
        box.add_child(this._netSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._netRx = this._detailRow('Download');
        box.add_child(this._netRx.row);
        this._netTx = this._detailRow('Upload');
        box.add_child(this._netTx.row);
        return box;
    }

    _buildThermalDetails() {
        const box = new St.BoxLayout({ vertical: true });
        box.add_child(new St.Label({ text: 'Thermals', style_class: 'resource-pulse-hardware-header' }));
        box.add_child(new St.Label({ text: 'Temperature History', style_class: 'resource-pulse-sub-section-title' }));
        this._thmSparkline = new Sparkline(400, 80, 100, true);
        this._thmSparkline.x_expand = true;
        box.add_child(this._thmSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._thmPackage = this._detailRow('Package temp');
        box.add_child(this._thmPackage.row);
        this._thmFan = this._detailRow('Fan speed');
        box.add_child(this._thmFan.row);
        return box;
    }

    _buildGpuDetails() {
        const box = new St.BoxLayout({ vertical: true });
        this._gpuHardware = new St.Label({ text: 'GPU', style_class: 'resource-pulse-hardware-header' });
        box.add_child(this._gpuHardware);
        box.add_child(new St.Label({ text: 'Current Usage', style_class: 'resource-pulse-sub-section-title' }));
        this._gpuSparkline = new Sparkline(400, 80, 100, false);
        this._gpuSparkline.x_expand = true;
        box.add_child(this._gpuSparkline);
        box.add_child(new St.Label({ text: 'Stats', style_class: 'resource-pulse-sub-section-title' }));
        this._gpuUsage = this._detailRow('Usage');
        box.add_child(this._gpuUsage.row);
        this._gpuMem   = this._detailRow('VRAM');
        box.add_child(this._gpuMem.row);
        this._gpuTemp  = this._detailRow('Temperature');
        box.add_child(this._gpuTemp.row);
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
                this._summaryCards.cpu.valueLabel.text = `${Math.round(cpu.total)} %`;
                this._summaryCards.cpu.pbar.setPercent(cpu.total);
            }
            if (this._cpuSparkline) {
                this._cpuSparkline.addSample(cpu.total);
                this._cpuSparkline.setScaleLabel(`Cur: ${Math.round(cpu.total)} %`);
            }
            if (this._cpuHardware)  this._cpuHardware.text = cpu.hardwareModel || 'Unknown CPU';
            if (this._cpuLoadAvg)   this._cpuLoadAvg.val.text = cpu.loadavg.join(' · ');
            if (this._cpuUptime)    this._cpuUptime.val.text  = formatUptime(cpu.uptime);
            if (cpu.cores)          this._updateCpuCoresUI(cpu.cores);
        }

        // ── Memory ──
        if (data.mem) {
            const mem = data.mem;
            if (this._summaryCards?.memory) {
                this._summaryCards.memory.valueLabel.text = `${Math.round(mem.percent)} %`;
                this._summaryCards.memory.pbar.setPercent(mem.percent);
            }
            if (this._memSparkline) {
                this._memSparkline.addSample(mem.percent);
                this._memSparkline.setScaleLabel(`Used: ${Math.round(mem.percent)} %`);
            }
            if (this._memUsed) this._memUsed.val.text =
                `${formatBytes(mem.used, useGiB)} / ${formatBytes(mem.total, useGiB)}`;
            if (this._memSwap) this._memSwap.val.text =
                `${Math.round(mem.swapPercent)} % (${formatBytes(mem.swapUsed, useGiB)} / ${formatBytes(mem.swapTotal, useGiB)})`;
        }

        // ── Battery ──
        if (data.bat) {
            const bat = data.bat;
            const sc = this._summaryCards?.battery;
            if (sc) {
                sc.box.visible = bat.present;
                if (bat.present) {
                    sc.valueLabel.text = `${Math.round(bat.percent)} %`;
                    sc.pbar.setPercent(bat.percent);
                }
            }
            if (bat.present) {
                if (this._batSparkline) {
                    this._batSparkline.addSample(bat.percent);
                    this._batSparkline.setScaleLabel(`Cur: ${Math.round(bat.percent)} %`);
                }
                if (this._batHardware) {
                    const info = [];
                    if (bat.manufacturer && bat.manufacturer !== 'Unknown') info.push(bat.manufacturer);
                    if (bat.modelName && bat.modelName !== 'Unknown') info.push(bat.modelName);
                    if (bat.technology && bat.technology !== 'Unknown') info.push(bat.technology);
                    this._batHardware.text = info.length > 0 ? info.join(' ') : 'Unknown Battery';
                }
                if (this._batState) {
                    const s = bat.state === 'charging' ? 'Charging'
                        : bat.state === 'discharging' ? 'Discharging' : 'Full';
                    this._batState.val.text = s;
                }
                if (this._batHealth) this._batHealth.val.text =
                    `${Math.round(bat.health)} %  (${bat.cycleCount} cycles)`;
            }
        }

        // ── Power ──
        if (data.pwr) {
            const pwr = data.pwr;
            const hasDraw = pwr.raplSupported || pwr.systemPower !== null;
            const sc = this._summaryCards?.power;
            if (sc) {
                sc.box.visible = hasDraw;
                if (hasDraw) {
                    const draw = pwr.systemPower !== null ? pwr.systemPower : (pwr.packagePower || 0);
                    sc.valueLabel.text = `${draw.toFixed(1)} W`;
                }
            }
            if (hasDraw) {
                const draw = pwr.systemPower !== null ? pwr.systemPower : (pwr.packagePower || 0);
                if (this._pwrSparkline) {
                    this._pwrSparkline.addSample(draw);
                    this._pwrSparkline.setScaleLabel(`Draw: ${draw.toFixed(1)} W`);
                }
                if (this._pwrSystem)  this._pwrSystem.val.text  = pwr.systemPower  !== null ? `${pwr.systemPower.toFixed(1)} W`  : '--';
                if (this._pwrPackage) this._pwrPackage.val.text = pwr.packagePower !== null ? `${pwr.packagePower.toFixed(1)} W` : '--';
            }
        }

        // ── Disk ──
        if (data.dsk) {
            const dsk = data.dsk;
            const maxPct = dsk.mounts.length > 0 ? Math.max(...dsk.mounts.map(m => m.percent)) : 0;
            if (this._summaryCards?.disk) this._summaryCards.disk.valueLabel.text = `${Math.round(maxPct)} %`;
            const readMB  = dsk.readRate  / (1024 * 1024);
            const writeMB = dsk.writeRate / (1024 * 1024);
            if (this._dskSparkline) {
                this._dskSparkline.addSample(writeMB);
                this._dskSparkline.setScaleLabel(`W: ${writeMB.toFixed(1)} MB/s`);
            }
            if (this._dskHardware) {
                const info = [];
                if (dsk.hardwareModel && dsk.hardwareModel !== 'Unknown Disk') info.push(dsk.hardwareModel);
                if (dsk.diskType && dsk.diskType !== 'Unknown') info.push(dsk.diskType);
                this._dskHardware.text = info.length > 0 ? info.join(' ') : 'Unknown Disk';
            }
            if (this._dskRead)  this._dskRead.val.text  = `${readMB.toFixed(2)} MB/s`;
            if (this._dskWrite) this._dskWrite.val.text = `${writeMB.toFixed(2)} MB/s`;
            if (this._dskUsage) this._dskUsage.val.text = dsk.mounts.map(m => `${m.mount} ${Math.round(m.percent)} %`).join('  ') || '--';
        }

        // ── Network ──
        if (data.net) {
            const net = data.net;
            if (this._summaryCards?.network) this._summaryCards.network.valueLabel.text = formatSpeed(net.total.rxRate);
            if (this._netSparkline) {
                this._netSparkline.addSample(net.total.rxRate / 1024);
                this._netSparkline.setScaleLabel(`DL: ${formatSpeed(net.total.rxRate)}`);
            }
            if (this._netHardware) {
                const info = [];
                if (net.total.hardwareMAC && net.total.hardwareMAC !== 'Unknown') info.push(`MAC: ${net.total.hardwareMAC}`);
                if (net.total.hardwareSpeed && net.total.hardwareSpeed !== 'Unknown') info.push(net.total.hardwareSpeed);
                this._netHardware.text = info.length > 0 ? info.join('  ') : 'Unknown';
            }
            if (this._netRx) this._netRx.val.text = formatSpeed(net.total.rxRate);
            if (this._netTx) this._netTx.val.text = formatSpeed(net.total.txRate);
        }

        // ── Thermal ──
        if (data.thm) {
            const thm = data.thm;
            if (this._summaryCards?.thermal) this._summaryCards.thermal.valueLabel.text = formatTemp(thm.temp, tempUnit);
            if (this._thmSparkline) {
                this._thmSparkline.addSample(thm.temp);
                this._thmSparkline.setScaleLabel(`Temp: ${formatTemp(thm.temp, tempUnit)}`);
            }
            if (this._thmPackage)   this._thmPackage.val.text = formatTemp(thm.temp, tempUnit);
            if (this._thmFan) {
                this._thmFan.val.text = thm.fans && thm.fans.length > 0
                    ? thm.fans.map(f => `${f.rpm} RPM`).join(', ')
                    : 'N/A';
            }
        }

        // ── GPU ──
        if (data.gpu) {
            const gpu = data.gpu;
            const sc = this._summaryCards?.gpu;
            if (sc) {
                sc.box.visible = gpu.present;
                if (gpu.present) sc.valueLabel.text = `${Math.round(gpu.percent)} %`;
            }
            if (gpu.present) {
                if (this._gpuSparkline) {
                    this._gpuSparkline.addSample(gpu.percent);
                    this._gpuSparkline.setScaleLabel(`Cur: ${Math.round(gpu.percent)} %`);
                }
                if (this._gpuHardware) this._gpuHardware.text = gpu.hardwareModel || 'Unknown GPU';
                if (this._gpuUsage) this._gpuUsage.val.text = `${Math.round(gpu.percent)} %`;
                if (this._gpuMem)   this._gpuMem.val.text   = `${Math.round(gpu.memPercent)} % (${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)})`;
                if (this._gpuTemp)  this._gpuTemp.val.text  = formatTemp(gpu.temp, tempUnit);
            }
        }

        // ── Top Processes (CPU tab) ──
        if (this._menuOpen && data.processes && data.processes.length > 0 && this._procList) {
            if (this._procWidgets.length !== data.processes.length) {
                this._procList.destroy_all_children();
                this._procWidgets = [];
                for (let i = 0; i < data.processes.length; i++) {
                    const item = new St.BoxLayout({ style_class: 'resource-pulse-process-item', vertical: true });
                    const row1 = new St.BoxLayout();
                    const nameLbl = new St.Label({ style_class: 'resource-pulse-process-name', x_expand: true });
                    const statLbl = new St.Label({ style_class: 'resource-pulse-process-stat' });
                    row1.add_child(nameLbl);
                    row1.add_child(statLbl);
                    const pbar = new ProgressBar(4, 0.208, 0.518, 0.894); // CPU Blue
                    item.add_child(row1);
                    item.add_child(pbar);
                    this._procList.add_child(item);
                    this._procWidgets.push({ nameLbl, statLbl, pbar });
                }
            }
            data.processes.forEach((proc, i) => {
                const w = this._procWidgets[i];
                w.nameLbl.text = proc.comm;
                w.statLbl.text = `${Math.round(proc.cpu)} %`;
                w.pbar.setPercent(proc.cpu);
            });
        }
    }
}
