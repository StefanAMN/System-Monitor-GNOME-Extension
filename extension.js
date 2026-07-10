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

// Formatters
function formatBytes(bytes, useGiB = false) {
    if (bytes === 0) return '0 B';
    const k = useGiB ? 1024 : 1000;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = bytes / Math.pow(k, i);
    const suffix = useGiB && i > 0 ? sizes[i].replace('K', 'Ki').replace('M', 'Mi').replace('G', 'Gi').replace('T', 'Ti') : sizes[i];
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
    if (unit === 'F') {
        return `${Math.round((celsius * 9) / 5 + 32)}°F`;
    }
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
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (obj, res) => {
                try {
                    const [, stdout] = obj.communicate_utf8_finish(res);
                    resolve(stdout || '');
                } catch (e) {
                    resolve('');
                }
            });
        } catch (e) {
            resolve('');
        }
    });
}

// Custom GObject Cairo Widgets
const Sparkline = GObject.registerClass({
    GTypeName: 'ResourcePulseSparkline',
}, class Sparkline extends St.DrawingArea {
    _init(width = 120, height = 30, maxVal = 100, autoScale = false) {
        super._init({
            style_class: 'resource-pulse-sparkline',
            width: width,
            height: height
        });
        this.history = [];
        this.maxVal = maxVal;
        this.autoScale = autoScale;
        this.connect('repaint', this._draw.bind(this));
    }

    addSample(val) {
        this.history.push(val);
        if (this.history.length > 60) {
            this.history.shift();
        }
        this.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        cr.save();

        let fgColor = [0.2, 0.6, 1.0, 1.0]; // Default blue
        try {
            const node = area.get_theme_node();
            const cssColor = node.get_color('color');
            if (cssColor) {
                fgColor = [cssColor.red / 255, cssColor.green / 255, cssColor.blue / 255, cssColor.alpha / 255];
            }
        } catch (e) {}

        if (this.history.length < 2) {
            cr.restore();
            return;
        }

        let max = this.maxVal;
        if (this.autoScale) {
            const localMax = Math.max(...this.history);
            if (localMax > max) max = localMax;
        }
        if (max <= 0) max = 1;

        const step = w / 59;

        // 1. Draw fill underneath
        cr.moveTo(0, h);
        for (let i = 0; i < this.history.length; i++) {
            const x = i * step;
            const y = h - (this.history[i] / max) * h;
            cr.lineTo(x, y);
        }
        cr.lineTo((this.history.length - 1) * step, h);
        cr.closePath();
        cr.setSourceRGBA(fgColor[0], fgColor[1], fgColor[2], 0.12);
        cr.fill();

        // 2. Draw line
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(...fgColor);
        for (let i = 0; i < this.history.length; i++) {
            const x = i * step;
            const y = h - (this.history[i] / max) * h;
            if (i === 0) {
                cr.moveTo(x, y);
            } else {
                cr.lineTo(x, y);
            }
        }
        cr.stroke();

        cr.restore();
    }
});

const RingProgress = GObject.registerClass({
    GTypeName: 'ResourcePulseRingProgress',
}, class RingProgress extends St.DrawingArea {
    _init(width = 36, height = 36, warnThreshold = 90) {
        super._init({
            style_class: 'resource-pulse-ring',
            width: width,
            height: height
        });
        this.percent = 0;
        this.warnThreshold = warnThreshold;
        this.connect('repaint', this._draw.bind(this));
    }

    setValue(percent) {
        this.percent = Math.max(0, Math.min(100, percent));
        this.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const xc = w / 2;
        const yc = h / 2;
        const radius = Math.min(w, h) / 2 - 3;

        cr.save();

        let fgColor = [0.2, 0.6, 1.0, 1.0]; // Accent blue
        if (this.percent >= this.warnThreshold) {
            fgColor = [0.9, 0.1, 0.1, 1.0]; // Red
        } else if (this.percent >= this.warnThreshold - 10) {
            fgColor = [0.9, 0.6, 0.1, 1.0]; // Orange
        }

        // Background circle
        cr.setLineWidth(3);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.15);
        cr.arc(xc, yc, radius, 0, 2 * Math.PI);
        cr.stroke();

        // Foreground arc
        cr.setLineWidth(3);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(...fgColor);
        cr.arc(xc, yc, radius, -Math.PI / 2, -Math.PI / 2 + (2 * Math.PI * this.percent / 100));
        cr.stroke();

        cr.restore();
    }
});

