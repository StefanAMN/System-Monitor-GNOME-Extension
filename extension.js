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
import { runSubprocess } from './lib/utils.js';

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

// ─── Custom Cairo Widgets ─────────────────────────────────────────────────────

const ResizeHandle = GObject.registerClass({
    GTypeName: 'ResourcePulseResizeHandle',
}, class ResizeHandle extends St.DrawingArea {
    _init(corner = 'se', size = 32, cursor = Clutter.CursorType.DEFAULT) {
        super._init({
            style_class: `resource-pulse-resize-handle resource-pulse-resize-handle-${corner}`,
            reactive: true,
            track_hover: true,
            can_focus: false,
            width: size,
            height: size
        });
        this.set_cursor_type(cursor);
        this._corner = corner;
        this._hovered = false;
        this._active = false;

        // Set pivot point to corner apex: (1.0, 1.0) for SE, (0.0, 1.0) for SW
        const pivotX = corner === 'se' ? 1.0 : 0.0;
        const pivotY = 1.0;
        this.set_pivot_point(pivotX, pivotY);

        this.connect('notify::hover', () => {
            this._hovered = this.hover;
            this.remove_all_transitions();
            if (!this.get_stage() || !this.is_mapped()) return;
            if (this._hovered && !this._active) {
                this.ease({
                    scale_x: 1.15,
                    scale_y: 1.15,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });
            } else if (!this._active) {
                this.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            this.queue_repaint();
        });
        this.connect('repaint', this._draw.bind(this));
    }

    setActive(active) {
        if (this._active !== active) {
            this._active = active;
            this.remove_all_transitions();
            if (active) {
                this.ease({
                    scale_x: 1.25,
                    scale_y: 1.25,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                });
            } else {
                this.ease({
                    scale_x: this._hovered ? 1.15 : 1.0,
                    scale_y: this._hovered ? 1.15 : 1.0,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });
            }
            if (this.is_mapped()) this.queue_repaint();
        }
    }

    _draw(area) {
        // No static resize icon! The corner only illuminates when hovered or active.
        if (!this._hovered && !this._active) return;

        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();

        const cornerX = this._corner === 'se' ? w : 0;
        const cornerY = h;
        const radius = Math.max(w, h);

        // Radiant radial corner illumination
        const glow = new Cairo.RadialGradient(cornerX, cornerY, 0, cornerX, cornerY, radius);
        if (this._active) {
            glow.addColorStopRGBA(0.0, 0.208, 0.518, 0.894, 0.65);
            glow.addColorStopRGBA(0.5, 0.208, 0.518, 0.894, 0.28);
            glow.addColorStopRGBA(1.0, 0.208, 0.518, 0.894, 0.0);
        } else {
            glow.addColorStopRGBA(0.0, 0.208, 0.518, 0.894, 0.40);
            glow.addColorStopRGBA(0.5, 0.208, 0.518, 0.894, 0.15);
            glow.addColorStopRGBA(1.0, 0.208, 0.518, 0.894, 0.0);
        }

        cr.setSource(glow);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // Sleek corner accent highlight arc matching the panel corner radius
        cr.setLineWidth(2.5);
        cr.setLineCap(Cairo.LineCap.ROUND);
        if (this._active) {
            cr.setSourceRGBA(0.40, 0.70, 1.0, 0.95);
        } else {
            cr.setSourceRGBA(0.40, 0.70, 1.0, 0.70);
        }

        const arcRadius = 14;
        if (this._corner === 'se') {
            cr.arc(w - arcRadius, h - arcRadius, arcRadius - 1, 0, Math.PI / 2);
        } else {
            cr.arc(arcRadius, h - arcRadius, arcRadius - 1, Math.PI / 2, Math.PI);
        }
        cr.stroke();

        cr.restore();
    }
});

const Sparkline = GObject.registerClass({
    GTypeName: 'ResourcePulseSparkline',
}, class Sparkline extends St.DrawingArea {
    _init(width = -1, height = 100, maxVal = 100, autoScale = false, options = {}) {
        const initParams = {
            style_class: 'resource-pulse-sparkline',
            x_expand: true,
            height: height
        };
        if (width > 0) initParams.width = width;
        super._init(initParams);
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
        this.connect('notify::mapped', () => {
            if (this.is_mapped()) this.queue_repaint();
        });
    }

    addSample(val) {
        this.history.push(val);
        if (this.history.length > 60) this.history.shift();
        if (this.is_mapped()) this.queue_repaint();
    }

    setScaleLabel(label) {
        if (this.scaleLabel !== label) {
            this.scaleLabel = label;
            if (this.is_mapped()) this.queue_repaint();
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
        this.connect('notify::mapped', () => {
            if (this.is_mapped()) this.queue_repaint();
        });
    }
    setColor(r, g, b) {
        if (this.r !== r || this.g !== g || this.b !== b) {
            this.r = r; this.g = g; this.b = b;
            if (this.is_mapped()) this.queue_repaint();
        }
    }
    setPercent(pct) {
        pct = Math.max(0, Math.min(100, pct));
        if (this.pct !== pct) {
            this.pct = pct;
            if (this.is_mapped()) this.queue_repaint();
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

        // Tooltip state
        this._tooltip = null;
        this._tooltipTexts = {};

        // Panel indicator
        this._indicator = new PanelMenu.Button(0.0, 'Resource Pulse', false);
        this._indicatorBox = new St.BoxLayout({ style_class: 'resource-pulse-indicator-box' });
        this._indicator.add_child(this._indicatorBox);
        this._topBarWidgets = {};
        this._stageReleaseId = null;

        // Dropdown container
        this._menuSection = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false });
        
        this._popupStack = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true
        });

        this._scrollView = new St.ScrollView({
            style_class: 'resource-pulse-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true
        });

        this._menuContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-menu-section',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_expand: true
        });

        // Keyboard navigation inside dropdown menu
        this._menuContainer.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_BackSpace) {
                if (this._activeTab !== 'overview') {
                    this._activeTab = (this._activeTab === 'settings' && this._previousTab) ? this._previousTab : 'overview';
                    this._updateTabVisibility();
                    return Clutter.EVENT_STOP;
                }
            }
            if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
                const tabs = ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu'];
                if (this._activeTab !== 'overview' && this._activeTab !== 'settings') {
                    let idx = tabs.indexOf(this._activeTab);
                    if (idx !== -1) {
                        idx = symbol === Clutter.KEY_Right
                            ? (idx + 1) % tabs.length
                            : (idx - 1 + tabs.length) % tabs.length;
                        this._activeTab = tabs[idx];
                        this._updateTabVisibility();
                        return Clutter.EVENT_STOP;
                    }
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._scrollView.add_child(this._menuContainer);
        this._popupStack.add_child(this._scrollView);

        // Build Corner Resize Handles
        this._buildCornerResizeHandles();

        this._menuSection.add_child(this._popupStack);
        this._indicator.menu.box.add_style_class_name('resource-pulse-popup');
        this._indicator.menu.addMenuItem(this._menuSection);

        // Build UI
        this._activeTab = 'overview';
        this._coreWidgets = null;
        this._procWidgets = [];
        this._buildOverview();
        this._buildDetails();
        this._buildSettingsPage();
        this._updateTabVisibility();
        this._updateMenuDimensions();

        // Track menu open
        this._menuOpen = false;
        this._openStateId = this._indicator.menu.connect('open-state-changed', (menu, open) => {
            this._menuOpen = open;
            if (open) {
                this._updateMenuDimensions();
                this._hideTooltip();
                this._poll();
            } else {
                if (this._stageReleaseId) {
                    global.stage.disconnect(this._stageReleaseId);
                    this._stageReleaseId = null;
                }
                if (this._dragGrab) {
                    this._dragGrab.dismiss();
                    this._dragGrab = null;
                }
                if (this._cardDragGrab) {
                    this._cardDragGrab.dismiss();
                    this._cardDragGrab = null;
                }
                if (this._dragHoldTimerId) {
                    GLib.source_remove(this._dragHoldTimerId);
                    this._dragHoldTimerId = null;
                }
                if (this._activeCardDrag && this._draggedCardActor) {
                    this._draggedCardActor.remove_style_class_name('resource-pulse-metric-card-dragging');
                    this._draggedCardActor.remove_style_class_name('resource-pulse-metric-card-snapping');
                    this._draggedCardActor.remove_all_transitions();
                    this._draggedCardActor.set_translation(0, 0, 0);
                    this._draggedCardActor.set_scale(1.0, 1.0);
                }
                if (this._summaryCards) {
                    for (const k of Object.keys(this._summaryCards)) {
                        const b = this._summaryCards[k]?.box;
                        if (b) {
                            b.remove_style_class_name('resource-pulse-metric-card-dragging');
                            b.remove_style_class_name('resource-pulse-metric-card-snapping');
                            b.remove_all_transitions();
                            b.set_translation(0, 0, 0);
                            b.set_scale(1.0, 1.0);
                        }
                    }
                }
                this._pendingPreviewOrder = null;
                this._previewTargetIndex = null;
                this._activeCardDrag = null;
                this._draggedCardActor = null;
            }
        });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._updateMenuDimensions());

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Settings listeners
        this._pinnedId = this._settings.connect('changed::pinned-metrics', () => this._rebuildTopBar());
        this._cardOrderId = this._settings.connect('changed::overview-card-order', () => this._onCardOrderChanged());
        this._compactId = this._settings.connect('changed::compact-label', () => this._rebuildTopBar());
        this._batFmtId = this._settings.connect('changed::battery-top-format', () => this._poll());
        this._netFmtId = this._settings.connect('changed::network-top-format', () => this._poll());
        this._tooltipsId = this._settings.connect('changed::show-tooltips', () => this._hideTooltip());
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
        // Initial poll
        this._startPolling();
    }

    disable() {
        if (this._pinnedId) this._settings.disconnect(this._pinnedId);
        if (this._cardOrderId) this._settings.disconnect(this._cardOrderId);
        if (this._compactId) this._settings.disconnect(this._compactId);
        if (this._batFmtId) this._settings.disconnect(this._batFmtId);
        if (this._netFmtId) this._settings.disconnect(this._netFmtId);
        if (this._tooltipsId) this._settings.disconnect(this._tooltipsId);
        if (this._pollId) this._settings.disconnect(this._pollId);
        if (this._openMenuId) this._settings.disconnect(this._openMenuId);

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._openStateId) this._indicator.menu.disconnect(this._openStateId);
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._tooltipIdleId) {
            GLib.source_remove(this._tooltipIdleId);
            this._tooltipIdleId = null;
        }

        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }

        if (this._stageReleaseId) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = null;
        }

        if (this._dragGrab) {
            this._dragGrab.dismiss();
            this._dragGrab = null;
        }
        if (this._cardDragGrab) {
            this._cardDragGrab.dismiss();
            this._cardDragGrab = null;
        }
        if (this._dragHoldTimerId) {
            GLib.source_remove(this._dragHoldTimerId);
            this._dragHoldTimerId = null;
        }
        if (this._settingsPage) {
            this._settingsPage.destroy();
            this._settingsPage = null;
        }
        this._resizeHandles = {};

        this._indicator.destroy();
        this._indicator = null;
        this._indicatorBox = null;
        this._topBarWidgets = {};
        this._tooltipTexts = {};
        this._settings = null;
        this._overviewPage = null;
        this._overviewGrid = null;
        this._overviewGridLayout = null;
        this._cardOrder = null;
        this._activeCardDrag = null;
        this._draggedCardActor = null;
        this._pendingPreviewOrder = null;
        this._previewTargetIndex = null;
        this._detailArea = null;
        this._detailSections = null;
        this._summaryCards = null;
        this._popupStack = null;
        this._menuContainer = null;
        this._scrollView = null;
        this._menuSection = null;
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

    _hasKey(key) {
        return !!(this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key(key));
    }

    _getStrv(key, fallback = []) {
        return this._hasKey(key) ? this._settings.get_strv(key) : fallback;
    }

    _getString(key, fallback = '') {
        return this._hasKey(key) ? this._settings.get_string(key) : fallback;
    }

    _getInt(key, fallback = 0) {
        return this._hasKey(key) ? this._settings.get_int(key) : fallback;
    }

    _getBoolean(key, fallback = false) {
        return this._hasKey(key) ? this._settings.get_boolean(key) : fallback;
    }

    _showTooltip(actor, text) {
        if (!this._getBoolean('show-tooltips', true) || (this._indicator && this._indicator.menu.isOpen) || !text) {
            this._hideTooltip();
            return;
        }
        if (!this._tooltip) {
            this._tooltip = new St.Label({
                style: 'background-color: rgba(30, 30, 30, 0.95); border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; padding: 6px 10px; font-size: 0.82em; color: #ffffff; font-weight: 500; line-height: 1.3;',
                visible: false
            });
            Main.layoutManager.uiGroup.add_child(this._tooltip);
        }
        this._tooltip.text = text;
        this._tooltip.visible = true;
        this._tooltip.opacity = 0;

        if (this._tooltipIdleId) {
            GLib.source_remove(this._tooltipIdleId);
            this._tooltipIdleId = null;
        }

        this._tooltipIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._tooltipIdleId = null;
            if (!this._tooltip || !actor || !actor.get_stage()) return GLib.SOURCE_REMOVE;
            const [stageX, stageY] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            const tooltipW = this._tooltip.get_width() || 120;

            let targetX = Math.round(stageX + (w / 2) - (tooltipW / 2));
            const screenW = global.stage?.width || global.screen_width || 1920;
            targetX = Math.max(10, Math.min(screenW - tooltipW - 10, targetX));
            const targetY = Math.round(stageY + h + 6);

            this._tooltip.set_position(targetX, targetY);
            this._tooltip.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideTooltip() {
        if (this._tooltipIdleId) {
            GLib.source_remove(this._tooltipIdleId);
            this._tooltipIdleId = null;
        }
        if (this._tooltip && this._tooltip.visible) {
            this._tooltip.ease({
                opacity: 0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._tooltip) this._tooltip.visible = false;
                }
            });
        }
    }

    _updateMenuDimensions() {
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.currentMonitor || { width: 1920, height: 1080 };
        const screenW = monitor.width || (global.screen_width || 1920);
        const screenH = monitor.height || (global.screen_height || 1080);

        const savedW = this._settings?.get_int('menu-custom-width') || 0;
        const savedH = this._settings?.get_int('menu-custom-height') || 0;

        const defaultWidth = Math.min(Math.max(380, Math.round(screenW * 0.28)), 600);
        const defaultMaxHeight = Math.max(380, Math.round(screenH * 0.80));
        this._defaultMaxHeight = defaultMaxHeight;

        if (savedW > 0 && savedH > 0) {
            const minW = 360;
            const maxW = Math.min(Math.round(screenW * 0.90), 1200);
            const minH = 320;
            const maxH = Math.min(Math.round(screenH * 0.90), screenH - 60);
            const w = Math.max(minW, Math.min(maxW, savedW));
            const h = Math.max(minH, Math.min(maxH, savedH));
            this._applyDimensions(w, h);
        } else {
            this._currentWidth = defaultWidth;
            this._currentHeight = 0;
            if (this._menuContainer) {
                this._menuContainer.width = defaultWidth;
                this._menuContainer.height = -1;
                this._menuContainer.style = `width: ${defaultWidth}px; min-width: ${defaultWidth}px; max-width: ${defaultWidth}px;`;
            }
            if (this._scrollView) {
                this._scrollView.width = defaultWidth;
                this._scrollView.height = -1;
                this._scrollView.style = `width: ${defaultWidth}px; max-height: ${defaultMaxHeight}px;`;
            }
            if (this._popupStack) {
                this._popupStack.width = defaultWidth;
                this._popupStack.height = -1;
                this._popupStack.style = `width: ${defaultWidth}px;`;
            }
            if (this._menuSection) {
                this._menuSection.width = defaultWidth;
                this._menuSection.height = -1;
                this._menuSection.style = `width: ${defaultWidth}px;`;
            }
            if (this._settingsDimensionsLabel) {
                this._settingsDimensionsLabel.text = `Auto Dynamic: ${defaultWidth} × auto px`;
            }
        }
    }

    _applyResizeDelta(corner, deltaX, deltaY, startW, startH) {
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.currentMonitor || { width: 1920, height: 1080 };
        const screenW = monitor.width || (global.screen_width || 1920);
        const screenH = monitor.height || (global.screen_height || 1080);
        const minW = 360;
        const maxW = Math.min(Math.round(screenW * 0.90), 1200);
        const minH = 320;
        const maxH = Math.min(Math.round(screenH * 0.90), screenH - 60);

        let newW = startW;
        let newH = startH;

        if (corner === 'se') {
            newW = startW + deltaX;
            newH = startH + deltaY;
        } else if (corner === 'sw') {
            newW = startW - deltaX;
            newH = startH + deltaY;
        }

        newW = Math.max(minW, Math.min(maxW, Math.round(newW)));
        newH = Math.max(minH, Math.min(maxH, Math.round(newH)));

        this._applyDimensions(newW, newH);
    }

    _applyDimensions(w, h) {
        this._currentWidth = w;
        this._currentHeight = h;
        if (this._menuContainer) {
            this._menuContainer.width = w;
            this._menuContainer.style = `width: ${w}px; min-width: ${w}px; max-width: ${w}px; min-height: ${h}px;`;
        }
        if (this._scrollView) {
            this._scrollView.width = w;
            this._scrollView.height = h;
            this._scrollView.style = `width: ${w}px; height: ${h}px; min-height: ${h}px; max-height: ${h}px;`;
        }
        if (this._popupStack) {
            this._popupStack.width = w;
            this._popupStack.height = h;
            this._popupStack.style = `width: ${w}px; height: ${h}px; min-width: ${w}px; min-height: ${h}px;`;
        }
        if (this._menuSection) {
            this._menuSection.width = w;
            this._menuSection.height = h;
            this._menuSection.style = `width: ${w}px; height: ${h}px; min-width: ${w}px; min-height: ${h}px;`;
        }
        if (this._settingsDimensionsLabel) {
            this._settingsDimensionsLabel.text = `Custom: ${w} × ${h} px (Drag corners to resize)`;
        }
    }

    _saveCustomDimensions() {
        if (this._settings && this._currentWidth > 0 && this._currentHeight > 0) {
            this._settings.set_int('menu-custom-width', this._currentWidth);
            this._settings.set_int('menu-custom-height', this._currentHeight);
        }
    }

    _resetMenuDimensions() {
        if (this._settings) {
            this._settings.set_int('menu-custom-width', 0);
            this._settings.set_int('menu-custom-height', 0);
        }
        this._updateMenuDimensions();
    }

    _buildCornerResizeHandles() {
        this._resizeHandles = {};
        const corners = [
            { id: 'se', xAlign: Clutter.ActorAlign.END,   yAlign: Clutter.ActorAlign.END, cursor: Clutter.CursorType.NWSE_RESIZE, size: 32 },
            { id: 'sw', xAlign: Clutter.ActorAlign.START, yAlign: Clutter.ActorAlign.END, cursor: Clutter.CursorType.NESW_RESIZE, size: 32 }
        ];

        corners.forEach(c => {
            const handle = new ResizeHandle(c.id, c.size, c.cursor);
            handle.x_align = c.xAlign;
            handle.y_align = c.yAlign;
            handle.x_expand = true;
            handle.y_expand = true;

            let isDragging = false;
            let startX = 0, startY = 0;
            let startWidth = 0, startHeight = 0;
            let lastClickTime = 0;

            const startDrag = (event) => {
                const now = event.get_time();
                if (now - lastClickTime < 350) {
                    handle.remove_all_transitions();
                    handle.ease({
                        scale_x: 0.85,
                        scale_y: 0.85,
                        duration: 90,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            handle.ease({
                                scale_x: 1.0,
                                scale_y: 1.0,
                                duration: 250,
                                mode: Clutter.AnimationMode.EASE_OUT_BACK
                            });
                        }
                    });
                    this._resetMenuDimensions();
                    lastClickTime = 0;
                    return Clutter.EVENT_STOP;
                }
                lastClickTime = now;

                const [x, y] = event.get_coords();
                startX = x;
                startY = y;

                // Safely read real rendered allocation size
                let curW = (this._currentWidth && this._currentWidth > 100) ? this._currentWidth : 0;
                let curH = (this._currentHeight && this._currentHeight > 100) ? this._currentHeight : 0;

                if (!curW || !curH) {
                    if (this._menuSection && this._menuSection.has_allocation()) {
                        const box = this._menuSection.get_allocation_box();
                        if (box) {
                            if (!curW && box.get_width() > 100) curW = box.get_width();
                            if (!curH && box.get_height() > 100) curH = box.get_height();
                        }
                    }
                    if (!curW || !curH) {
                        if (this._scrollView && this._scrollView.has_allocation()) {
                            const box = this._scrollView.get_allocation_box();
                            if (box) {
                                if (!curW && box.get_width() > 100) curW = box.get_width();
                                if (!curH && box.get_height() > 100) curH = box.get_height();
                            }
                        }
                    }
                    if (!curW || !curH) {
                        if (this._menuContainer && this._menuContainer.has_allocation()) {
                            const box = this._menuContainer.get_allocation_box();
                            if (box) {
                                if (!curW && box.get_width() > 100) curW = box.get_width();
                                if (!curH && box.get_height() > 100) curH = box.get_height();
                            }
                        }
                    }
                }
                if (!curW) curW = 420;
                if (!curH) curH = 500;

                startWidth = Math.round(curW);
                startHeight = Math.round(curH);

                isDragging = true;
                this._activeResizeCorner = c.id;
                this._dragGrab = global.stage.grab(handle);
                handle.setActive(true);
                return Clutter.EVENT_STOP;
            };

            handle.connect('button-press-event', (actor, event) => {
                if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                return startDrag(event);
            });

            handle.connect('touch-event', (actor, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                    return startDrag(event);
                }
                return Clutter.EVENT_PROPAGATE;
            });

            const finishDrag = () => {
                if (!isDragging) return Clutter.EVENT_PROPAGATE;
                if (this._dragGrab) {
                    this._dragGrab.dismiss();
                    this._dragGrab = null;
                }
                isDragging = false;
                this._activeResizeCorner = null;
                handle.setActive(false);
                this._saveCustomDimensions();
                return Clutter.EVENT_STOP;
            };

            handle.connect('button-release-event', finishDrag);

            handle.connect('event', (actor, event) => {
                if (!isDragging) return Clutter.EVENT_PROPAGATE;
                const type = event.type();
                if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                    const [currX, currY] = event.get_coords();
                    const deltaX = currX - startX;
                    const deltaY = currY - startY;
                    this._applyResizeDelta(c.id, deltaX, deltaY, startWidth, startHeight);
                    return Clutter.EVENT_STOP;
                } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                    return finishDrag();
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._resizeHandles[c.id] = handle;
            this._popupStack.add_child(handle);
        });
    }

    _openSettingsView() {
        if (this._activeTab === 'settings') {
            this._activeTab = this._previousTab || 'overview';
        } else {
            this._previousTab = this._activeTab;
            this._activeTab = 'settings';
        }
        this._refreshSettingsUI();
        this._updateTabVisibility();
    }

    _buildSettingsPage() {
        this._settingsPage = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-settings-page',
            x_expand: true,
            y_expand: true,
            visible: false
        });

        // 1. Header
        const header = new St.BoxLayout({ style: 'spacing: 8px; margin-bottom: 14px;', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        const backBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 99px; padding: 6px;', reactive: true });
        const backIcon = new St.Icon({ icon_name: 'go-previous-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        backBtn.add_child(backIcon);
        backBtn.connect('clicked', () => {
            this._activeTab = this._previousTab || 'overview';
            this._updateTabVisibility();
        });
        this._addClickAnimations(backBtn);
        header.add_child(backBtn);

        const titleBox = new St.BoxLayout({ style: 'spacing: 8px;', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titleBox.add_child(new St.Icon({ icon_name: 'preferences-system-symbolic', style: 'icon-size: 18px; color: #3584e4;' }));
        titleBox.add_child(new St.Label({ text: 'Settings & Preferences', style: 'font-size: 1.1em; font-weight: bold; color: #ffffff;' }));
        header.add_child(titleBox);
        this._settingsPage.add_child(header);

        // 2. Card: Pinned Top Bar Metrics
        const pinCard = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-settings-card' });
        pinCard.add_child(new St.Label({ text: 'PINNED TOP BAR METRICS', style_class: 'resource-pulse-settings-card-title' }));
        pinCard.add_child(new St.Label({ text: 'Choose which metrics display in the GNOME top bar', style: 'font-size: 0.75em; color: #8c8c94; margin-bottom: 10px;' }));

        this._pinButtons = {};
        const availableMetrics = [
            { key: 'cpu', label: 'CPU Usage' },
            { key: 'memory', label: 'Memory' },
            { key: 'battery', label: 'Battery' },
            { key: 'power', label: 'Power Draw' },
            { key: 'disk', label: 'Disk Space' },
            { key: 'network', label: 'Network' },
            { key: 'thermal', label: 'Thermal' },
            { key: 'gpu', label: 'GPU' }
        ];

        const pinGrid = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        const pinGridWidget = new St.Widget({ layout_manager: pinGrid, x_expand: true });

        availableMetrics.forEach((m, idx) => {
            const btn = new St.Button({
                style_class: 'resource-pulse-toggle-btn',
                reactive: true,
                can_focus: true,
                x_expand: true,
                margin_right: 4,
                margin_bottom: 6
            });
            const bBox = new St.BoxLayout({ style: 'spacing: 6px;', y_align: Clutter.ActorAlign.CENTER });
            const bIcon = new St.Icon({ icon_name: this._getIconName(m.key), style: 'icon-size: 14px;' });
            const bLbl = new St.Label({ text: m.label, style: 'font-size: 0.85em;' });
            bBox.add_child(bIcon);
            bBox.add_child(bLbl);
            btn.add_child(bBox);

            btn.connect('clicked', () => {
                let current = this._settings.get_strv('pinned-metrics');
                if (current.includes(m.key)) {
                    current = current.filter(k => k !== m.key);
                } else {
                    current.push(m.key);
                }
                this._settings.set_strv('pinned-metrics', current);
                this._updatePinButtonState(m.key, current.includes(m.key));
            });
            this._addClickAnimations(btn);

            pinGrid.attach(btn, idx % 2, Math.floor(idx / 2), 1, 1);
            this._pinButtons[m.key] = btn;
        });

        pinCard.add_child(pinGridWidget);
        this._settingsPage.add_child(pinCard);

        // 3. Card: General Settings
        const genCard = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-settings-card' });
        genCard.add_child(new St.Label({ text: 'GENERAL OPTIONS', style_class: 'resource-pulse-settings-card-title' }));

        // 3.1 Poll Interval Row
        const pollRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const pollInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        pollInfo.add_child(new St.Label({ text: 'Update Interval', style_class: 'resource-pulse-setting-label' }));
        pollInfo.add_child(new St.Label({ text: 'Frequency of data sampling (1 to 10 seconds)', style_class: 'resource-pulse-setting-desc' }));
        pollRow.add_child(pollInfo);

        const pollControls = new St.BoxLayout({ style: 'spacing: 6px;', y_align: Clutter.ActorAlign.CENTER });
        const pollDecBtn = new St.Button({ label: '−', style_class: 'resource-pulse-stepper-btn', reactive: true });
        this._pollValLabel = new St.Label({ text: '2s', style: 'font-size: 0.9em; font-weight: bold; min-width: 32px; text-align: center;' });
        const pollIncBtn = new St.Button({ label: '+', style_class: 'resource-pulse-stepper-btn', reactive: true });
        
        pollDecBtn.connect('clicked', () => {
            const cur = this._settings.get_int('poll-interval') || 2;
            if (cur > 1) {
                this._settings.set_int('poll-interval', cur - 1);
                this._pollValLabel.text = `${cur - 1}s`;
            }
        });
        pollIncBtn.connect('clicked', () => {
            const cur = this._settings.get_int('poll-interval') || 2;
            if (cur < 10) {
                this._settings.set_int('poll-interval', cur + 1);
                this._pollValLabel.text = `${cur + 1}s`;
            }
        });
        pollControls.add_child(pollDecBtn);
        pollControls.add_child(this._pollValLabel);
        pollControls.add_child(pollIncBtn);
        pollRow.add_child(pollControls);
        genCard.add_child(pollRow);

        // 3.2 Compact Mode Row
        const compactRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const compactInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        compactInfo.add_child(new St.Label({ text: 'Compact Top Bar Mode', style_class: 'resource-pulse-setting-label' }));
        compactInfo.add_child(new St.Label({ text: 'Show icons only, hiding text labels', style_class: 'resource-pulse-setting-desc' }));
        compactRow.add_child(compactInfo);

        this._compactBtn = new St.Button({ style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._compactBtn.connect('clicked', () => {
            const val = !this._settings.get_boolean('compact-label');
            this._settings.set_boolean('compact-label', val);
            this._updateToggleBtn(this._compactBtn, val);
        });
        compactRow.add_child(this._compactBtn);
        genCard.add_child(compactRow);

        // 3.3 Hover Tooltips Row
        const tooltipRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const tooltipInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        tooltipInfo.add_child(new St.Label({ text: 'Hover Tooltips', style_class: 'resource-pulse-setting-label' }));
        tooltipInfo.add_child(new St.Label({ text: 'Show rich overlays on top bar hover', style_class: 'resource-pulse-setting-desc' }));
        tooltipRow.add_child(tooltipInfo);

        this._tooltipBtn = new St.Button({ style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._tooltipBtn.connect('clicked', () => {
            const val = !this._settings.get_boolean('show-tooltips');
            this._settings.set_boolean('show-tooltips', val);
            this._updateToggleBtn(this._tooltipBtn, val);
        });
        tooltipRow.add_child(this._tooltipBtn);
        genCard.add_child(tooltipRow);

        // 3.4 Temperature Unit Row
        const tempRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const tempInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        tempInfo.add_child(new St.Label({ text: 'Temperature Unit', style_class: 'resource-pulse-setting-label' }));
        tempRow.add_child(tempInfo);

        const tempBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this._tempCBtn = new St.Button({ label: '°C', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._tempFBtn = new St.Button({ label: '°F', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._tempCBtn.connect('clicked', () => {
            this._settings.set_string('unit-temp', 'C');
            this._refreshSettingsUI();
        });
        this._tempFBtn.connect('clicked', () => {
            this._settings.set_string('unit-temp', 'F');
            this._refreshSettingsUI();
        });
        tempBox.add_child(this._tempCBtn);
        tempBox.add_child(this._tempFBtn);
        tempRow.add_child(tempBox);
        genCard.add_child(tempRow);

        // 3.5 Memory Unit Row
        const memRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const memInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        memInfo.add_child(new St.Label({ text: 'Memory Unit', style_class: 'resource-pulse-setting-label' }));
        memRow.add_child(memInfo);

        const memBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this._memGbBtn = new St.Button({ label: 'GB', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._memGibBtn = new St.Button({ label: 'GiB', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._memGbBtn.connect('clicked', () => {
            this._settings.set_string('unit-mem', 'GB');
            this._refreshSettingsUI();
        });
        this._memGibBtn.connect('clicked', () => {
            this._settings.set_string('unit-mem', 'GiB');
            this._refreshSettingsUI();
        });
        memBox.add_child(this._memGbBtn);
        memBox.add_child(this._memGibBtn);
        memRow.add_child(memBox);
        genCard.add_child(memRow);

        // 3.6 Battery Format Row
        const batRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const batInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        batInfo.add_child(new St.Label({ text: 'Battery Top Bar Format', style_class: 'resource-pulse-setting-label' }));
        batRow.add_child(batInfo);

        const batBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this._batPctBtn = new St.Button({ label: '% Only', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._batTimeBtn = new St.Button({ label: '% + Time', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._batPctBtn.connect('clicked', () => {
            this._settings.set_string('battery-top-format', 'percent');
            this._refreshSettingsUI();
        });
        this._batTimeBtn.connect('clicked', () => {
            this._settings.set_string('battery-top-format', 'percent-time');
            this._refreshSettingsUI();
        });
        batBox.add_child(this._batPctBtn);
        batBox.add_child(this._batTimeBtn);
        batRow.add_child(batBox);
        genCard.add_child(batRow);

        // 3.7 Network Format Row
        const netRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const netInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        netInfo.add_child(new St.Label({ text: 'Network Top Bar Format', style_class: 'resource-pulse-setting-label' }));
        netRow.add_child(netInfo);

        const netBox = new St.BoxLayout({ style: 'spacing: 4px;' });
        this._netDownBtn = new St.Button({ label: '↓ Down', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._netUpBtn = new St.Button({ label: '↑ Up', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._netBothBtn = new St.Button({ label: '↓↑ Both', style_class: 'resource-pulse-toggle-btn', reactive: true });
        this._netDownBtn.connect('clicked', () => {
            this._settings.set_string('network-top-format', 'download');
            this._refreshSettingsUI();
        });
        this._netUpBtn.connect('clicked', () => {
            this._settings.set_string('network-top-format', 'upload');
            this._refreshSettingsUI();
        });
        this._netBothBtn.connect('clicked', () => {
            this._settings.set_string('network-top-format', 'both');
            this._refreshSettingsUI();
        });
        netBox.add_child(this._netDownBtn);
        netBox.add_child(this._netUpBtn);
        netBox.add_child(this._netBothBtn);
        netRow.add_child(netBox);
        genCard.add_child(netRow);

        this._settingsPage.add_child(genCard);

        // 4. Card: Warning Thresholds
        const alertCard = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-settings-card' });
        alertCard.add_child(new St.Label({ text: 'ALERT THRESHOLDS', style_class: 'resource-pulse-settings-card-title' }));
        alertCard.add_child(new St.Label({ text: 'Values exceeding threshold will display in warning colors', style: 'font-size: 0.75em; color: #8c8c94; margin-bottom: 8px;' }));

        // 4.1 CPU Threshold
        const cpuThreshRow = this._buildStepperRow('CPU Alert Threshold', 50, 100, 5, 'threshold-cpu', '%');
        this._cpuThreshLbl = cpuThreshRow.valLbl;
        alertCard.add_child(cpuThreshRow.row);

        // 4.2 Mem Threshold
        const memThreshRow = this._buildStepperRow('Memory Alert Threshold', 50, 100, 5, 'threshold-mem', '%');
        this._memThreshLbl = memThreshRow.valLbl;
        alertCard.add_child(memThreshRow.row);

        // 4.3 Temp Threshold
        const tempThreshRow = this._buildStepperRow('Temperature Alert Threshold', 40, 100, 5, 'threshold-temp', '°C');
        this._tempThreshLbl = tempThreshRow.valLbl;
        alertCard.add_child(tempThreshRow.row);

        this._settingsPage.add_child(alertCard);

        // 5. Card: Permissions & System Troubleshooting
        const permCard = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-settings-card' });
        permCard.add_child(new St.Label({ text: 'PERMISSIONS & TROUBLESHOOTING', style_class: 'resource-pulse-settings-card-title' }));

        const permRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const permInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        permInfo.add_child(new St.Label({ text: 'Enable CPU Power Monitoring', style_class: 'resource-pulse-setting-label' }));
        permInfo.add_child(new St.Label({ text: 'Fixes 0W reading by granting read permission to RAPL sensors (Requires Admin)', style_class: 'resource-pulse-setting-desc' }));
        this._settingsPowerFixStatus = new St.Label({ text: '', style_class: 'resource-pulse-status-label', visible: false });
        this._settingsPowerFixStatus.style = 'margin-top: 4px;';
        permInfo.add_child(this._settingsPowerFixStatus);
        permRow.add_child(permInfo);

        this._powerFixBtn = new St.Button({ label: 'Fix Permissions', style_class: 'resource-pulse-action-btn', reactive: true });
        this._powerFixBtn.connect('clicked', () => {
            this._runPowerFix(this._settingsPowerFixStatus, this._powerFixBtn);
        });
        permRow.add_child(this._powerFixBtn);
        permCard.add_child(permRow);
        this._settingsPage.add_child(permCard);

        // 6. Card: Window Sizing & Reset
        const sizeCard = new St.BoxLayout({ vertical: true, style_class: 'resource-pulse-settings-card' });
        sizeCard.add_child(new St.Label({ text: 'PANEL RESIZING', style_class: 'resource-pulse-settings-card-title' }));

        const sizeRow = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const sizeInfo = new St.BoxLayout({ vertical: true, x_expand: true });
        sizeInfo.add_child(new St.Label({ text: 'Window Dimensions', style_class: 'resource-pulse-setting-label' }));
        this._settingsDimensionsLabel = new St.Label({ text: 'Drag any corner to resize the panel', style_class: 'resource-pulse-setting-desc' });
        sizeInfo.add_child(this._settingsDimensionsLabel);
        sizeRow.add_child(sizeInfo);

        const resetSizeBtn = new St.Button({ label: 'Reset Size', style_class: 'resource-pulse-action-btn', reactive: true });
        resetSizeBtn.connect('clicked', () => {
            this._resetMenuDimensions();
        });
        sizeRow.add_child(resetSizeBtn);
        sizeCard.add_child(sizeRow);
        this._settingsPage.add_child(sizeCard);

        this._menuContainer.add_child(this._settingsPage);
    }

    _buildStepperRow(labelText, min, max, step, settingKey, unitSuffix) {
        const row = new St.BoxLayout({ style_class: 'resource-pulse-setting-row', y_align: Clutter.ActorAlign.CENTER });
        const info = new St.BoxLayout({ vertical: true, x_expand: true });
        info.add_child(new St.Label({ text: labelText, style_class: 'resource-pulse-setting-label' }));
        row.add_child(info);

        const controls = new St.BoxLayout({ style: 'spacing: 6px;', y_align: Clutter.ActorAlign.CENTER });
        const decBtn = new St.Button({ label: '−', style_class: 'resource-pulse-stepper-btn', reactive: true });
        const val = this._settings.get_int(settingKey) || min;
        const valLbl = new St.Label({ text: `${val}${unitSuffix}`, style: 'font-size: 0.9em; font-weight: bold; min-width: 44px; text-align: center;' });
        const incBtn = new St.Button({ label: '+', style_class: 'resource-pulse-stepper-btn', reactive: true });

        decBtn.connect('clicked', () => {
            const cur = this._settings.get_int(settingKey) || min;
            if (cur > min) {
                const next = cur - step;
                this._settings.set_int(settingKey, next);
                valLbl.text = `${next}${unitSuffix}`;
            }
        });
        incBtn.connect('clicked', () => {
            const cur = this._settings.get_int(settingKey) || min;
            if (cur < max) {
                const next = cur + step;
                this._settings.set_int(settingKey, next);
                valLbl.text = `${next}${unitSuffix}`;
            }
        });

        controls.add_child(decBtn);
        controls.add_child(valLbl);
        controls.add_child(incBtn);
        row.add_child(controls);
        return { row, valLbl };
    }

    _updateToggleBtn(btn, active) {
        if (!btn) return;
        btn.label = active ? 'ON' : 'OFF';
        if (active) {
            btn.add_style_class_name('active');
        } else {
            btn.remove_style_class_name('active');
        }
    }

    _updatePinButtonState(key, isPinned) {
        const btn = this._pinButtons?.[key];
        if (!btn) return;
        if (isPinned) {
            btn.add_style_class_name('active');
        } else {
            btn.remove_style_class_name('active');
        }
    }

    _updateChipActive(btn, active) {
        if (!btn) return;
        if (active) {
            btn.add_style_class_name('active');
        } else {
            btn.remove_style_class_name('active');
        }
    }

    _refreshSettingsUI() {
        if (!this._settings || !this._settingsPage) return;

        // Pinned
        const pinned = this._settings.get_strv('pinned-metrics');
        for (const [key, btn] of Object.entries(this._pinButtons || {})) {
            this._updatePinButtonState(key, pinned.includes(key));
        }

        // Poll interval
        if (this._pollValLabel) {
            this._pollValLabel.text = `${this._settings.get_int('poll-interval') || 2}s`;
        }

        // Compact & tooltips
        this._updateToggleBtn(this._compactBtn, this._settings.get_boolean('compact-label'));
        this._updateToggleBtn(this._tooltipBtn, this._settings.get_boolean('show-tooltips'));

        // Temp unit
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        this._updateChipActive(this._tempCBtn, tempUnit === 'C');
        this._updateChipActive(this._tempFBtn, tempUnit === 'F');

        // Mem unit
        const memUnit = this._settings.get_string('unit-mem') || 'GB';
        this._updateChipActive(this._memGbBtn, memUnit === 'GB');
        this._updateChipActive(this._memGibBtn, memUnit === 'GiB');

        // Battery format
        const batFmt = this._settings.get_string('battery-top-format') || 'percent';
        this._updateChipActive(this._batPctBtn, batFmt === 'percent');
        this._updateChipActive(this._batTimeBtn, batFmt === 'percent-time');

        // Network format
        const netFmt = this._settings.get_string('network-top-format') || 'download';
        this._updateChipActive(this._netDownBtn, netFmt === 'download');
        this._updateChipActive(this._netUpBtn, netFmt === 'upload');
        this._updateChipActive(this._netBothBtn, netFmt === 'both');

        // Thresholds
        if (this._cpuThreshLbl) this._cpuThreshLbl.text = `${this._settings.get_int('threshold-cpu')}%`;
        if (this._memThreshLbl) this._memThreshLbl.text = `${this._settings.get_int('threshold-mem')}%`;
        if (this._tempThreshLbl) this._tempThreshLbl.text = `${this._settings.get_int('threshold-temp')}°C`;

        // Dimensions
        const customW = this._settings.get_int('menu-custom-width') || 0;
        const customH = this._settings.get_int('menu-custom-height') || 0;
        if (this._settingsDimensionsLabel) {
            if (customW > 0 && customH > 0) {
                this._settingsDimensionsLabel.text = `Custom Size: ${customW} × ${customH} px (Drag corners to resize)`;
            } else {
                this._settingsDimensionsLabel.text = `Auto Dynamic: ${this._currentWidth || 420} × auto px`;
            }
        }
    }

    _runPowerFix(statusLabel = null, button = null) {
        if (button) button.reactive = false;
        if (statusLabel) {
            statusLabel.text = 'Requesting administrator permission...';
            statusLabel.style = 'color: #3584e4;';
            statusLabel.visible = true;
        }
        try {
            const script = `
echo 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod a+r /sys/class/powercap/%k/energy_uj"' | tee /etc/udev/rules.d/99-powercap-read.rules
udevadm control --reload-rules
udevadm trigger
chmod a+r /sys/class/powercap/intel-rapl*/energy_uj 2>/dev/null || true
`;
            const proc = Gio.Subprocess.new(['pkexec', 'bash', '-c', script], Gio.SubprocessFlags.NONE);
            proc.wait_async(null, (obj, res) => {
                try {
                    obj.wait_finish(res);
                    if (statusLabel) {
                        statusLabel.text = '✓ RAPL permissions successfully updated!';
                        statusLabel.style = 'color: #2ec27e;';
                        statusLabel.visible = true;
                    }
                    if (button) button.reactive = true;
                    this._poll();
                } catch (e) {
                    if (statusLabel) {
                        statusLabel.text = `Failed: ${e.message}`;
                        statusLabel.style = 'color: #e01b24;';
                        statusLabel.visible = true;
                    }
                    if (button) button.reactive = true;
                }
            });
        } catch (e) {
            if (statusLabel) {
                statusLabel.text = `Error: ${e.message}`;
                statusLabel.style = 'color: #e01b24;';
                statusLabel.visible = true;
            }
            if (button) button.reactive = true;
        }
    }

    _launchSystemMonitor() {
        try {
            const apps = ['gnome-system-monitor', 'resources', 'mission-center'];
            for (const appName of apps) {
                const app = Shell.AppSystem.get_default().lookup_app(`${appName}.desktop`);
                if (app) {
                    app.activate();
                    return;
                }
            }
            const context = global.create_app_launch_context(0, -1);
            Gio.AppInfo.create_from_commandline('gnome-system-monitor', null, Gio.AppInfoCreateFlags.NONE).launch([], context);
        } catch (e) {
            console.error(`Failed to launch System Monitor: ${e.message}`);
        }
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
        if (!this._settings || !this._indicator) return;
        try {
            const pinned = this._getStrv('pinned-metrics', ['cpu', 'memory']);
            const isOpen = this._menuOpen;

            const isDetailedCpu = isOpen && this._activeTab === 'cpu';
            const isDetailedMem = isOpen && this._activeTab === 'memory';
            const isDetailedDsk = isOpen && (this._activeTab === 'disk' || this._activeTab === 'overview');
            const isDetailedThm = isOpen && (this._activeTab === 'thermal' || this._activeTab === 'overview');

            const needCpu = isOpen || pinned.includes('cpu');
            const needMem = isOpen || pinned.includes('memory');
            const needBat = isOpen || pinned.includes('battery') || pinned.includes('power');
            const needDsk = isOpen || pinned.includes('disk');
            const needNet = isOpen || pinned.includes('network');
            const needThm = isOpen || pinned.includes('thermal');
            const needGpu = isOpen || pinned.includes('gpu');
            const needPwr = isOpen || pinned.includes('power');

            const [cpu, mem, bat, dsk, net, thm, gpu] = await Promise.all([
                needCpu ? this._cpu.sample(isDetailedCpu) : Promise.resolve(this._lastCpu || { total: 0, cores: [] }),
                needMem ? this._mem.sample() : Promise.resolve(this._lastMem || { percent: 0, total: 0, used: 0 }),
                needBat ? this._bat.sample() : Promise.resolve(this._lastBat || { present: false }),
                needDsk ? this._dsk.sample(isDetailedDsk) : Promise.resolve(this._lastDsk || { mounts: [], readRate: 0, writeRate: 0 }),
                needNet ? this._net.sample() : Promise.resolve(this._lastNet || { total: { rxRate: 0, txRate: 0 }, interfaces: {} }),
                needThm ? this._thm.sample(isDetailedThm) : Promise.resolve(this._lastThm || { packageTemp: 0, sensors: [], fans: [] }),
                needGpu ? this._gpu.sample() : Promise.resolve(this._lastGpu || { present: false, percent: 0 })
            ]);

            if (!this._settings || !this._indicator) return;

            if (needCpu) this._lastCpu = cpu;
            if (needMem) this._lastMem = mem;
            if (needBat) this._lastBat = bat;
            if (needDsk) this._lastDsk = dsk;
            if (needNet) this._lastNet = net;
            if (needThm) this._lastThm = thm;
            if (needGpu) this._lastGpu = gpu;

            const pwr = needPwr ? await this._pwr.sample(bat) : (this._lastPwr || { raplSupported: false, packagePower: null, systemPower: null });
            if (!this._settings || !this._indicator) return;
            if (needPwr) this._lastPwr = pwr;

            let processes = [];
            if (isOpen && (isDetailedCpu || isDetailedMem)) {
                try {
                    const sortFlag = isDetailedMem ? '--sort=-pmem' : '--sort=-pcpu';
                    const res = await runSubprocess(['ps', '-eo', 'pid,pcpu,pmem,comm', '--no-headers', sortFlag]);
                    if (!this._settings || !this._indicator) return;
                    if (res.success && res.stdout) {
                        const lines = res.stdout.trim().split('\n');
                        for (let i = 0; i < Math.min(lines.length, 8); i++) {
                            const parts = lines[i].trim().split(/\s+/);
                            if (parts.length >= 4) {
                                const pid = parts[0];
                                const cpuPct = parseFloat(parts[1]) || 0;
                                const memPct = parseFloat(parts[2]) || 0;
                                const comm = parts.slice(3).join(' ');
                                if (comm !== 'ps' && comm !== 'sh') {
                                    processes.push({ pid, cpu: cpuPct, mem: memPct, comm });
                                }
                            }
                        }
                        processes = processes.slice(0, 5);
                    }
                } catch (e) {}
            }

            if (!this._settings || !this._indicator) return;

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

            const box = new St.BoxLayout({ reactive: true, track_hover: true });
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

            box.connect('enter-event', () => {
                if (this._tooltipTexts[key]) {
                    this._showTooltip(box, this._tooltipTexts[key]);
                }
            });
            box.connect('leave-event', () => {
                this._hideTooltip();
            });

            this._indicatorBox.add_child(box);
            this._topBarWidgets[key] = { box, label, icon };
        });
    }

    _updateTopBarUI(data) {
        if (!this._settings || !this._indicator) return;
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const useGiB = this._settings.get_string('unit-mem') === 'GiB';
        const cpuWarn = this._settings.get_int('threshold-cpu') || 90;
        const memWarn = this._settings.get_int('threshold-mem') || 90;
        const tempWarn = this._settings.get_int('threshold-temp') || 80;
        const batFmt = this._settings.get_string('battery-top-format') || 'percent';
        const netFmt = this._settings.get_string('network-top-format') || 'download';

        // 1. Compute rich tooltips
        if (data.cpu) {
            const loadStr = data.cpu.loadavg ? data.cpu.loadavg.map(v => v.toFixed(2)).join(', ') : '--';
            this._tooltipTexts['cpu'] = `${data.cpu.hardwareModel || 'CPU'}\nLoad: ${loadStr}\nFreq: ${data.cpu.frequency || '--'}`;
        }
        if (data.mem) {
            const usedStr = formatBytes(data.mem.used, useGiB);
            const totalStr = formatBytes(data.mem.total, useGiB);
            const availStr = formatBytes(data.mem.available, useGiB);
            this._tooltipTexts['memory'] = `Used: ${usedStr} / ${totalStr}\nAvailable: ${availStr}\nSwap: ${Math.round(data.mem.swapPercent || 0)}%`;
        }
        if (data.bat && data.bat.present) {
            const state = data.bat.state === 'charging' ? 'Charging' : data.bat.state === 'discharging' ? 'Discharging' : 'Full';
            let timeStr = '';
            if (data.bat.timeRemaining > 0) {
                const h = Math.floor(data.bat.timeRemaining / 3600);
                const m = Math.floor((data.bat.timeRemaining % 3600) / 60);
                timeStr = ` · ${h}h ${m}m ${data.bat.state === 'charging' ? 'to full' : 'left'}`;
            }
            this._tooltipTexts['battery'] = `Battery: ${data.bat.percent.toFixed(1)}% (${state}${timeStr})\nHealth: ${data.bat.health.toFixed(1)}% · Rate: ${(data.bat.energyRate || 0).toFixed(1)}W`;
        }
        if (data.pwr) {
            const draw = data.pwr.systemPower !== null ? data.pwr.systemPower : (data.pwr.packagePower || 0);
            this._tooltipTexts['power'] = `Power Draw: ${draw.toFixed(1)}W\nCPU Package: ${data.pwr.packagePower ? data.pwr.packagePower.toFixed(1) + 'W' : '--'}`;
        }
        if (data.dsk && data.dsk.mounts && data.dsk.mounts.length > 0) {
            const root = data.dsk.mounts[0];
            this._tooltipTexts['disk'] = `Root: ${Math.round(root.percent)}% (${formatBytes(root.free, useGiB)} free)\nI/O: ↓ ${formatSpeed(data.dsk.readRate || 0)}  ↑ ${formatSpeed(data.dsk.writeRate || 0)}`;
        }
        if (data.net && data.net.total) {
            const sessRx = formatBytes(data.net.sessionRx || 0, useGiB);
            const sessTx = formatBytes(data.net.sessionTx || 0, useGiB);
            this._tooltipTexts['network'] = `Download: ${formatSpeed(data.net.total.rxRate)}\nUpload: ${formatSpeed(data.net.total.txRate)}\nSession: ↓ ${sessRx}  ↑ ${sessTx}`;
        }
        if (data.thm) {
            const fanInfo = data.thm.fans && data.thm.fans.length > 0 ? `\nFan: ${data.thm.fans[0].rpm} RPM` : '';
            this._tooltipTexts['thermal'] = `Package Temp: ${formatTemp(data.thm.packageTemp, tempUnit)}${fanInfo}`;
        }
        if (data.gpu) {
            if (data.gpu.present) {
                this._tooltipTexts['gpu'] = `${data.gpu.brand || 'GPU'}: ${Math.round(data.gpu.percent)}%\nVRAM: ${Math.round(data.gpu.memPercent)}% · Temp: ${formatTemp(data.gpu.temp, tempUnit)}`;
            } else {
                this._tooltipTexts['gpu'] = 'GPU: Offline / None';
            }
        }

        // 2. Update top bar text & icons
        Object.keys(this._topBarWidgets).forEach(key => {
            const widget = this._topBarWidgets[key];
            if (!widget.label) return;

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
                widget.icon.icon_name = data.bat.state === 'charging'
                    ? 'battery-good-charging-symbolic' : 'battery-good-symbolic';
            }
            else if (key === 'power' && data.pwr) {
                const draw = data.pwr.systemPower !== null ? data.pwr.systemPower : (data.pwr.packagePower || 0);
                text = draw > 0 ? `${draw.toFixed(1)}W` : '0W';
            }
            else if (key === 'disk' && data.dsk && data.dsk.mounts.length > 0)
                text = `${Math.round(data.dsk.mounts[0].percent)}%`;
            else if (key === 'network' && data.net) {
                if (netFmt === 'both') {
                    text = `↓${formatSpeed(data.net.total.rxRate)} ↑${formatSpeed(data.net.total.txRate)}`;
                } else if (netFmt === 'upload') {
                    text = `↑ ${formatSpeed(data.net.total.txRate)}`;
                } else {
                    text = `↓ ${formatSpeed(data.net.total.rxRate)}`;
                }
            }
            else if (key === 'thermal' && data.thm) text = formatTemp(data.thm.packageTemp, tempUnit);
            else if (key === 'gpu' && data.gpu) text = data.gpu.present ? `${Math.round(data.gpu.percent)}%` : 'N/A';

            widget.label.text = text;

            let warn = false;
            if (key === 'cpu' && data.cpu && data.cpu.total >= cpuWarn) warn = true;
            if (key === 'memory' && data.mem && data.mem.percent >= memWarn) warn = true;
            if (key === 'thermal' && data.thm && data.thm.packageTemp >= tempWarn) warn = true;
            widget.label.style = warn ? 'color: #e01b24;' : '';
        });
    }

    // ── Overview Page ─────────────────────────────────────────────────────────


    _sanitizeCardOrder(list) {
        const defaultOrder = ['cpu', 'memory', 'battery', 'disk', 'network', 'thermal', 'power', 'gpu'];
        const result = [];
        if (Array.isArray(list)) {
            for (const key of list) {
                if (defaultOrder.includes(key) && !result.includes(key)) {
                    result.push(key);
                }
            }
        }
        for (const key of defaultOrder) {
            if (!result.includes(key)) {
                result.push(key);
            }
        }
        return result;
    }

    _saveCardOrder() {
        if (!this._settings || !this._cardOrder) return;
        this._isInternalOrderUpdate = true;
        try {
            this._settings.set_strv('overview-card-order', this._cardOrder);

            let pinned = this._settings.get_strv('pinned-metrics');
            if (pinned && pinned.length > 1) {
                pinned.sort((a, b) => this._cardOrder.indexOf(a) - this._cardOrder.indexOf(b));
                this._settings.set_strv('pinned-metrics', pinned);
            }
        } finally {
            this._isInternalOrderUpdate = false;
        }
    }

    _onCardOrderChanged() {
        if (this._isInternalOrderUpdate) return;
        const saved = this._getStrv('overview-card-order', null);
        if (saved && saved.length > 0) {
            this._cardOrder = this._sanitizeCardOrder(saved);
            this._attachCardsToGrid(this._cardOrder);
        }
    }

    _attachCardsToGrid(order) {
        if (!this._overviewGrid || !this._overviewGridLayout || !this._summaryCards) return;

        for (const key of Object.keys(this._summaryCards)) {
            const box = this._summaryCards[key]?.box;
            if (box && box.get_parent() === this._overviewGrid) {
                this._overviewGrid.remove_child(box);
            }
        }

        order.forEach((key, idx) => {
            const cardObj = this._summaryCards[key];
            if (cardObj?.box) {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                this._overviewGridLayout.attach(cardObj.box, col, row, 1, 1);
            }
        });
    }

    _handleCardDragMotion(draggedKey, cardCenterX, cardCenterY) {
        if (!this._cardOrder || !this._summaryCards || !this._overviewGrid) return;
        const currentOrder = this._cardOrder;
        const currentIndex = currentOrder.indexOf(draggedKey);
        if (currentIndex === -1) return;

        const [gridX, gridY] = this._overviewGrid.get_transformed_position();
        const [gridW, gridH] = this._overviewGrid.get_transformed_size();

        const sampleCard = this._summaryCards[draggedKey]?.box;
        const [cardW, cardH] = sampleCard ? sampleCard.get_size() : [0, 0];

        const stepX = (gridW > cardW && cardW > 0) ? (gridW - cardW) : (gridW > 0 ? gridW / 2 : 190);
        const stepY = (gridH > cardH && cardH > 0) ? (gridH - cardH) / 3 : (gridH > 0 ? gridH / 4 : 95);

        let targetIndex = currentIndex;
        let minDistance = Infinity;

        for (let i = 0; i < currentOrder.length; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const slotCenterX = gridX + col * stepX + (cardW > 0 ? cardW / 2 : stepX / 2);
            const slotCenterY = gridY + row * stepY + (cardH > 0 ? cardH / 2 : stepY / 2);
            const dist = Math.hypot(cardCenterX - slotCenterX, cardCenterY - slotCenterY);
            if (dist < minDistance) {
                minDistance = dist;
                targetIndex = i;
            }
        }

        if (this._previewTargetIndex === targetIndex) return;
        this._previewTargetIndex = targetIndex;

        const previewOrder = [...currentOrder];
        previewOrder.splice(currentIndex, 1);
        previewOrder.splice(targetIndex, 0, draggedKey);
        this._pendingPreviewOrder = previewOrder;

        for (let i = 0; i < currentOrder.length; i++) {
            const k = currentOrder[i];
            if (k === draggedKey) continue;
            const box = this._summaryCards[k]?.box;
            if (!box) continue;

            const previewIdx = previewOrder.indexOf(k);
            const deltaCol = (previewIdx % 2) - (i % 2);
            const deltaRow = Math.floor(previewIdx / 2) - Math.floor(i / 2);

            const targetTx = deltaCol * stepX;
            const targetTy = deltaRow * stepY;

            box.ease({
                translation_x: targetTx,
                translation_y: targetTy,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        }
    }

    _makeCardDraggable(card, key, normalStyle, hoverStyle, gripIcon) {
        if (!card) return;
        card.set_pivot_point(0.5, 0.5);
        card.reactive = true;
        card.track_hover = true;

        let isCandidate = false;
        let isDragging = false;
        let startX = 0, startY = 0;
        let holdTimerId = null;

        let cardOrigX = 0, cardOrigY = 0;
        let cardW = 0, cardH = 0;
        let currentDeltaX = 0, currentDeltaY = 0;

        card.connect('enter-event', () => {
            if (!this._activeCardDrag) {
                if (hoverStyle) card.style = hoverStyle;
                if (gripIcon) gripIcon.style = 'icon-size: 13px; color: rgba(255,255,255,0.6);';
            }
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('leave-event', () => {
            if (!this._activeCardDrag) {
                if (normalStyle) card.style = normalStyle;
                if (gripIcon) gripIcon.style = 'icon-size: 13px; color: rgba(255,255,255,0.2);';
                if (!isDragging) {
                    card.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                    });
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const cancelHoldTimer = () => {
            if (holdTimerId) {
                GLib.source_remove(holdTimerId);
                holdTimerId = null;
            }
            if (this._dragHoldTimerId === holdTimerId) {
                this._dragHoldTimerId = null;
            }
        };

        const startDrag = () => {
            if (isDragging) return;
            cancelHoldTimer();
            isDragging = true;
            isCandidate = false;
            this._activeCardDrag = key;
            this._draggedCardActor = card;
            this._cardDragGrab = global.stage.grab(card);

            // Normalize transitions and get unscaled layout coordinates
            card.remove_all_transitions();
            card.remove_style_class_name('resource-pulse-metric-card-snapping');
            card.set_scale(1.0, 1.0);
            card.set_translation(0, 0, 0);
            [cardOrigX, cardOrigY] = card.get_transformed_position();
            [cardW, cardH] = card.get_transformed_size();
            currentDeltaX = 0;
            currentDeltaY = 0;

            // Safety net: stage-level button release listener
            if (!this._stageReleaseId) {
                this._stageReleaseId = global.stage.connect('button-release-event', (stage, ev) => {
                    if (isDragging) {
                        finishDrag(true);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
            }

            card.add_style_class_name('resource-pulse-metric-card-dragging');
            if (card.get_parent()) {
                card.get_parent().set_child_above_sibling(card, null);
            }
            card.ease({
                scale_x: 1.04,
                scale_y: 1.04,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        };

        const finishDrag = (wasDrag) => {
            cancelHoldTimer();
            if (this._stageReleaseId) {
                global.stage.disconnect(this._stageReleaseId);
                this._stageReleaseId = null;
            }

            if (wasDrag && isDragging) {
                if (this._cardDragGrab) {
                    this._cardDragGrab.dismiss();
                    this._cardDragGrab = null;
                }
                isDragging = false;
                this._activeCardDrag = null;
                this._draggedCardActor = null;

                const oldOrder = this._cardOrder || [];
                const origIndex = oldOrder.indexOf(key);
                const newOrder = this._pendingPreviewOrder || oldOrder;
                const targetIndex = newOrder.indexOf(key);

                this._cardOrder = newOrder;
                this._pendingPreviewOrder = null;
                this._previewTargetIndex = null;

                const [gridW, gridH] = this._overviewGrid ? this._overviewGrid.get_transformed_size() : [0, 0];
                const stepX = (gridW > cardW && cardW > 0) ? (gridW - cardW) : (gridW > 0 ? gridW / 2 : 190);
                const stepY = (gridH > cardH && cardH > 0) ? (gridH - cardH) / 3 : (gridH > 0 ? gridH / 4 : 95);

                const origCol = origIndex >= 0 ? origIndex % 2 : 0;
                const origRow = origIndex >= 0 ? Math.floor(origIndex / 2) : 0;
                const targetCol = targetIndex >= 0 ? targetIndex % 2 : 0;
                const targetRow = targetIndex >= 0 ? Math.floor(targetIndex / 2) : 0;

                const slotShiftX = (targetCol - origCol) * stepX;
                const slotShiftY = (targetRow - origRow) * stepY;

                // Relative to the new slot, compute the card's current visual offset to prevent jumping
                const initialSnapTx = currentDeltaX - slotShiftX;
                const initialSnapTy = currentDeltaY - slotShiftY;

                // For all other cards, calculate their visual offset relative to their new slot
                const otherCardOffsets = {};
                for (const k of Object.keys(this._summaryCards)) {
                    if (k === key) continue;
                    const b = this._summaryCards[k]?.box;
                    if (!b) continue;

                    const oldIdx = oldOrder.indexOf(k);
                    const newIdx = this._cardOrder.indexOf(k);
                    if (oldIdx !== -1 && newIdx !== -1) {
                        const shiftCol = (newIdx % 2) - (oldIdx % 2);
                        const shiftRow = Math.floor(newIdx / 2) - Math.floor(oldIdx / 2);
                        const expectedTx = shiftCol * stepX;
                        const expectedTy = shiftRow * stepY;
                        otherCardOffsets[k] = {
                            tx: b.translation_x - expectedTx,
                            ty: b.translation_y - expectedTy
                        };
                    } else {
                        otherCardOffsets[k] = { tx: 0, ty: 0 };
                    }
                    b.remove_all_transitions();
                }

                // Reattach all cards to grid in final order
                this._attachCardsToGrid(this._cardOrder);

                // Now ease all other cards seamlessly into (0, 0)
                for (const k of Object.keys(this._summaryCards)) {
                    if (k === key) continue;
                    const b = this._summaryCards[k]?.box;
                    const offset = otherCardOffsets[k];
                    if (b && offset) {
                        b.set_translation(offset.tx, offset.ty, 0);
                        if (Math.abs(offset.tx) > 0.5 || Math.abs(offset.ty) > 0.5) {
                            b.ease({
                                translation_x: 0,
                                translation_y: 0,
                                duration: 360,
                                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                            });
                        } else {
                            b.set_translation(0, 0, 0);
                        }
                    }
                }

                // Transition dragged card styling to snapping state
                card.remove_style_class_name('resource-pulse-metric-card-dragging');
                card.add_style_class_name('resource-pulse-metric-card-snapping');

                // Seamless snap ease into destination slot with silky cubic deceleration
                card.remove_all_transitions();
                card.set_translation(initialSnapTx, initialSnapTy, 0);
                card.ease({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 360,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        card.remove_style_class_name('resource-pulse-metric-card-snapping');
                        if (normalStyle) card.style = normalStyle;
                        if (gripIcon) gripIcon.style = 'icon-size: 13px; color: rgba(255,255,255,0.2);';
                    }
                });

                // Finalize order in GSettings
                this._saveCardOrder();
                return Clutter.EVENT_STOP;
            }

            isDragging = false;
            isCandidate = false;
            return Clutter.EVENT_PROPAGATE;
        };

        card.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            startX = x;
            startY = y;
            isCandidate = true;
            isDragging = false;

            card.ease({
                scale_x: 0.98,
                scale_y: 0.98,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });

            cancelHoldTimer();
            holdTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                holdTimerId = null;
                this._dragHoldTimerId = null;
                if (isCandidate && !isDragging) {
                    startDrag();
                }
                return GLib.SOURCE_REMOVE;
            });
            this._dragHoldTimerId = holdTimerId;

            return Clutter.EVENT_STOP;
        });

        card.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            cancelHoldTimer();

            if (isDragging) {
                return finishDrag(true);
            }

            if (isCandidate) {
                isCandidate = false;
                card.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 100,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                // Quick click -> open details page
                this._activeTab = key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                if (type === Clutter.EventType.MOTION) {
                    const state = event.get_state();
                    // If button 1 is no longer held, finish drag immediately
                    if ((state & Clutter.ModifierType.BUTTON1_MASK) === 0) {
                        if (isDragging) {
                            return finishDrag(true);
                        }
                        cancelHoldTimer();
                        isCandidate = false;
                        return Clutter.EVENT_PROPAGATE;
                    }
                }

                const [currX, currY] = event.get_coords();
                const dist = Math.hypot(currX - startX, currY - startY);

                if (isCandidate && !isDragging && dist > 8) {
                    startDrag();
                }

                if (isDragging) {
                    const rawDeltaX = currX - startX;
                    const rawDeltaY = currY - startY;

                    let clampedDeltaX = rawDeltaX;
                    let clampedDeltaY = rawDeltaY;

                    if (this._overviewGrid) {
                        const [gx, gy] = this._overviewGrid.get_transformed_position();
                        const [gw, gh] = this._overviewGrid.get_transformed_size();
                        if (gw > 0 && gh > 0 && cardW > 0 && cardH > 0) {
                            const minDeltaX = gx - cardOrigX;
                            const maxDeltaX = Math.max(minDeltaX, (gx + gw - cardW) - cardOrigX);
                            const minDeltaY = gy - cardOrigY;
                            const maxDeltaY = Math.max(minDeltaY, (gy + gh - cardH) - cardOrigY);

                            clampedDeltaX = Math.max(minDeltaX, Math.min(rawDeltaX, maxDeltaX));
                            clampedDeltaY = Math.max(minDeltaY, Math.min(rawDeltaY, maxDeltaY));
                        }
                    }

                    currentDeltaX = clampedDeltaX;
                    currentDeltaY = clampedDeltaY;
                    card.set_translation(clampedDeltaX, clampedDeltaY, 0);

                    // Compute center of clamped card for slot targeting
                    const cardCenterX = cardOrigX + clampedDeltaX + (cardW > 0 ? cardW / 2 : 0);
                    const cardCenterY = cardOrigY + clampedDeltaY + (cardH > 0 ? cardH / 2 : 0);

                    // Find hover target slot among cards
                    this._handleCardDragMotion(key, cardCenterX, cardCenterY);
                    return Clutter.EVENT_STOP;
                }
            } else if (type === Clutter.EventType.BUTTON_RELEASE ||
                       type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                if (isDragging) {
                    return finishDrag(true);
                }
                cancelHoldTimer();
                isCandidate = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _addCardInteractions(card, normalStyle, hoverStyle) {
        if (!card) return;
        card.set_pivot_point(0.5, 0.5);

        card.connect('enter-event', () => {
            if (hoverStyle) card.style = hoverStyle;
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('leave-event', () => {
            if (normalStyle) card.style = normalStyle;
            card.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('button-press-event', () => {
            card.ease({
                scale_x: 0.98,
                scale_y: 0.98,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('button-release-event', () => {
            card.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _addClickAnimations(actor) {
        if (!actor) return;
        actor.set_pivot_point(0.5, 0.5);

        actor.connect('leave-event', () => {
            actor.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('button-press-event', () => {
            actor.ease({
                scale_x: 0.92,
                scale_y: 0.92,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        actor.connect('button-release-event', () => {
            actor.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildOverview() {
        this._overviewPage = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });

        // Header container (System Overview, Refresh, Menu)
        const headerBox = new St.BoxLayout({ style: 'margin-bottom: 12px;', y_align: Clutter.ActorAlign.CENTER });
        const titleLbl = new St.Label({ text: 'System Overview', style: 'font-size: 1.3em; font-weight: bold; color: #ffffff;', x_expand: true });
        headerBox.add_child(titleLbl);

        const refreshBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 99px; padding: 6px;', reactive: true });
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

        const menuBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 99px; padding: 6px; margin-left: 6px;', reactive: true });
        const menuIcon = new St.Icon({ icon_name: 'view-more-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        menuIcon.set_pivot_point(0.5, 0.5);
        menuBtn.add_child(menuIcon);
        menuBtn.connect('clicked', () => {
            this._openSettingsView();
        });
        this._overviewMenuBtn = menuBtn;
        this._overviewMenuIcon = menuIcon;

        this._addClickAnimations(refreshBtn);
        headerBox.add_child(refreshBtn);
        this._addClickAnimations(menuBtn);
        headerBox.add_child(menuBtn);
        this._overviewPage.add_child(headerBox);

        // Unified 2-Column Reorderable Card Grid
        const grid = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        this._overviewGridLayout = grid;
        this._overviewGrid = new St.Widget({ layout_manager: grid, style_class: 'resource-pulse-overview-grid', x_expand: true });
        this._overviewPage.add_child(this._overviewGrid);

        this._summaryCards = {};

        // 1. CPU Card
        const cpuNormal = 'background-color: #1f2937; border: 1px solid rgba(53, 132, 228, 0.4); border-radius: 12px; padding: 12px;';
        const cpuHover  = 'background-color: #26354a; border: 1px solid rgba(53, 132, 228, 0.9); border-radius: 12px; padding: 12px;';
        const cpuCard = new St.BoxLayout({
            style: cpuNormal,
            vertical: true, reactive: true, can_focus: true, x_expand: true
        });
        const cpuHead = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;', y_align: Clutter.ActorAlign.CENTER });
        const cpuIcon = new St.Icon({ icon_name: this._getIconName('cpu'), style: 'icon-size: 16px; color: #3584e4;' });
        cpuHead.add_child(cpuIcon);
        cpuHead.add_child(new St.Label({ text: 'CPU', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        const cpuGrip = new St.Icon({ icon_name: 'view-grid-symbolic', style: 'icon-size: 13px; color: rgba(255,255,255,0.2);' });
        cpuHead.add_child(cpuGrip);
        cpuCard.add_child(cpuHead);
        const cpuVal = new St.Label({ text: '--%', style: 'font-size: 1.7em; font-weight: bold; color: #ffffff;' });
        cpuCard.add_child(cpuVal);
        const cpuSpark = new Sparkline(-1, 30, 100, false, { color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.15 });
        cpuSpark.x_expand = true;
        cpuCard.add_child(cpuSpark);
        const cpuBar = new ProgressBar(4, 0.208, 0.518, 0.894);
        cpuCard.add_child(cpuBar);
        this._makeCardDraggable(cpuCard, 'cpu', cpuNormal, cpuHover, cpuGrip);
        this._summaryCards['cpu'] = { box: cpuCard, valueLabel: cpuVal, pbar: cpuBar, spark: cpuSpark };

        // 2. Memory Card
        const memNormal = 'background-color: #1e1a2e; border: 1px solid rgba(145, 65, 172, 0.4); border-radius: 12px; padding: 12px;';
        const memHover  = 'background-color: #292240; border: 1px solid rgba(145, 65, 172, 0.9); border-radius: 12px; padding: 12px;';
        const memCard = new St.BoxLayout({
            style: memNormal,
            vertical: true, reactive: true, can_focus: true, x_expand: true
        });
        const memHead = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;', y_align: Clutter.ActorAlign.CENTER });
        const memIcon = new St.Icon({ icon_name: this._getIconName('memory'), style: 'icon-size: 16px; color: #9141ac;' });
        memHead.add_child(memIcon);
        memHead.add_child(new St.Label({ text: 'Memory', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        const memGrip = new St.Icon({ icon_name: 'view-grid-symbolic', style: 'icon-size: 13px; color: rgba(255,255,255,0.2);' });
        memHead.add_child(memGrip);
        memCard.add_child(memHead);
        const memVal = new St.Label({ text: '--%', style: 'font-size: 1.7em; font-weight: bold; color: #ffffff;' });
        memCard.add_child(memVal);
        const memSpark = new Sparkline(-1, 30, 100, false, { color: [0.569, 0.255, 0.675, 1.0], fillOpacity: 0.15 });
        memSpark.x_expand = true;
        memCard.add_child(memSpark);
        const memBar = new ProgressBar(4, 0.569, 0.255, 0.675);
        memCard.add_child(memBar);
        this._makeCardDraggable(memCard, 'memory', memNormal, memHover, memGrip);
        this._summaryCards['memory'] = { box: memCard, valueLabel: memVal, pbar: memBar, spark: memSpark };

        // 3. Battery Card
        const batNormal = 'background-color: #192820; border: 1px solid rgba(46, 194, 126, 0.4); border-radius: 12px; padding: 12px;';
        const batHover  = 'background-color: #20382b; border: 1px solid rgba(46, 194, 126, 0.9); border-radius: 12px; padding: 12px;';
        const batCard = new St.BoxLayout({
            style: batNormal,
            vertical: true, reactive: true, can_focus: true, x_expand: true
        });
        const batHead = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;', y_align: Clutter.ActorAlign.CENTER });
        const batIcon = new St.Icon({ icon_name: this._getIconName('battery'), style: 'icon-size: 16px; color: #2ec27e;' });
        batHead.add_child(batIcon);
        batHead.add_child(new St.Label({ text: 'Battery', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        const batGrip = new St.Icon({ icon_name: 'view-grid-symbolic', style: 'icon-size: 13px; color: rgba(255,255,255,0.2);' });
        batHead.add_child(batGrip);
        batCard.add_child(batHead);
        const batVal = new St.Label({ text: '--%', style: 'font-size: 1.7em; font-weight: bold; color: #ffffff;' });
        batCard.add_child(batVal);
        const batStatus = new St.Label({ text: 'Discharging', style: 'font-size: 0.75em; color: #8c8c94; margin-bottom: 4px;' });
        batCard.add_child(batStatus);
        const batBar = new ProgressBar(4, 0.18, 0.76, 0.494);
        batCard.add_child(batBar);
        this._makeCardDraggable(batCard, 'battery', batNormal, batHover, batGrip);
        this._summaryCards['battery'] = { box: batCard, valueLabel: batVal, pbar: batBar, statusLbl: batStatus };

        // 4. Secondary Metrics (Disk, Network, Thermal, Power, GPU)
        const secondaryMetrics = [
            { key: 'disk', label: 'Disk', r: 0.96, g: 0.83, b: 0.18, iconColor: '#f6d32d', bg: '#22200a', border: 'rgba(246,211,45,0.35)', hoverBg: '#2d2b0e', hoverBorder: 'rgba(246,211,45,0.9)' },
            { key: 'network', label: 'Network', r: 0.88, g: 0.11, b: 0.14, iconColor: '#e01b24', bg: '#22100f', border: 'rgba(224,27,36,0.35)', hoverBg: '#2f1615', hoverBorder: 'rgba(224,27,36,0.9)' },
            { key: 'thermal', label: 'Thermal', r: 1.0, g: 0.47, b: 0.0, iconColor: '#ff7800', bg: '#221608', border: 'rgba(255,120,0,0.35)', hoverBg: '#2f1f0b', hoverBorder: 'rgba(255,120,0,0.9)' },
            { key: 'power', label: 'Power', r: 0.96, g: 0.83, b: 0.18, iconColor: '#f6d32d', bg: '#22200a', border: 'rgba(246,211,45,0.35)', hoverBg: '#2d2b0e', hoverBorder: 'rgba(246,211,45,0.9)' },
            { key: 'gpu', label: 'GPU', r: 0.2, g: 0.82, b: 0.48, iconColor: '#33d17a', bg: '#0b2014', border: 'rgba(51,209,122,0.35)', hoverBg: '#10301e', hoverBorder: 'rgba(51,209,122,0.9)' }
        ];

        secondaryMetrics.forEach(m => {
            const normalStyle = `background-color: ${m.bg}; border: 1px solid ${m.border}; border-radius: 12px; padding: 12px;`;
            const hoverStyle  = `background-color: ${m.hoverBg}; border: 1px solid ${m.hoverBorder}; border-radius: 12px; padding: 12px;`;
            const card = new St.BoxLayout({
                style: normalStyle,
                vertical: true, reactive: true, can_focus: true, x_expand: true
            });

            const head = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;', y_align: Clutter.ActorAlign.CENTER });
            head.add_child(new St.Icon({ icon_name: this._getIconName(m.key), style: `icon-size: 16px; color: ${m.iconColor};` }));
            head.add_child(new St.Label({ text: m.label, style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
            const grip = new St.Icon({ icon_name: 'view-grid-symbolic', style: 'icon-size: 13px; color: rgba(255,255,255,0.2);' });
            head.add_child(grip);
            card.add_child(head);

            const val = new St.Label({ text: '--', style: 'font-size: 1.7em; font-weight: bold; color: #ffffff;' });
            card.add_child(val);

            const subtext = new St.Label({ text: '', style: 'font-size: 0.75em; color: #8c8c94; margin-bottom: 4px;', visible: false });
            card.add_child(subtext);

            const pbar = new ProgressBar(4, m.r, m.g, m.b);
            card.add_child(pbar);

            this._makeCardDraggable(card, m.key, normalStyle, hoverStyle, grip);
            this._summaryCards[m.key] = { box: card, valueLabel: val, subLabel: subtext, pbar };
        });

        // Initialize and attach cards according to saved/default order
        this._cardOrder = this._sanitizeCardOrder(this._getStrv('overview-card-order', null));
        this._attachCardsToGrid(this._cardOrder);

        // Hardware Info Card
        const hwNormal = 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px; margin-top: 10px;';
        const hwHover  = 'background-color: #2a2a2a; border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 12px; margin-top: 10px;';
        this._hwCard = new St.BoxLayout({ style: hwNormal, vertical: true, x_expand: true });

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

        this._addCardInteractions(this._hwCard, hwNormal, hwHover);
        this._overviewPage.add_child(this._hwCard);

        // System Monitor Quick Launch Footer
        const sysMonBtn = new St.Button({
            style_class: 'resource-pulse-sysmon-button',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        const sysMonBox = new St.BoxLayout({ style: 'spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });
        const sysMonIcon = new St.Icon({
            icon_name: 'org.gnome.SystemMonitor-symbolic',
            fallback_icon_name: 'utilities-system-monitor-symbolic',
            style: 'icon-size: 16px; color: #3584e4;'
        });
        const sysMonLbl = new St.Label({
            text: 'Open System Monitor',
            style_class: 'resource-pulse-sysmon-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        const sysMonArrow = new St.Icon({
            icon_name: 'go-next-symbolic',
            style: 'icon-size: 14px; color: rgba(255,255,255,0.4);',
            y_align: Clutter.ActorAlign.CENTER
        });
        sysMonBox.add_child(sysMonIcon);
        sysMonBox.add_child(sysMonLbl);
        sysMonBox.add_child(sysMonArrow);
        sysMonBtn.add_child(sysMonBox);

        sysMonBtn.connect('clicked', () => {
            this._launchSystemMonitor();
            this._indicator.menu.close();
        });
        this._addClickAnimations(sysMonBtn);
        this._overviewPage.add_child(sysMonBtn);

        this._menuContainer.add_child(this._overviewPage);
    }

    // ── Details Page ──────────────────────────────────────────────────────────

    _buildDetails() {
        this._detailArea = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-detail-area',
            x_expand: true,
            y_expand: true
        });

        // Top bar for CPU detail header (matches Right Panel header)
        this._detailHeader = new St.BoxLayout({ style: 'margin-bottom: 14px; spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });

        const backBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 99px; padding: 6px;', reactive: true });
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

        const optBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.05); border-radius: 99px; padding: 6px;', reactive: true });
        const optIcon = new St.Icon({ icon_name: 'view-more-symbolic', style: 'icon-size: 16px; color: #ffffff;' });
        optIcon.set_pivot_point(0.5, 0.5);
        optBtn.add_child(optIcon);
        optBtn.connect('clicked', () => {
            this._openSettingsView();
        });
        this._detailOptBtn = optBtn;
        this._detailOptIcon = optIcon;

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
            if (this._settingsPage) this._settingsPage.visible = false;
        } else if (this._activeTab === 'settings') {
            this._overviewPage.visible = false;
            this._detailArea.visible = false;
            if (this._settingsPage) {
                this._settingsPage.opacity = 0;
                this._settingsPage.visible = true;
                this._settingsPage.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
        } else {
            this._overviewPage.visible = false;
            if (this._settingsPage) this._settingsPage.visible = false;
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
        this._cpuSparkline = new Sparkline(-1, 110, 100, false, {
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

        const showAllBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.07); border-radius: 20px; padding: 4px 10px;', label: 'Show All', reactive: true, can_focus: true });
        showAllBtn.child.style = 'font-size: 0.75em; color: #a0a0b8;';
        showAllBtn.connect('clicked', () => {
            this._launchSystemMonitor();
            this._indicator.menu.close();
        });
        this._addClickAnimations(showAllBtn);
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
        this._memSparkline = new Sparkline(-1, 100, 100, false, { showGrid: true, color: [0.569, 0.255, 0.675, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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
        const memProcHead = new St.BoxLayout({ style: 'margin-bottom: 8px;', y_align: Clutter.ActorAlign.CENTER });
        memProcHead.add_child(new St.Label({ text: 'Top Memory Usage', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        const memShowAllBtn = new St.Button({ style: 'background-color: rgba(255,255,255,0.07); border-radius: 20px; padding: 4px 10px;', label: 'Show All', reactive: true, can_focus: true });
        memShowAllBtn.child.style = 'font-size: 0.75em; color: #a0a0b8;';
        memShowAllBtn.connect('clicked', () => {
            this._launchSystemMonitor();
            this._indicator.menu.close();
        });
        this._addClickAnimations(memShowAllBtn);
        memProcHead.add_child(memShowAllBtn);
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
        this._batSparkline = new Sparkline(-1, 90, 100, false, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._batSparkline.x_expand = true;
        sparkCard.add_child(this._batSparkline);
        box.add_child(sparkCard);

        // Power Rate History (W)
        const rateCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        rateCard.add_child(new St.Label({ text: 'Charge/Discharge Rate (W)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._batRateSparkline = new Sparkline(-1, 90, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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
        this._pwrSparkline = new Sparkline(-1, 100, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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
        this._dskReadSparkline = new Sparkline(-1, 80, 100, true, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskReadSparkline.x_expand = true;
        readCard.add_child(this._dskReadSparkline);
        box.add_child(readCard);

        // Write Rate Sparkline
        const writeCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        writeCard.add_child(new St.Label({ text: 'Write Rate (MB/s)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._dskWriteSparkline = new Sparkline(-1, 80, 100, true, { showGrid: true, color: [0.88, 0.11, 0.14, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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
        this._netRxSparkline = new Sparkline(-1, 80, 100, true, { showGrid: true, color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netRxSparkline.x_expand = true;
        rxCard.add_child(this._netRxSparkline);
        box.add_child(rxCard);

        // Upload Sparkline
        const txCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        txCard.add_child(new St.Label({ text: 'Upload Rate', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._netTxSparkline = new Sparkline(-1, 80, 100, true, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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
        this._thmSparkline = new Sparkline(-1, 100, 100, true, { showGrid: true, color: [1.0, 0.47, 0.0, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
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

        const gpuHwNormal = 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;';
        const gpuHwHover  = 'background-color: #2a2a2a; border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 12px;';
        this._gpuHwCard = new St.BoxLayout({
            style: gpuHwNormal,
            vertical: true,
            x_expand: true
        });

        const hwTop = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });

        // Brand Chip Badge
        this._gpuChipBox = new St.BoxLayout({
            style: 'background-color: #107c41; border-radius: 6px; padding: 6px 10px;',
            vertical: true
        });
        this._gpuChipLabel1 = new St.Label({ text: 'GEFORCE', style: 'font-size: 0.65em; color: #a0f0c8; font-weight: 300;' });
        this._gpuChipLabel2 = new St.Label({ text: 'RTX', style: 'font-size: 0.9em; color: #ffffff; font-weight: bold; letter-spacing: 1px;' });
        this._gpuChipBox.add_child(this._gpuChipLabel1);
        this._gpuChipBox.add_child(this._gpuChipLabel2);
        hwTop.add_child(this._gpuChipBox);

        const hwDesc = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;', x_expand: true });
        this._gpuModelName = new St.Label({ text: 'Graphics Processor', style: 'font-size: 1.05em; font-weight: bold; color: #ffffff;' });
        this._gpuDriverDesc = new St.Label({ text: 'Driver: --', style: 'font-size: 0.8em; color: #a0a0b8;' });
        hwDesc.add_child(this._gpuModelName);
        hwDesc.add_child(this._gpuDriverDesc);
        hwTop.add_child(hwDesc);
        this._gpuHwCard.add_child(hwTop);

        // Hardware Sub Stats (Clock, Temp, Power)
        const hwStatsRow = new St.BoxLayout({ style: 'margin-top: 10px; spacing: 16px;', x_expand: true });

        const clockBox = new St.BoxLayout({ vertical: true, x_expand: true });
        clockBox.add_child(new St.Label({ text: 'Clock', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._gpuHwClockVal = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        clockBox.add_child(this._gpuHwClockVal);

        const tempBox = new St.BoxLayout({ vertical: true, x_expand: true });
        tempBox.add_child(new St.Label({ text: 'Temperature', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._gpuHwTempVal = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        tempBox.add_child(this._gpuHwTempVal);

        const powerBox = new St.BoxLayout({ vertical: true, x_expand: true });
        powerBox.add_child(new St.Label({ text: 'Power', style: 'font-size: 0.75em; color: #a0a0b8;' }));
        this._gpuHwPowerVal = new St.Label({ text: '--', style: 'font-size: 0.95em; font-weight: bold; color: #ffffff;' });
        powerBox.add_child(this._gpuHwPowerVal);

        hwStatsRow.add_child(clockBox);
        hwStatsRow.add_child(tempBox);
        hwStatsRow.add_child(powerBox);
        this._gpuHwCard.add_child(hwStatsRow);
        this._addCardInteractions(this._gpuHwCard, gpuHwNormal, gpuHwHover);
        box.add_child(this._gpuHwCard);

        // 2. GPU Usage Sparkline Card
        const sparkCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'GPU Utilization (%)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 4px;' }));
        this._gpuSparkline = new Sparkline(-1, 100, 100, false, { showGrid: true, color: [0.2, 0.82, 0.48, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._gpuSparkline.x_expand = true;
        sparkCard.add_child(this._gpuSparkline);
        box.add_child(sparkCard);

        // 3. VRAM Card (if dedicated or shared VRAM reported)
        this._gpuVramCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        const vramHead = new St.BoxLayout({ style: 'margin-bottom: 6px;', y_align: Clutter.ActorAlign.CENTER });
        vramHead.add_child(new St.Label({ text: 'Video Memory (VRAM)', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8;', x_expand: true }));
        this._gpuVramPctLbl = new St.Label({ text: '--%', style: 'font-size: 0.85em; font-weight: bold; color: #ffffff;' });
        vramHead.add_child(this._gpuVramPctLbl);
        this._gpuVramCard.add_child(vramHead);

        this._gpuVramBar = new ProgressBar(6, 0.2, 0.82, 0.48);
        this._gpuVramCard.add_child(this._gpuVramBar);

        const vramStatsBox = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
        this._gpuVramUsed = this._detailRow('Used / Total');
        vramStatsBox.add_child(this._gpuVramUsed.row);
        this._gpuVramFree = this._detailRow('Free VRAM');
        vramStatsBox.add_child(this._gpuVramFree.row);
        this._gpuVramCard.add_child(vramStatsBox);
        box.add_child(this._gpuVramCard);

        // 4. Performance & Thermal Stats Card
        const statsCard = new St.BoxLayout({ style: 'background-color: #242424; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Performance & Sensors', style: 'font-size: 0.9em; font-weight: 600; color: #a0a0b8; margin-bottom: 6px;' }));
        this._gpuUsage = this._detailRow('Core Utilization');
        statsCard.add_child(this._gpuUsage.row);
        this._gpuCoreClock = this._detailRow('Core Clock');
        statsCard.add_child(this._gpuCoreClock.row);
        this._gpuTemp  = this._detailRow('Temperature');
        statsCard.add_child(this._gpuTemp.row);
        this._gpuFan = this._detailRow('Fan Speed');
        statsCard.add_child(this._gpuFan.row);
        this._gpuPower = this._detailRow('Power Draw');
        statsCard.add_child(this._gpuPower.row);
        box.add_child(statsCard);

        // 5. Inactive / None Fallback Notice
        this._gpuInactiveCard = new St.BoxLayout({
            style: 'background-color: #1e1e1e; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 16px;',
            vertical: true,
            visible: false
        });
        const inactTitle = new St.Label({
            text: 'No Active GPU Detected',
            style: 'font-size: 1.0em; font-weight: bold; color: #ffffff; margin-bottom: 6px;'
        });
        const inactMsg = new St.Label({
            text: 'GPU telemetry requires NVIDIA proprietary drivers (nvidia-smi), AMD GPU sysfs (amdgpu), or Intel DRM driver (i915/xe).',
            style: 'font-size: 0.8em; color: #a0a0b8;'
        });
        this._gpuInactiveCard.add_child(inactTitle);
        this._gpuInactiveCard.add_child(inactMsg);
        box.add_child(this._gpuInactiveCard);

        return box;
    }

    // ── Dashboard Update ──────────────────────────────────────────────────────

    _updateDashboardUI(data) {
        if (!this._settings || !this._indicator) return;
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

            if (this._menuOpen && this._activeTab === 'disk' && this._dskMountsBox && dsk.mounts) {
                if (!this._dskMountRows) this._dskMountRows = [];
                if (this._dskMountRows.length !== dsk.mounts.length) {
                    this._dskMountsBox.destroy_all_children();
                    this._dskMountRows = [];
                    dsk.mounts.forEach(m => {
                        const row = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });
                        const headRow = new St.BoxLayout();
                        const mountLbl = new St.Label({ text: m.mount, style: 'font-size: 0.8em; color: #ffffff; font-weight: 500;', x_expand: true });
                        const statLbl = new St.Label({ text: '', style: 'font-size: 0.8em; color: #a0a0b8;' });
                        headRow.add_child(mountLbl);
                        headRow.add_child(statLbl);
                        row.add_child(headRow);

                        const pbar = new ProgressBar(4, 0.96, 0.83, 0.18);
                        row.add_child(pbar);

                        this._dskMountsBox.add_child(row);
                        this._dskMountRows.push({ mountLbl, statLbl, pbar });
                    });
                }
                dsk.mounts.forEach((m, idx) => {
                    const r = this._dskMountRows[idx];
                    if (r) {
                        r.mountLbl.text = m.mount;
                        r.statLbl.text = `${formatBytes(m.used, useGiB)} / ${formatBytes(m.size, useGiB)} (${Math.round(m.percent)}%)`;
                        r.pbar.setPercent(m.percent);
                    }
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

            if (this._menuOpen && this._activeTab === 'network' && this._netIfaceList && net.interfaces) {
                const activeIfaces = Object.entries(net.interfaces).filter(([name, iface]) =>
                    iface.rxRate > 100 || iface.txRate > 100 || /^(wlan|eth|enp|wlp)/.test(name)
                );
                if (!this._netIfaceRows) this._netIfaceRows = [];
                if (this._netIfaceRows.length !== activeIfaces.length) {
                    this._netIfaceList.destroy_all_children();
                    this._netIfaceRows = [];
                    activeIfaces.forEach(() => {
                        const row = new St.BoxLayout({ style: 'padding: 2px 0;' });
                        const nameLbl = new St.Label({ style: 'font-size: 0.8em; color: #ffffff; font-weight: 500;', width: 80 });
                        const statLbl = new St.Label({ style: 'font-size: 0.8em; color: #a0a0b8;', x_expand: true });
                        row.add_child(nameLbl);
                        row.add_child(statLbl);
                        this._netIfaceList.add_child(row);
                        this._netIfaceRows.push({ nameLbl, statLbl });
                    });
                }
                activeIfaces.forEach(([name, iface], idx) => {
                    const r = this._netIfaceRows[idx];
                    if (r) {
                        r.nameLbl.text = name;
                        r.statLbl.text = `↓ ${formatSpeed(iface.rxRate)}   ↑ ${formatSpeed(iface.txRate)}`;
                    }
                });
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
            if (this._menuOpen && this._activeTab === 'thermal') {
                if (this._thmSensorsBox && thm.sensors) {
                    if (!this._thmSensorRows) this._thmSensorRows = [];
                    if (this._thmSensorRows.length !== thm.sensors.length) {
                        this._thmSensorsBox.destroy_all_children();
                        this._thmSensorRows = [];
                        if (thm.sensors.length > 0) {
                            thm.sensors.forEach(sensor => {
                                const row = this._detailRow(sensor.label, '');
                                this._thmSensorsBox.add_child(row.row);
                                this._thmSensorRows.push(row);
                            });
                        } else {
                            const row = this._detailRow('No sensors found', '--');
                            this._thmSensorsBox.add_child(row.row);
                        }
                    }
                    thm.sensors.forEach((sensor, idx) => {
                        const r = this._thmSensorRows[idx];
                        if (r) {
                            r.lbl.text = sensor.label;
                            r.val.text = formatTemp(sensor.temp, tempUnit);
                        }
                    });
                }
                if (this._thmFansCard && this._thmFansBox && thm.fans) {
                    if (!this._thmFanRows) this._thmFanRows = [];
                    if (thm.fans.length > 0) {
                        this._thmFansCard.visible = true;
                        if (this._thmFanRows.length !== thm.fans.length) {
                            this._thmFansBox.destroy_all_children();
                            this._thmFanRows = [];
                            thm.fans.forEach(fan => {
                                const row = this._detailRow(fan.label, '');
                                this._thmFansBox.add_child(row.row);
                                this._thmFanRows.push(row);
                            });
                        }
                        thm.fans.forEach((fan, idx) => {
                            const r = this._thmFanRows[idx];
                            if (r) {
                                r.lbl.text = fan.label;
                                r.val.text = `${fan.rpm} RPM`;
                            }
                        });
                    } else {
                        this._thmFansCard.visible = false;
                    }
                }
            }
        }

        // ── GPU ──
        if (data.gpu) {
            const gpu = data.gpu;
            const sc = this._summaryCards?.gpu;
            if (sc) {
                sc.box.visible = true;
                if (gpu.present) {
                    sc.valueLabel.text = `${Math.round(gpu.percent)}%`;
                    sc.pbar.setPercent(gpu.percent);
                    sc.subLabel.visible = true;
                    const clockText = gpu.clock ? ` · ${Math.round(gpu.clock)} MHz` : '';
                    sc.subLabel.text = `${gpu.brand || 'GPU'}${clockText}`;
                } else {
                    sc.valueLabel.text = 'N/A';
                    sc.pbar.setPercent(0);
                    sc.subLabel.visible = true;
                    sc.subLabel.text = 'No GPU Detected';
                }
            }

            if (this._gpuInactiveCard) {
                this._gpuInactiveCard.visible = !gpu.present;
            }

            // Update Model / Chip Badge
            if (this._gpuModelName) this._gpuModelName.text = gpu.model || `${gpu.brand} Graphics`;
            if (this._gpuDriverDesc) this._gpuDriverDesc.text = `Driver: ${gpu.driver || '--'}`;

            if (this._gpuChipBox) {
                const brand = (gpu.brand || '').toLowerCase();
                if (brand.includes('nvidia')) {
                    this._gpuChipBox.style = 'background-color: #76b900; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'NVIDIA';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #223300; font-weight: bold;';
                    this._gpuChipLabel2.text = 'GEFORCE';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #000000; font-weight: bold; letter-spacing: 1px;';
                } else if (brand.includes('amd')) {
                    this._gpuChipBox.style = 'background-color: #d22630; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'AMD';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #f9b8bb; font-weight: 300;';
                    this._gpuChipLabel2.text = 'RADEON';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold; letter-spacing: 1px;';
                } else {
                    this._gpuChipBox.style = 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'intel';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;';
                    this._gpuChipLabel2.text = 'GRAPHICS';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold; letter-spacing: 1px;';
                }
            }

            // Quick Hardware Sub-Stats
            const clockStr = gpu.clock ? (gpu.maxClock ? `${Math.round(gpu.clock)} / ${Math.round(gpu.maxClock)} MHz` : `${Math.round(gpu.clock)} MHz`) : '--';
            if (this._gpuHwClockVal) this._gpuHwClockVal.text = clockStr;
            if (this._gpuHwTempVal) this._gpuHwTempVal.text = gpu.temp > 0 ? formatTemp(gpu.temp, tempUnit) : '--';
            if (this._gpuHwPowerVal) this._gpuHwPowerVal.text = gpu.powerDraw ? `${gpu.powerDraw.toFixed(1)} W` : '--';

            // Sparkline
            if (this._gpuSparkline) {
                this._gpuSparkline.addSample(gpu.percent);
                this._gpuSparkline.setScaleLabel(`Cur: ${Math.round(gpu.percent)}%`);
            }

            // VRAM Card
            if (this._gpuVramCard) {
                if (gpu.memTotal > 0) {
                    this._gpuVramCard.visible = true;
                    if (this._gpuVramPctLbl) this._gpuVramPctLbl.text = `${Math.round(gpu.memPercent)}%`;
                    if (this._gpuVramBar) this._gpuVramBar.setPercent(gpu.memPercent);
                    if (this._gpuVramUsed) {
                        this._gpuVramUsed.val.text = `${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)} (${gpu.memPercent.toFixed(1)}%)`;
                    }
                    if (this._gpuVramFree) {
                        this._gpuVramFree.val.text = formatBytes(gpu.memFree || (gpu.memTotal - gpu.memUsed), useGiB);
                    }
                } else {
                    this._gpuVramCard.visible = false;
                }
            }

            // Stats Card
            if (this._gpuUsage) this._gpuUsage.val.text = `${Math.round(gpu.percent)}%`;
            if (this._gpuCoreClock) this._gpuCoreClock.val.text = clockStr;
            if (this._gpuTemp) this._gpuTemp.val.text = gpu.temp > 0 ? formatTemp(gpu.temp, tempUnit) : '--';
            if (this._gpuFan) this._gpuFan.val.text = gpu.fanSpeed !== null ? `${gpu.fanSpeed} RPM` : '--';
            if (this._gpuPower) this._gpuPower.val.text = gpu.powerDraw ? `${gpu.powerDraw.toFixed(1)} W` : '--';
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
                const item = new St.BoxLayout({
                    style: 'padding: 6px 8px; spacing: 8px; border-radius: 8px;',
                    style_class: 'resource-pulse-process-item',
                    y_align: Clutter.ActorAlign.CENTER,
                    reactive: true,
                    can_focus: true
                });

                const iconBox = new St.BoxLayout({ style: 'width: 24px; height: 24px; background-color: rgba(255,255,255,0.06); border-radius: 6px;', y_align: Clutter.ActorAlign.CENTER });
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

                item.connect('button-press-event', () => {
                    this._launchSystemMonitor();
                    this._indicator.menu.close();
                    return Clutter.EVENT_STOP;
                });
                this._addClickAnimations(item);

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
