// The top bar: pinned metrics, fitting them into the room the panel gives, and their values.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { powerReadout, thermalUnavailable, batteryIconName, labelTemplate, gpuTooltip } from '../../lib/common/present.js';
import { formatBytes, formatSpeed, formatSpeedCompact, formatTemp, formatDuration, batteryStateLabel } from '../../lib/common/format.js';
import { TOP_BAR_FIT_MARGIN_PX, METRIC_NAMES } from './constants.js';

export class TopbarMethods {
    _rebuildTopBar() {
        this._indicatorBox.destroy_all_children();
        this._topBarWidgets = {};

        const pinned = this._pinnedMetrics();
        const compact = this._settings.get_boolean('compact-label');
        const templateOpts = {
            batFmt: this._settings.get_string('battery-top-format'),
            netFmt: this._settings.get_string('network-top-format'),
            tempUnit: this._settings.get_string('unit-temp')
        };

        // Shown while any metric, pinned or not, is in alert; its tooltip
        // says which.
        this._dangerBox = new St.BoxLayout({ reactive: true, track_hover: true, visible: false, style_class: 'resource-pulse-danger' });
        this._dangerBox.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            // Not system-status-icon: its panel padding makes the ⚠ wider
            // than a value, so showing it would hide two values instead of one.
            style_class: 'resource-pulse-danger-icon',
            y_align: Clutter.ActorAlign.CENTER
        }));
        this._dangerBox.connect('enter-event', () => this._showTooltip(this._dangerBox, this._alertText()));
        this._dangerBox.connect('leave-event', () => this._hideTooltip());
        this._indicatorBox.add_child(this._dangerBox);

        pinned.forEach((key, index) => {
            if (index > 0) {
                this._indicatorBox.add_child(new St.Label({
                    text: '|',
                    style_class: 'resource-pulse-divider',
                    // Faint in whatever colour the panel uses (light or dark).
                    opacity: 110,
                    y_align: Clutter.ActorAlign.CENTER
                }));
            }

            const box = new St.BoxLayout({ reactive: true, track_hover: true });
            const icon = this._setMetricIcon(new St.Icon({
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER
            }), key);
            box.add_child(icon);

            let label = null;
            if (!compact) {
                label = new St.Label({
                    text: '--',
                    style_class: 'resource-pulse-label',
                    y_align: Clutter.ActorAlign.CENTER
                });
                // Reserve room for the widest value so neighbours in the
                // panel do not shift every time a digit is gained or lost.
                // Measured with the label's real font once it is styled.
                // A metric this machine cannot provide shows 'n/a' for
                // good, and room for numbers would only be a gap after it.
                const template = labelTemplate(key, templateOpts);
                const reserve = () => {
                    let style = null;
                    if (label.text !== 'n/a') {
                        // Not styled off the stage; style-changed measures
                        // once it is.
                        if (!label.get_stage()) return;
                        // The handler can run before St pushes the themed font
                        // into the ClutterText, so take the font from the theme
                        // node; measuring with the stale one over-reserved.
                        const layout = label.clutter_text.create_pango_layout(template);
                        layout.set_font_description(label.get_theme_node().get_font());
                        const [width] = layout.get_pixel_size();
                        if (width <= 0) return;
                        // Via CSS so St widens minimum and natural size together;
                        // setting only the Clutter min-width aborts the shell.
                        style = `min-width: ${width}px;`;
                    }
                    if (label.style !== style) {
                        label.style = style;
                        // The reserved width is part of what the panel is
                        // asked for; styling happens during layout, so
                        // re-fit after it.
                        this._queueFitTopBar();
                    }
                };
                label.connect('style-changed', reserve);
                // Into or out of 'n/a': the reserved room follows.
                let unavailable = false;
                label.connect('notify::text', () => {
                    if ((label.text === 'n/a') === unavailable) return;
                    unavailable = !unavailable;
                    reserve();
                });
                box.add_child(label);
            }

            box.connect('enter-event', () => {
                if (this._tooltipTexts[key]) {
                    // A label hidden for lack of room: its value leads the tooltip.
                    const hidden = label && !label.visible ? `${METRIC_NAMES[key]}: ${label.text}\n` : '';
                    this._showTooltip(box, hidden + this._tooltipTexts[key]);
                }
            });
            box.connect('leave-event', () => {
                this._hideTooltip();
            });

            this._indicatorBox.add_child(box);
            this._topBarWidgets[key] = { box, label, icon };
        });
        this._applyTopBarCollapse();
        this._showDanger();
        this._fitTopBar();
    }

    /** Pinned metrics that have a text label, in pinned order. */
    _topBarLabels() {
        return Object.values(this._topBarWidgets).map(w => w.label).filter(l => l);
    }

    /** Hide the labels of the last `_topBarCollapsed` pinned metrics. */
    _applyTopBarCollapse() {
        const labels = this._topBarLabels();
        this._topBarCollapsed = Math.max(0, Math.min(this._topBarCollapsed, labels.length));
        labels.forEach((label, i) => {
            label.visible = i < labels.length - this._topBarCollapsed;
        });
    }

    /** Fit after the current layout pass; for use from allocation signals. */
    _queueFitTopBar() {
        if (this._fitIdleId || !this._indicator) return;
        this._fitIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._fitIdleId = 0;
            this._fitTopBar();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Keep the top bar inside the room the panel has. When the panel's right
     * side asks for more than it can get, labels would be ellipsized and the
     * system menu squeezed: instead the last pinned metrics still showing a
     * label drop to their icon. When room returns, labels come back in the
     * opposite order.
     */
    _fitTopBar() {
        const right = Main.panel._rightBox;
        const center = Main.panel._centerBox;
        const labels = this._topBarLabels();
        if (!this._indicator || !right || !center || labels.length === 0) return;
        // Not has_allocation(): that is false whenever a relayout is pending,
        // which is exactly when this runs. The last allocation is what is
        // wanted, as long as the panel has been laid out at all.
        const panelWidth = Main.panel.allocation.get_width();
        if (panelWidth <= 0 || center.allocation.get_width() <= 0) return;

        // The panel places its centre box at x = side width and gives each
        // side at most that much. Both figures are read from the centre's
        // allocation, which does not depend on what this extension shows.
        // The side is further limited to what is left beside the centre
        // (they differ when a dock shifts the work area).
        const rtl = Main.panel.get_text_direction() === Clutter.TextDirection.RTL;
        const beside = rtl ? center.allocation.x1 : panelWidth - center.allocation.x2;
        const room = Math.floor(Math.min(center.allocation.x1, beside));
        const wanted = () => right.get_preferred_width(-1)[1];

        const before = this._topBarCollapsed;
        while (wanted() > room && this._topBarCollapsed < labels.length) {
            this._topBarCollapsed++;
            this._applyTopBarCollapse();
        }
        if (this._topBarCollapsed !== before) return;

        while (this._topBarCollapsed > 0) {
            const next = labels[labels.length - this._topBarCollapsed];
            if (wanted() + next.get_preferred_width(-1)[1] + TOP_BAR_FIT_MARGIN_PX > room) break;
            this._topBarCollapsed--;
            this._applyTopBarCollapse();
        }
    }

    _updateTopBarUI(data, frame = false) {
        if (!this._settings || !this._indicator) return;
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const useGiB = this._settings.get_string('unit-mem') === 'GiB';
        const cpuWarn = this._settings.get_int('threshold-cpu') || 90;
        const memWarn = this._settings.get_int('threshold-mem') || 90;
        const tempWarn = this._settings.get_int('threshold-temp') || 80;
        const batFmt = this._settings.get_string('battery-top-format') || 'percent';
        const netFmt = this._settings.get_string('network-top-format') || 'download';

        // 1. Compute rich tooltips: they describe the reading, not the glide.
        if (!frame) {
            if (data.cpu) {
                const loadStr = data.cpu.loadavg ? data.cpu.loadavg.map(v => v.toFixed(2)).join(', ') : '--';
                this._tooltipTexts['cpu'] = `${data.cpu.hardwareModel || 'CPU'}\nLoad: ${loadStr}${data.cpu.frequency ? `\nFreq: ${data.cpu.frequency}` : ''}`;
            }
            if (data.mem) {
                const usedStr = formatBytes(data.mem.used, useGiB);
                const totalStr = formatBytes(data.mem.total, useGiB);
                const availStr = formatBytes(data.mem.available, useGiB);
                this._tooltipTexts['memory'] = `Used: ${usedStr} / ${totalStr}\nAvailable: ${availStr}\nSwap: ${Math.round(data.mem.swapPercent || 0)}%`;
            }
            if (data.bat && !data.bat.present)
                this._tooltipTexts['battery'] = 'Battery not available\nNo battery was detected.';
            if (data.bat && data.bat.present) {
                const state = batteryStateLabel(data.bat.state);
                let timeStr = '';
                if (data.bat.timeRemaining > 0)
                    timeStr = ` · ${formatDuration(data.bat.timeRemaining)} ${data.bat.state === 'charging' ? 'to full' : 'left'}`;
                this._tooltipTexts['battery'] = `Battery: ${data.bat.percent.toFixed(1)}% (${state}${timeStr})\nHealth: ${data.bat.health.toFixed(1)}% · Rate: ${(data.bat.energyRate || 0).toFixed(1)}W`;
            }
            if (data.pwr) {
                const readout = powerReadout(data.pwr);
                if (readout.value === null) {
                    this._tooltipTexts['power'] = `Power draw not available\n${readout.reason}`;
                } else {
                    const sys = data.pwr.systemPower !== null ? `${data.pwr.systemPower.toFixed(1)}W` : 'n/a on AC';
                    this._tooltipTexts['power'] = `System Draw: ${sys}\nCPU Package: ${data.pwr.packagePower !== null ? data.pwr.packagePower.toFixed(1) + 'W' : 'n/a'}`;
                }
            }
            if (data.dsk && data.dsk.mounts && data.dsk.mounts.length > 0) {
                const root = data.dsk.mounts[0];
                this._tooltipTexts['disk'] = `Space used on /: ${Math.round(root.percent)}% (${formatBytes(root.free, useGiB)} free)\nBusy: ${Math.round(data.dsk.diskPercent || 0)}% · Read ${formatSpeed(data.dsk.readRate || 0)} · Write ${formatSpeed(data.dsk.writeRate || 0)}`;
            }
            if (data.net && data.net.total) {
                const sessRx = formatBytes(data.net.sessionRx || 0, useGiB);
                const sessTx = formatBytes(data.net.sessionTx || 0, useGiB);
                this._tooltipTexts['network'] = `Download: ${formatSpeed(data.net.total.rxRate)}\nUpload: ${formatSpeed(data.net.total.txRate)}\nSession: ↓ ${sessRx}  ↑ ${sessTx}`;
            }
            if (data.thm) {
                const fanInfo = data.thm.fans && data.thm.fans.length > 0 ? `\nFan: ${data.thm.fans[0].rpm} RPM` : '';
                this._tooltipTexts['thermal'] = thermalUnavailable(data.thm)
                    ? 'Temperature not available\nNo readable hwmon or thermal-zone sensor was found.'
                    : `Package Temp: ${formatTemp(data.thm.packageTemp, tempUnit)}${fanInfo}`;
            }
            if (data.gpu) this._tooltipTexts['gpu'] = gpuTooltip(data.gpu, tempUnit);
        }

        // 2. Update top bar text & icons
        const batWidget = this._topBarWidgets['battery'];
        if (batWidget && data.bat && data.bat.state) {
            const iconName = batteryIconName(data.bat.present ? data.bat.percent : NaN, data.bat.state);
            if (batWidget.icon.icon_name !== iconName) batWidget.icon.icon_name = iconName;
        }
        Object.keys(this._topBarWidgets).forEach(key => {
            const widget = this._topBarWidgets[key];
            if (!widget.label) return;

            // '--' = not sampled yet, 'n/a' = this machine cannot provide it.
            let text = '--';
            if (key === 'cpu' && data.cpu) text = `${Math.round(data.cpu.total)}%`;
            else if (key === 'memory' && data.mem) text = `${Math.round(data.mem.percent)}%`;
            else if (key === 'battery' && data.bat && data.bat.present) {
                const basePct = `${Math.round(data.bat.percent)}%`;
                if (batFmt === 'percent-time' && data.bat.timeRemaining > 0) {
                    const h = Math.floor(data.bat.timeRemaining / 3600);
                    const m = Math.floor((data.bat.timeRemaining % 3600) / 60);
                    text = `${basePct} · ${h}h ${m}m`;
                } else {
                    text = basePct;
                }
            }
            else if (key === 'battery' && data.bat && data.bat.present === false && data.bat.state)
                text = 'n/a';
            else if (key === 'power' && data.pwr) {
                const readout = powerReadout(data.pwr);
                text = readout.value === null ? 'n/a' : `${readout.value.toFixed(1)}W`;
            }
            else if (key === 'disk' && data.dsk && data.dsk.mounts.length > 0)
                text = `${Math.round(data.dsk.mounts[0].percent)}%`;
            else if (key === 'network' && data.net) {
                if (netFmt === 'both') {
                    text = `↓${formatSpeedCompact(data.net.total.rxRate)} ↑${formatSpeedCompact(data.net.total.txRate)}`;
                } else if (netFmt === 'upload') {
                    text = `↑ ${formatSpeedCompact(data.net.total.txRate)}`;
                } else {
                    text = `↓ ${formatSpeedCompact(data.net.total.rxRate)}`;
                }
            }
            else if (key === 'thermal' && data.thm)
                text = thermalUnavailable(data.thm) ? 'n/a' : formatTemp(data.thm.packageTemp, tempUnit);
            else if (key === 'gpu' && data.gpu) text = data.gpu.present ? `${Math.round(data.gpu.percent)}%` : 'n/a';

            if (widget.label.text !== text) widget.label.text = text;

            let warn = false;
            if (key === 'cpu' && data.cpu && data.cpu.total >= cpuWarn) warn = true;
            if (key === 'memory' && data.mem && data.mem.percent >= memWarn) warn = true;
            if (key === 'thermal' && data.thm && data.thm.packageTemp >= tempWarn) warn = true;
            if (key === 'gpu' && data.gpu?.present && data.gpu.percent >= this._settings.get_int('threshold-gpu')) warn = true;
            if (key === 'disk' && data.dsk?.mounts?.[0]?.percent >= this._settings.get_int('threshold-disk')) warn = true;
            if (warn) widget.label.add_style_class_name('resource-pulse-label-warn');
            else widget.label.remove_style_class_name('resource-pulse-label-warn');
        });
        // A value that grew wider changes what the panel is asked for
        // without changing what it is given, so no signal reports it.
        this._fitTopBar();
    }
}