const BatteryGlyph = GObject.registerClass({
    GTypeName: 'ResourcePulseBatteryGlyph',
}, class BatteryGlyph extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'resource-pulse-ring',
            width: 32,
            height: 16
        });
        this.percent = 100;
        this.state = 'unknown';
        this.connect('repaint', this._draw.bind(this));
    }

    setPercent(percent, state) {
        this.percent = percent;
        this.state = state;
        this.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        cr.save();

        let fgColor = [1.0, 1.0, 1.0, 0.9];
        if (this.state === 'charging') {
            fgColor = [0.2, 0.8, 0.2, 1.0];
        } else if (this.percent <= 15) {
            fgColor = [0.9, 0.1, 0.1, 1.0];
        } else if (this.percent <= 30) {
            fgColor = [0.9, 0.6, 0.1, 1.0];
        }

        // Outer border
        const rx = 2;
        const bw = w - 4;
        const bh = h;
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(fgColor[0], fgColor[1], fgColor[2], 0.3);
        cr.arc(rx, rx, rx, Math.PI, 1.5 * Math.PI);
        cr.arc(bw - rx, rx, rx, 1.5 * Math.PI, 0);
        cr.arc(bw - rx, bh - rx, rx, 0, 0.5 * Math.PI);
        cr.arc(rx, bh - rx, rx, 0.5 * Math.PI, Math.PI);
        cr.closePath();
        cr.stroke();

        // Tip
        cr.setSourceRGBA(...fgColor);
        cr.rectangle(bw + 1, h / 2 - 3, 2, 6);
        cr.fill();

        // Fill level
        const pad = 2;
        const fillW = (bw - pad * 2) * (this.percent / 100);
        const fillH = bh - pad * 2;
        if (fillW > 0) {
            cr.rectangle(pad, pad, fillW, fillH);
            cr.fill();
        }

        // Lightning bolt if charging
        if (this.state === 'charging') {
            cr.setSourceRGBA(1.0, 1.0, 1.0, 1.0);
            cr.setLineWidth(1);
            const cx = bw / 2;
            const cy = bh / 2;
            cr.moveTo(cx + 1, cy - 5);
            cr.lineTo(cx - 3, cy + 1);
            cr.lineTo(cx - 1, cy + 1);
            cr.lineTo(cx - 1, cy + 5);
            cr.lineTo(cx + 3, cy - 1);
            cr.lineTo(cx + 1, cy - 1);
            cr.closePath();
            cr.fill();
        }

        cr.restore();
    }
});

