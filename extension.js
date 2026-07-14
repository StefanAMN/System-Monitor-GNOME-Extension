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
    _init(width = 360, height = 40, maxVal = 100, autoScale = false) {
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

        // Accent blue
        const fgR = 0.208, fgG = 0.518, fgB = 0.894, fgA = 1.0;

        if (this.history.length < 2) { cr.restore(); return; }

        let max = this.maxVal;
        if (this.autoScale) {
            const localMax = Math.max(...this.history);
            if (localMax > max) max = localMax;
        }
        if (max <= 0) max = 1;

        const step = w / 59;

        // Fill
        cr.moveTo(0, h);
        for (let i = 0; i < this.history.length; i++) {
            cr.lineTo(i * step, h - (this.history[i] / max) * (h - 2));
        }
        cr.lineTo((this.history.length - 1) * step, h);
        cr.closePath();
        cr.setSourceRGBA(fgR, fgG, fgB, 0.12);
        cr.fill();

        // Line
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(fgR, fgG, fgB, fgA);
        for (let i = 0; i < this.history.length; i++) {
            const x = i * step;
            const y = h - (this.history[i] / max) * (h - 2);
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.stroke();

        // Scale label text
        if (this.scaleLabel) {
            cr.selectFontFace("Sans", Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(10);
            cr.setSourceRGBA(1, 1, 1, 0.4);
            cr.moveTo(4, 12);
            cr.showText(this.scaleLabel);
        }

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
        this._activeTab = 'cpu';
        this._coreWidgets = null;
        this._buildPinGrid();
        this._buildDashboard();

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
            if (this._menuOpen) {
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

        this._updatePinGridState(pinned);
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

    // ── Pin Grid ──────────────────────────────────────────────────────────────

    _buildPinGrid() {
        const title = new St.Label({
            text: 'Pin Metrics to Top Bar',
            style_class: 'resource-pulse-section-title'
        });
        this._menuContainer.add_child(title);

        this._pinGrid = new St.BoxLayout({
            style_class: 'resource-pulse-picker-row',
            vertical: false
        });

        this._gridButtons = {};

        const metrics = [
            { key: 'cpu' }, { key: 'memory' }, { key: 'battery' },
            { key: 'power' }, { key: 'disk' }, { key: 'network' },
            { key: 'thermal' }, { key: 'gpu' }
        ];

        metrics.forEach(metric => {
            const button = new St.Button({
                style_class: 'resource-pulse-grid-button',
                can_focus: true,
                toggle_mode: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });
            button.set_child(new St.Icon({
                icon_name: this._getIconName(metric.key),
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER
            }));
            button.accessible_name = metric.key;

            button.connect('notify::hover', () => {
                title.text = button.hover
                    ? `Pin to Top Bar: ${metric.key.charAt(0).toUpperCase() + metric.key.slice(1)}`
                    : 'Pin Metrics to Top Bar';
            });

            button.connect('clicked', () => {
                let current = this._settings.get_strv('pinned-metrics') || [];
                if (button.checked) {
                    if (!current.includes(metric.key)) current.push(metric.key);
                } else {
                    current = current.filter(k => k !== metric.key);
                }
                this._settings.set_strv('pinned-metrics', current);
            });

            this._pinGrid.add_child(button);
            this._gridButtons[metric.key] = button;
        });

        this._menuContainer.add_child(this._pinGrid);
    }

    _updatePinGridState(pinned) {
        if (!this._gridButtons) return;
        Object.keys(this._gridButtons).forEach(key => {
            const btn = this._gridButtons[key];
            btn.checked = pinned.includes(key);
            if (btn.checked) btn.add_style_class_name('resource-pulse-grid-button-active');
            else btn.remove_style_class_name('resource-pulse-grid-button-active');
        });
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────

    _buildDashboard() {
        // ── Summary Grid ──
        const gridLayout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: false
        });
        this._summaryGrid = new St.Widget({
            layout_manager: gridLayout,
            style_class: 'resource-pulse-summary-grid'
        });
        this._summaryCards = {};

        const SUMMARY_METRICS = [
            { key: 'cpu',     label: 'CPU' },
            { key: 'memory',  label: 'Memory' },
            { key: 'battery', label: 'Battery' },
            { key: 'power',   label: 'Power' },
            { key: 'disk',    label: 'Disk' },
            { key: 'network', label: 'Network' },
            { key: 'thermal', label: 'Thermal' },
            { key: 'gpu',     label: 'GPU' },
        ];

        SUMMARY_METRICS.forEach((metric, i) => {
            const card = new St.BoxLayout({
                style_class: 'resource-pulse-summary-card',
                vertical: true,
                reactive: true,
                can_focus: true
            });

            const header = new St.BoxLayout({ vertical: false, style_class: 'resource-pulse-summary-header' });
            header.add_child(new St.Icon({
                icon_name: this._getIconName(metric.key),
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER
            }));
            card.add_child(header);

            const titleLbl = new St.Label({
                text: metric.label,
                style_class: 'resource-pulse-summary-title'
            });
            card.add_child(titleLbl);

            const valueLbl = new St.Label({
                text: '--',
                style_class: 'resource-pulse-summary-value'
            });
            card.add_child(valueLbl);

            card.connect('button-press-event', () => {
                this._activeTab = metric.key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            });

            gridLayout.attach(card, i % 4, Math.floor(i / 4), 1, 1);
            this._summaryCards[metric.key] = { box: card, valueLabel: valueLbl };
        });

        this._menuContainer.add_child(this._summaryGrid);



        // ── Detail Area ──
        this._detailArea = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-detail-area'
        });

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

        // Add all sections hidden; only one will be shown
        for (const key of Object.keys(this._detailSections)) {
            if (this._detailSections[key]) {
                this._detailArea.add_child(this._detailSections[key]);
                this._detailSections[key].visible = false;
            }
        }

        this._menuContainer.add_child(this._detailArea);
        this._updateTabVisibility();
    }

    _updateTabVisibility() {

        // Summary cards highlight
        for (const [key, card] of Object.entries(this._summaryCards || {})) {
            if (key === this._activeTab) card.box.add_style_class_name('resource-pulse-summary-card-active');
            else card.box.remove_style_class_name('resource-pulse-summary-card-active');
        }

        // Show ONLY the active detail section
        for (const [key, section] of Object.entries(this._detailSections || {})) {
            if (section) section.visible = (key === this._activeTab);
        }
    }

    // ── Detail Section Builders ───────────────────────────────────────────────

    _detailRow(labelText, valueText = '--') {
        const row = new St.BoxLayout({ style_class: 'resource-pulse-detail-row', x_expand: true });
        const lbl = new St.Label({ text: labelText, style_class: 'resource-pulse-detail-label', x_expand: true });
        const val = new St.Label({ text: valueText, style_class: 'resource-pulse-detail-value' });
        row.add_child(lbl);
        row.add_child(val);
        return { row, val };
    }

    _buildCpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });

        box.add_child(new St.Label({ text: 'CPU details', style_class: 'resource-pulse-detail-title' }));

        this._cpuSparkline = new Sparkline(360, 40, 100, false);
        this._cpuSparkline.x_expand = true;
        box.add_child(this._cpuSparkline);

        box.add_child(new St.Label({ text: 'Per core', style_class: 'resource-pulse-core-section-title' }));

        // Core grid: 4 columns of boxes  (Core 0–N)
        const coreLayout = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        this._cpuCoreGrid = new St.Widget({ layout_manager: coreLayout, style_class: 'resource-pulse-core-grid' });
        box.add_child(this._cpuCoreGrid);

        this._cpuLoadAvg = this._detailRow('Load average');
        box.add_child(this._cpuLoadAvg.row);

        this._cpuUptime = this._detailRow('Uptime');
        box.add_child(this._cpuUptime.row);

        box.add_child(new St.Label({ text: 'Top Processes', style_class: 'resource-pulse-core-section-title' }));
        this._procList = new St.BoxLayout({ vertical: true });
        box.add_child(this._procList);

        return box;
    }

    _buildMemoryDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Memory details', style_class: 'resource-pulse-detail-title' }));
        this._memSparkline = new Sparkline(360, 40, 100, false);
        this._memSparkline.x_expand = true;
        box.add_child(this._memSparkline);
        this._memUsed = this._detailRow('Used / Total');
        box.add_child(this._memUsed.row);
        this._memSwap = this._detailRow('Swap');
        box.add_child(this._memSwap.row);
        return box;
    }

    _buildBatteryDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Battery details', style_class: 'resource-pulse-detail-title' }));
        this._batSparkline = new Sparkline(360, 40, 100, false);
        this._batSparkline.x_expand = true;
        box.add_child(this._batSparkline);
        this._batState  = this._detailRow('State');
        box.add_child(this._batState.row);
        this._batHealth = this._detailRow('Health');
        box.add_child(this._batHealth.row);
        return box;
    }

    _buildPowerDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Power details', style_class: 'resource-pulse-detail-title' }));
        this._pwrSparkline = new Sparkline(360, 40, 100, true);
        this._pwrSparkline.x_expand = true;
        box.add_child(this._pwrSparkline);
        this._pwrSystem  = this._detailRow('System Draw');
        box.add_child(this._pwrSystem.row);
        this._pwrPackage = this._detailRow('CPU Package');
        box.add_child(this._pwrPackage.row);
        return box;
    }

    _buildDiskDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Disk details', style_class: 'resource-pulse-detail-title' }));
        this._dskSparkline = new Sparkline(360, 40, 100, true);
        this._dskSparkline.x_expand = true;
        box.add_child(this._dskSparkline);
        this._dskRead  = this._detailRow('Read rate');
        box.add_child(this._dskRead.row);
        this._dskWrite = this._detailRow('Write rate');
        box.add_child(this._dskWrite.row);
        this._dskUsage = this._detailRow('Usage');
        box.add_child(this._dskUsage.row);
        return box;
    }

    _buildNetworkDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Network details', style_class: 'resource-pulse-detail-title' }));
        this._netSparkline = new Sparkline(360, 40, 100, true);
        this._netSparkline.x_expand = true;
        box.add_child(this._netSparkline);
        this._netRx = this._detailRow('Download');
        box.add_child(this._netRx.row);
        this._netTx = this._detailRow('Upload');
        box.add_child(this._netTx.row);
        return box;
    }

    _buildThermalDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'Thermal details', style_class: 'resource-pulse-detail-title' }));
        this._thmSparkline = new Sparkline(360, 40, 100, true);
        this._thmSparkline.x_expand = true;
        box.add_child(this._thmSparkline);
        this._thmPackage = this._detailRow('Package temp');
        box.add_child(this._thmPackage.row);
        this._thmFan = this._detailRow('Fan speed');
        box.add_child(this._thmFan.row);
        return box;
    }

    _buildGpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-detail-section' });
        box.add_child(new St.Label({ text: 'GPU details', style_class: 'resource-pulse-detail-title' }));
        this._gpuSparkline = new Sparkline(360, 40, 100, false);
        this._gpuSparkline.x_expand = true;
        box.add_child(this._gpuSparkline);
        this._gpuUsage = this._detailRow('Usage');
        box.add_child(this._gpuUsage.row);
        this._gpuMem   = this._detailRow('VRAM');
        box.add_child(this._gpuMem.row);
        this._gpuTemp  = this._detailRow('Temperature');
        box.add_child(this._gpuTemp.row);
        return box;
    }

    // ── CPU Core Grid ─────────────────────────────────────────────────────────

    _updateCpuCoresUI(cores) {
        if (!this._cpuCoreGrid) return;
        const layout = this._cpuCoreGrid.layout_manager;

        const coreColor = (load) => {
            if (load < 50)  return `rgba(53, 132, 228, ${(0.20 + (load / 50) * 0.45).toFixed(2)})`;
            if (load < 90)  return `rgba(240, 173, 78, ${(0.50 + ((load - 50) / 40) * 0.40).toFixed(2)})`;
            return `rgba(224, 27, 36, ${(0.70 + ((load - 90) / 10) * 0.30).toFixed(2)})`;
        };

        if (!this._coreWidgets || this._coreWidgets.length !== cores.length) {
            // Rebuild grid
            this._cpuCoreGrid.destroy_all_children();
            this._coreWidgets = [];
            cores.forEach((load, i) => {
                const box = new St.BoxLayout({
                    style_class: 'resource-pulse-core-box',
                    style: `background-color: ${coreColor(load)};`,
                    vertical: true
                });
                const lblCore = new St.Label({
                    text: `Core ${i}`,
                    style_class: 'resource-pulse-core-label'
                });
                const lblVal = new St.Label({
                    text: `${Math.round(load)}%`,
                    style_class: 'resource-pulse-core-value'
                });
                box.add_child(lblCore);
                box.add_child(lblVal);
                layout.attach(box, i % 4, Math.floor(i / 4), 1, 1);
                this._coreWidgets.push({ box, lblVal });
            });
        } else {
            cores.forEach((load, i) => {
                if (this._coreWidgets[i]) {
                    this._coreWidgets[i].box.style = `background-color: ${coreColor(load)};`;
                    this._coreWidgets[i].lblVal.text = `${Math.round(load)}%`;
                }
            });
        }
    }

    // ── Dashboard Update ──────────────────────────────────────────────────────

    _updateDashboardUI(data) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const memUnit  = this._settings.get_string('unit-mem')  || 'GB';
        const useGiB   = memUnit === 'GiB';

        // ── CPU ──
        if (data.cpu) {
            const cpu = data.cpu;
            if (this._summaryCards?.cpu)
                this._summaryCards.cpu.valueLabel.text = `${Math.round(cpu.total)}%`;
            if (this._cpuSparkline) {
                this._cpuSparkline.addSample(cpu.total);
                this._cpuSparkline.setScaleLabel(`Cur: ${Math.round(cpu.total)}%`);
            }
            if (this._cpuLoadAvg)   this._cpuLoadAvg.val.text = cpu.loadavg.join(' · ');
            if (this._cpuUptime)    this._cpuUptime.val.text  = formatUptime(cpu.uptime);
            if (cpu.cores)          this._updateCpuCoresUI(cpu.cores);
        }

        // ── Memory ──
        if (data.mem) {
            const mem = data.mem;
            if (this._summaryCards?.memory)
                this._summaryCards.memory.valueLabel.text = `${Math.round(mem.percent)}%`;
            if (this._memSparkline) {
                this._memSparkline.addSample(mem.percent);
                this._memSparkline.setScaleLabel(`Used: ${Math.round(mem.percent)}%`);
            }
            if (this._memUsed) this._memUsed.val.text =
                `${formatBytes(mem.used, useGiB)} / ${formatBytes(mem.total, useGiB)}`;
            if (this._memSwap) this._memSwap.val.text =
                `${Math.round(mem.swapPercent)}% (${formatBytes(mem.swapUsed, useGiB)} / ${formatBytes(mem.swapTotal, useGiB)})`;
        }

        // ── Battery ──
        if (data.bat) {
            const bat = data.bat;
            const sc = this._summaryCards?.battery;
            if (sc) {
                sc.box.visible = bat.present;
                if (bat.present) sc.valueLabel.text = `${Math.round(bat.percent)}%`;
            }
            if (bat.present) {
                if (this._batSparkline) {
                    this._batSparkline.addSample(bat.percent);
                    this._batSparkline.setScaleLabel(`Cur: ${Math.round(bat.percent)}%`);
                }
                if (this._batState) {
                    const s = bat.state === 'charging' ? 'Charging'
                        : bat.state === 'discharging' ? 'Discharging' : 'Full';
                    this._batState.val.text = s;
                }
                if (this._batHealth) this._batHealth.val.text =
                    `${Math.round(bat.health)}%  (${bat.cycleCount} cycles)`;
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
                    this._pwrSparkline.setScaleLabel(`Draw: ${draw.toFixed(1)}W`);
                }
                if (this._pwrSystem)  this._pwrSystem.val.text  = pwr.systemPower  !== null ? `${pwr.systemPower.toFixed(1)} W`  : '--';
                if (this._pwrPackage) this._pwrPackage.val.text = pwr.packagePower !== null ? `${pwr.packagePower.toFixed(1)} W` : '--';
            }
        }

        // ── Disk ──
        if (data.dsk) {
            const dsk = data.dsk;
            const maxPct = dsk.mounts.length > 0 ? Math.max(...dsk.mounts.map(m => m.percent)) : 0;
            if (this._summaryCards?.disk) this._summaryCards.disk.valueLabel.text = `${Math.round(maxPct)}%`;
            const readMB  = dsk.readRate  / (1024 * 1024);
            const writeMB = dsk.writeRate / (1024 * 1024);
            if (this._dskSparkline) {
                this._dskSparkline.addSample(writeMB);
                this._dskSparkline.setScaleLabel(`W: ${writeMB.toFixed(1)} MB/s`);
            }
            if (this._dskRead)  this._dskRead.val.text  = `${readMB.toFixed(2)} MB/s`;
            if (this._dskWrite) this._dskWrite.val.text = `${writeMB.toFixed(2)} MB/s`;
            if (this._dskUsage) this._dskUsage.val.text = dsk.mounts.map(m => `${m.mount} ${Math.round(m.percent)}%`).join('  ') || '--';
        }

        // ── Network ──
        if (data.net) {
            const net = data.net;
            if (this._summaryCards?.network) this._summaryCards.network.valueLabel.text = formatSpeed(net.total.rxRate);
            if (this._netSparkline) {
                this._netSparkline.addSample(net.total.rxRate / 1024);
                this._netSparkline.setScaleLabel(`DL: ${formatSpeed(net.total.rxRate)}`);
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
                if (gpu.present) sc.valueLabel.text = `${Math.round(gpu.percent)}%`;
            }
            if (gpu.present) {
                if (this._gpuSparkline) {
                    this._gpuSparkline.addSample(gpu.percent);
                    this._gpuSparkline.setScaleLabel(`Cur: ${Math.round(gpu.percent)}%`);
                }
                if (this._gpuUsage) this._gpuUsage.val.text = `${Math.round(gpu.percent)}%`;
                if (this._gpuMem)   this._gpuMem.val.text   = `${Math.round(gpu.memPercent)}% (${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)})`;
                if (this._gpuTemp)  this._gpuTemp.val.text  = formatTemp(gpu.temp, tempUnit);
            }
        }

        // ── Top Processes (CPU tab) ──
        if (this._menuOpen && data.processes && data.processes.length > 0 && this._procList) {
            this._procList.destroy_all_children();
            data.processes.forEach(proc => {
                const item = new St.BoxLayout({ style_class: 'resource-pulse-process-item' });
                item.add_child(new St.Label({
                    text: proc.comm,
                    style_class: 'resource-pulse-process-name',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                }));
                item.add_child(new St.Label({
                    text: `${Math.round(proc.cpu)}% CPU   ${Math.round(proc.mem)}% MEM`,
                    style_class: 'resource-pulse-process-stat',
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER
                }));
                this._procList.add_child(item);
            });
        }
    }
}