export default class ResourcePulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Initialize Samplers
        this._cpu = new CpuSampler();
        this._mem = new MemorySampler();
        this._bat = new BatterySampler();
        this._pwr = new PowerSampler();
        this._dsk = new DiskSampler();
        this._net = new NetworkSampler();
        this._thm = new ThermalSampler();
        this._gpu = new GpuSampler();

        // UI Panel indicator
        this._indicator = new PanelMenu.Button(0.0, 'Resource Pulse', false);
        this._indicatorBox = new St.BoxLayout({
            style_class: 'resource-pulse-indicator-box'
        });
        this._indicator.add_child(this._indicatorBox);

        // Grid pinned metrics row containers
        this._topBarWidgets = {};

        // Dropdown Menu setup
        this._menuSection = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false
        });
        this._menuContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-menu-section'
        });
        this._menuSection.add_child(this._menuContainer);
        this._indicator.menu.addMenuItem(this._menuSection);

        // Build Dropdown Parts
        this._buildPinGrid();
        this._buildDashboard();

        // Track menu open state to query top processes
        this._menuOpen = false;
        this._openStateId = this._indicator.menu.connect('open-state-changed', (menu, open) => {
            this._menuOpen = open;
            if (open) this._poll();
        });

        // Add to main panel
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Settings change listeners
        this._pinnedId = this._settings.connect('changed::pinned-metrics', () => this._rebuildTopBar());
        this._compactId = this._settings.connect('changed::compact-label', () => this._rebuildTopBar());
        this._pollId = this._settings.connect('changed::poll-interval', () => this._startPolling());
        this._densityId = this._settings.connect('changed::density-mode', () => this._syncDensityMode());

        // Rebuild top bar initially
        this._rebuildTopBar();

        // Sync initial density mode
        this._syncDensityMode();

        // Start polling loop
        this._startPolling();
    }

    disable() {
        // Disconnect GSettings
        if (this._pinnedId) this._settings.disconnect(this._pinnedId);
        if (this._compactId) this._settings.disconnect(this._compactId);
        if (this._pollId) this._settings.disconnect(this._pollId);
        if (this._densityId) this._settings.disconnect(this._densityId);

        // Remove timer
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        // Disconnect Menu signals
        if (this._openStateId) {
            this._indicator.menu.disconnect(this._openStateId);
        }

        // Clean up widgets & panel items
        this._indicator.destroy();
        this._indicator = null;
        this._indicatorBox = null;
        this._topBarWidgets = {};
        this._settings = null;
    }

    _startPolling() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
        }

        const interval = this._settings.get_int('poll-interval') || 2;

        // Perform initial poll
        this._poll();

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _poll() {
        try {
            // Sample all metrics asynchronously
            const [cpu, mem, bat, dsk, net, thm, gpu] = await Promise.all([
                this._cpu.sample(),
                this._mem.sample(),
                this._bat.sample(),
                this._dsk.sample(),
                this._net.sample(),
                this._thm.sample(),
                this._gpu.sample()
            ]);

            // Sample power, passing in battery data for system rate calculation
            const pwr = await this._pwr.sample(bat);

            // Query top processes only if menu is open
            let processes = [];
            if (this._menuOpen) {
                const stdout = await runSubprocess(['ps', '-eo', 'pid,%cpu,%mem,comm', '--sort=-%cpu']);
                if (stdout) {
                    const lines = stdout.trim().split('\n').slice(1, 5); // top 4 processes
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

            // Update Top Bar UI
            this._updateTopBarUI(data);

            // Update Dashboard UI
            this._updateDashboardUI(data);
        } catch (e) {
            console.error(`Error in resource poll: ${e.message}`);
        }
    }

    _rebuildTopBar() {
        this._indicatorBox.destroy_all_children();
        this._topBarWidgets = {};

        const pinned = this._settings.get_strv('pinned-metrics') || [];
        const compact = this._settings.get_boolean('compact-label');

        pinned.forEach((key, index) => {
            if (index > 0) {
                const div = new St.Label({
                    text: '|',
                    style_class: 'resource-pulse-divider',
                    y_align: Clutter.ActorAlign.CENTER
                });
                this._indicatorBox.add_child(div);
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

        // Sync grid buttons selection states
        this._updatePinGridState(pinned);
    }

    _getIconName(key) {
        const iconMap = {
            cpu: 'utilities-system-monitor-symbolic',
            memory: 'media-flash-symbolic',
            battery: 'battery-good-symbolic',
            power: 'thunderbolt-symbolic',
            disk: 'drive-harddisk-symbolic',
            network: 'network-transmit-receive-symbolic',
            thermal: 'sensors-temperature-symbolic',
            gpu: 'video-display-symbolic'
        };
        return iconMap[key] || 'image-missing-symbolic';
    }

    _updateTopBarUI(data) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';

        Object.keys(this._topBarWidgets).forEach(key => {
            const widget = this._topBarWidgets[key];
            if (!widget.label) return;

            let text = '--';
            if (key === 'cpu' && data.cpu) {
                text = `${Math.round(data.cpu.total)}%`;
            } else if (key === 'memory' && data.mem) {
                text = `${Math.round(data.mem.percent)}%`;
            } else if (key === 'battery' && data.bat) {
                if (data.bat.present) {
                    text = `${Math.round(data.bat.percent)}%`;
                    // Dynamically change battery icon based on charging state
                    widget.icon.icon_name = data.bat.state === 'charging'
                        ? 'battery-good-charging-symbolic'
                        : 'battery-good-symbolic';
                } else {
                    text = 'N/A';
                }
            } else if (key === 'power' && data.pwr) {
                const draw = data.pwr.systemPower !== null ? data.pwr.systemPower : (data.pwr.packagePower || 0);
                text = draw > 0 ? `${draw.toFixed(1)}W` : '0W';
            } else if (key === 'disk' && data.dsk && data.dsk.mounts.length > 0) {
                text = `${Math.round(data.dsk.mounts[0].percent)}%`;
            } else if (key === 'network' && data.net) {
                const totalRx = data.net.total.rxRate;
                text = formatSpeed(totalRx);
            } else if (key === 'thermal' && data.thm) {
                text = formatTemp(data.thm.temp, tempUnit);
            } else if (key === 'gpu' && data.gpu) {
                text = data.gpu.present ? `${Math.round(data.gpu.percent)}%` : 'N/A';
            }

            widget.label.text = text;

            // Warning Threshold colors
            const cpuWarn = this._settings.get_int('threshold-cpu') || 90;
            const memWarn = this._settings.get_int('threshold-mem') || 90;
            const tempWarn = this._settings.get_int('threshold-temp') || 80;

            let isWarning = false;
            if (key === 'cpu' && data.cpu && data.cpu.total >= cpuWarn) isWarning = true;
            if (key === 'memory' && data.mem && data.mem.percent >= memWarn) isWarning = true;
            if (key === 'thermal' && data.thm && data.thm.temp >= tempWarn) isWarning = true;

            if (isWarning) {
                widget.label.style = 'color: #e01b24;'; // System Red
            } else {
                widget.label.style = '';
            }
        });
    }

    _buildPinGrid() {
        const title = new St.Label({
            text: 'Pin Metrics to Top Bar',
            style_class: 'resource-pulse-section-title'
        });
        this._menuContainer.add_child(title);

        this._grid = new St.BoxLayout({
            style_class: 'resource-pulse-picker-row',
            vertical: false
        });

        this._gridButtons = {};

        const metrics = [
            { key: 'cpu', label: 'CPU' },
            { key: 'memory', label: 'Memory' },
            { key: 'battery', label: 'Battery' },
            { key: 'power', label: 'Power' },
            { key: 'disk', label: 'Disk' },
            { key: 'network', label: 'Net' },
            { key: 'thermal', label: 'Temp' },
            { key: 'gpu', label: 'GPU' }
        ];

        metrics.forEach((metric) => {
            const button = new St.Button({
                style_class: 'resource-pulse-grid-button',
                can_focus: true,
                toggle_mode: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });

            const icon = new St.Icon({
                icon_name: this._getIconName(metric.key),
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER
            });
            button.set_child(icon);

            button.accessible_name = metric.label;

            // Hover tooltip handler
            button.connect('notify::hover', () => {
                if (button.hover) {
                    title.text = `Pin to Top Bar: ${metric.label}`;
                } else {
                    title.text = 'Pin Metrics to Top Bar';
                }
            });

            // Connect button event
            button.connect('clicked', () => {
                let current = this._settings.get_strv('pinned-metrics') || [];
                if (button.checked) {
                    if (!current.includes(metric.key)) {
                        current.push(metric.key);
                    }
                } else {
                    current = current.filter(k => k !== metric.key);
                }
                this._settings.set_strv('pinned-metrics', current);
            });

            this._grid.add_child(button);
            this._gridButtons[metric.key] = button;
        });

        this._menuContainer.add_child(this._grid);
    }

    _updatePinGridState(pinned) {
        if (!this._gridButtons) return;
        Object.keys(this._gridButtons).forEach(key => {
            const btn = this._gridButtons[key];
            const isPinned = pinned.includes(key);
            btn.checked = isPinned;

            if (isPinned) {
                btn.add_style_class_name('resource-pulse-grid-button-active');
            } else {
                btn.remove_style_class_name('resource-pulse-grid-button-active');
            }
        });
    }

    _buildDashboard() {
        const headerRow = new St.BoxLayout({
            style_class: 'resource-pulse-dashboard-header',
            vertical: false,
            x_expand: true
        });

        const title = new St.Label({
            text: 'System Dashboard',
            style_class: 'resource-pulse-section-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true
        });
        headerRow.add_child(title);

        this._densityBtn = new St.Button({
            style_class: 'resource-pulse-density-button',
            can_focus: true,
            toggle_mode: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._densityLabel = new St.Label({
            text: 'Compact',
            style_class: 'resource-pulse-density-label',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._densityBtn.set_child(this._densityLabel);

        this._densityBtn.connect('clicked', () => {
            const isDetailed = this._densityBtn.checked;
            this._settings.set_string('density-mode', isDetailed ? 'detailed' : 'compact');
        });

        headerRow.add_child(this._densityBtn);
        this._menuContainer.add_child(headerRow);

        this._dashboardBox = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-dashboard'
        });

        this._cards = {};

        // 1. CPU Card
        this._cards.cpu = this._createCard('CPU', 'cpu', {
            hasRing: true,
            hasSpark: true
        });

        // 2. Memory Card
        this._cards.memory = this._createCard('Memory', 'memory', {
            hasRing: true,
            hasSpark: true
        });

        // 3. Battery Card
        this._cards.battery = this._createCard('Battery', 'battery', {
            hasBatteryGlyph: true,
            hasSpark: true
        });

        // 4. Power Card
        this._cards.power = this._createCard('Power', 'power', {
            hasSpark: true
        });

        // 5. Disk Card
        this._cards.disk = this._createCard('Disk', 'disk', {
            hasSpark: true
        });

        // 6. Network Card
        this._cards.network = this._createCard('Network', 'network', {
            hasSpark: true
        });

        // 7. Thermal Card
        this._cards.thermal = this._createCard('Thermal', 'thermal', {
            hasSpark: true
        });

        // 8. GPU Card
        this._cards.gpu = this._createCard('GPU', 'gpu', {
            hasRing: true,
            hasSpark: true
        });

        // 9. Processes Card
        this._cards.processes = this._createProcessesCard();

        this._menuContainer.add_child(this._dashboardBox);
    }

    _createCard(titleText, key, options = {}) {
        const card = new St.BoxLayout({
            style_class: 'resource-pulse-card',
            vertical: true
        });

        const header = new St.BoxLayout({
            style_class: 'resource-pulse-card-header',
            vertical: false
        });
        const icon = new St.Icon({
            icon_name: this._getIconName(key),
            style_class: 'system-status-icon',
            margin_right: 6,
            y_align: Clutter.ActorAlign.CENTER
        });
        const title = new St.Label({
            text: titleText,
            style_class: 'resource-pulse-card-title',
            y_align: Clutter.ActorAlign.CENTER
        });
        const subtitle = new St.Label({
            text: '',
            style_class: 'resource-pulse-card-subtitle',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END
        });

        header.add_child(icon);
        header.add_child(title);
        header.add_child(subtitle);
        card.add_child(header);

        // Content layout (left meter + right sparkline)
        const contentBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'resource-pulse-card-content'
        });

        let ring = null;
        let batteryGlyph = null;

        if (options.hasRing) {
            const cpuWarn = this._settings.get_int('threshold-cpu') || 90;
            ring = new RingProgress(36, 36, key === 'cpu' ? cpuWarn : 90);
            ring.y_align = Clutter.ActorAlign.CENTER;
            contentBox.add_child(ring);
        }

        if (options.hasBatteryGlyph) {
            batteryGlyph = new BatteryGlyph();
            batteryGlyph.y_align = Clutter.ActorAlign.CENTER;
            contentBox.add_child(batteryGlyph);
        }

        let sparkline = null;
        if (options.hasSpark) {
            sparkline = new Sparkline(160, 32, 100, key === 'power' || key === 'disk' || key === 'network');
            sparkline.y_align = Clutter.ActorAlign.CENTER;
            sparkline.x_expand = true;
            contentBox.add_child(sparkline);
        }

        card.add_child(contentBox);

        // CPU Core Grid
        let coreGrid = null;
        if (key === 'cpu') {
            const coreLayout = new Clutter.GridLayout({
                column_homogeneous: true,
                row_homogeneous: true
            });
            coreGrid = new St.Widget({
                layout_manager: coreLayout,
                style_class: 'resource-pulse-core-grid',
                visible: false
            });
            card.add_child(coreGrid);
        }

        // Details label
        const details = new St.Label({
            text: '',
            style_class: 'resource-pulse-card-details',
            visible: false
        });
        card.add_child(details);

        this._dashboardBox.add_child(card);

        const cardObj = { card, subtitle, details, ring, batteryGlyph, sparkline, coreGrid, expanded: false };

        card.reactive = true;
        card.connect('button-press-event', () => {
            cardObj.expanded = !cardObj.expanded;
            this._updateCardLayout(key);
            return Clutter.EVENT_STOP;
        });

        return cardObj;
    }

    _syncDensityMode() {
        const mode = this._settings.get_string('density-mode') || 'compact';
        const isDetailed = mode === 'detailed';

        if (this._densityBtn) {
            this._densityBtn.checked = isDetailed;
            this._densityLabel.text = isDetailed ? 'Detailed' : 'Compact';
        }

        Object.keys(this._cards).forEach(key => {
            if (key === 'processes') return;
            this._cards[key].expanded = isDetailed;
            this._updateCardLayout(key);
        });
    }

    _updateCardLayout(key) {
        const cardObj = this._cards[key];
        if (!cardObj) return;

        const expanded = cardObj.expanded;

        if (cardObj.ring) {
            cardObj.ring.visible = expanded;
        }
        if (cardObj.batteryGlyph) {
            cardObj.batteryGlyph.visible = expanded;
        }
        if (cardObj.details) {
            cardObj.details.visible = expanded;
        }
        if (key === 'cpu' && cardObj.coreGrid) {
            cardObj.coreGrid.visible = expanded;
        }
        if (cardObj.sparkline) {
            const h = expanded ? 32 : 16;
            cardObj.sparkline.set_height(h);
            cardObj.sparkline.queue_repaint();
        }

        if (expanded) {
            cardObj.card.style = 'padding: 8px; margin-bottom: 6px;';
        } else {
            cardObj.card.style = 'padding: 4px 6px; margin-bottom: 4px;';
        }
    }

    _updateCpuCoresUI(cores) {
        if (!this._cards.cpu || !this._cards.cpu.coreGrid) return;
        const grid = this._cards.cpu.coreGrid;
        const layout = grid.layout_manager;

        const getCoreColor = (load) => {
            if (load < 50) {
                const alpha = 0.15 + (load / 50) * 0.45;
                return `rgba(53, 132, 228, ${alpha})`;
            } else if (load < 90) {
                const alpha = 0.5 + ((load - 50) / 40) * 0.4;
                return `rgba(240, 173, 78, ${alpha})`;
            } else {
                const alpha = 0.7 + ((load - 90) / 10) * 0.3;
                return `rgba(224, 27, 36, ${alpha})`;
            }
        };

        if (!this._coreWidgets) {
            this._coreWidgets = [];
            cores.forEach((load, i) => {
                const box = new St.BoxLayout({
                    style_class: 'resource-pulse-core-box',
                    style: `background-color: ${getCoreColor(load)};`
                });
                const label = new St.Label({
                    text: `${i}`,
                    style_class: 'resource-pulse-core-label',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    y_expand: true
                });
                box.add_child(label);
                
                const row = Math.floor(i / 8);
                const col = i % 8;
                layout.attach(box, col, row, 1, 1);
                this._coreWidgets.push(box);
            });
        } else {
            cores.forEach((load, i) => {
                const box = this._coreWidgets[i];
                if (box) {
                    box.style = `background-color: ${getCoreColor(load)};`;
                }
            });
        }
    }

    _createProcessesCard() {
        const card = new St.BoxLayout({
            style_class: 'resource-pulse-card',
            vertical: true
        });

        const title = new St.Label({
            text: 'Top Process Consumers',
            style_class: 'resource-pulse-card-title',
            margin_bottom: 4
        });
        card.add_child(title);

        const list = new St.BoxLayout({
            vertical: true
        });
        card.add_child(list);

        this._dashboardBox.add_child(card);

        return { card, list };
    }

    _updateDashboardUI(data) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const memUnit = this._settings.get_string('unit-mem') || 'GB';
        const useGiB = memUnit === 'GiB';

        // 1. Update CPU Card
        if (data.cpu) {
            const cpu = data.cpu;
            this._cards.cpu.subtitle.text = `${Math.round(cpu.total)}%`;
            this._cards.cpu.ring.setValue(cpu.total);
            this._cards.cpu.sparkline.addSample(cpu.total);
            this._cards.cpu.details.text = `Load: ${cpu.loadavg.join(' · ')}  |  Uptime: ${formatUptime(cpu.uptime)}`;
            
            if (cpu.cores) {
                this._updateCpuCoresUI(cpu.cores);
            }
        }

        // 2. Update Memory Card
        if (data.mem) {
            const mem = data.mem;
            this._cards.memory.subtitle.text = `${Math.round(mem.percent)}%`;
            this._cards.memory.ring.setValue(mem.percent);
            this._cards.memory.sparkline.addSample(mem.percent);
            this._cards.memory.details.text = `Used: ${formatBytes(mem.used, useGiB)} / ${formatBytes(mem.total, useGiB)}\nSwap: ${Math.round(mem.swapPercent)}% (${formatBytes(mem.swapUsed, useGiB)} / ${formatBytes(mem.swapTotal, useGiB)})`;
        }

        // 3. Update Battery Card
        if (data.bat) {
            const bat = data.bat;
            if (bat.present) {
                this._cards.battery.card.visible = true;
                const stateText = bat.state === 'charging' ? 'Charging' : (bat.state === 'discharging' ? 'Discharging' : 'Full');
                this._cards.battery.subtitle.text = `${Math.round(bat.percent)}% (${stateText})`;
                this._cards.battery.batteryGlyph.setPercent(bat.percent, bat.state);
                this._cards.battery.sparkline.addSample(bat.percent);

                let timeStr = 'Estimating...';
                if (bat.timeRemaining > 0) {
                    const hrs = Math.floor(bat.timeRemaining / 3600);
                    const mins = Math.floor((bat.timeRemaining % 3600) / 60);
                    timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
                }

                let energyStr = '';
                if (bat.energy !== undefined && bat.energy !== null && bat.energy > 0) {
                    const en = bat.energy.toFixed(1);
                    const ef = bat.energyFull ? bat.energyFull.toFixed(1) : '--';
                    const efd = bat.energyFullDesign ? bat.energyFullDesign.toFixed(1) : '--';
                    energyStr = `  |  Energy: ${en} / ${ef} Wh (design: ${efd} Wh)`;
                }

                this._cards.battery.details.text = `Time Remaining: ${timeStr}  |  Health: ${Math.round(bat.health)}%  |  Cycles: ${bat.cycleCount}${energyStr}`;
            } else {
                this._cards.battery.card.visible = false;
            }
        }

        // 4. Update Power Card
        if (data.pwr) {
            const pwr = data.pwr;
            const hasDraw = pwr.raplSupported || pwr.systemPower !== null;
            if (hasDraw) {
                this._cards.power.card.visible = true;
                const draw = pwr.systemPower !== null ? pwr.systemPower : (pwr.packagePower || 0);
                this._cards.power.subtitle.text = `${draw.toFixed(1)} W`;
                this._cards.power.sparkline.addSample(draw);

                const sysStr = pwr.systemPower !== null ? `System rate: ${pwr.systemPower.toFixed(1)}W` : '';
                const pkgStr = pwr.packagePower !== null ? `CPU PKG: ${pwr.packagePower.toFixed(1)}W` : '';
                this._cards.power.details.text = [pkgStr, sysStr].filter(s => s !== '').join('  |  ');
            } else {
                this._cards.power.card.visible = false;
            }
        }

        // 5. Update Disk Card
        if (data.dsk) {
            const dsk = data.dsk;
            const readMB = dsk.readRate / (1024 * 1024);
            const writeMB = dsk.writeRate / (1024 * 1024);
            
            this._cards.disk.subtitle.text = `R: ${readMB.toFixed(1)} MB/s  |  W: ${writeMB.toFixed(1)} MB/s`;
            // Add WriteRate to sparkline
            this._cards.disk.sparkline.addSample(writeMB);

            const spaceLines = dsk.mounts.map(m => {
                return `${m.mount} : ${Math.round(m.percent)}% (${formatBytes(m.used, useGiB)} / ${formatBytes(m.size, useGiB)})`;
            });
            this._cards.disk.details.text = spaceLines.join('\n');
        }

        // 6. Update Network Card
        if (data.net) {
            const net = data.net;
            const rxSpeed = formatSpeed(net.total.rxRate);
            const txSpeed = formatSpeed(net.total.txRate);
            this._cards.network.subtitle.text = `Down: ${rxSpeed}  |  Up: ${txSpeed}`;
            // Add download rate to sparkline
            this._cards.network.sparkline.addSample(net.total.rxRate / 1024); // in KB/s

            const ifaceLines = [];
            Object.keys(net.interfaces).slice(0, 3).forEach(iface => {
                const details = net.interfaces[iface];
                if (details.rxRate > 0 || details.txRate > 0) {
                    ifaceLines.push(`${iface}: Down ${formatSpeed(details.rxRate)}, Up ${formatSpeed(details.txRate)}`);
                }
            });
            if (ifaceLines.length === 0) ifaceLines.push('No active interfaces');
            this._cards.network.details.text = ifaceLines.join('\n');
        }

        // 7. Update Thermal Card
        if (data.thm) {
            const thm = data.thm;
            this._cards.thermal.subtitle.text = formatTemp(thm.temp, tempUnit);
            this._cards.thermal.sparkline.addSample(thm.temp);

            let fanStr = '';
            if (thm.fans.length > 0) {
                fanStr = '  |  Fans: ' + thm.fans.map(f => `${f.rpm} RPM`).join(', ');
            }
            this._cards.thermal.details.text = `Cores: ${thm.cores.map(c => formatTemp(c, tempUnit)).slice(0, 6).join(', ')}${fanStr}`;
        }

        // 8. Update GPU Card
        if (data.gpu) {
            const gpu = data.gpu;
            if (gpu.present) {
                this._cards.gpu.card.visible = true;
                this._cards.gpu.subtitle.text = `${Math.round(gpu.percent)}%`;
                this._cards.gpu.ring.setValue(gpu.percent);
                this._cards.gpu.sparkline.addSample(gpu.percent);
                this._cards.gpu.details.text = `Brand: ${gpu.brand}  |  VRAM: ${Math.round(gpu.memPercent)}% (${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)})  |  Temp: ${formatTemp(gpu.temp, tempUnit)}`;
            } else {
                this._cards.gpu.card.visible = false;
            }
        }

        // 9. Update Top Processes Card
        if (this._menuOpen && data.processes && data.processes.length > 0) {
            this._cards.processes.list.destroy_all_children();
            data.processes.forEach(proc => {
                const item = new St.BoxLayout({
                    style_class: 'resource-pulse-process-item'
                });
                const name = new St.Label({
                    text: proc.comm,
                    style_class: 'resource-pulse-process-name',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                });
                const stat = new St.Label({
                    text: `${Math.round(proc.cpu)}% CPU   ${Math.round(proc.mem)}% MEM`,
                    style_class: 'resource-pulse-process-stat',
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER
                });
                item.add_child(name);
                item.add_child(stat);
                this._cards.processes.list.add_child(item);
            });
        }
    }
}
