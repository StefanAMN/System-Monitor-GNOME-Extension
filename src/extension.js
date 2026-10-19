import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { CpuSampler } from './lib/collectors/cpu.js';
import { MemorySampler } from './lib/collectors/memory.js';
import { BatterySampler } from './lib/collectors/battery.js';
import { PowerSampler } from './lib/collectors/power.js';
import { DiskSampler } from './lib/collectors/disk.js';
import { NetworkSampler } from './lib/collectors/network.js';
import { ThermalSampler } from './lib/collectors/thermal.js';
import { GpuSampler } from './lib/collectors/gpu.js';
import { ProcessSampler } from './lib/collectors/process.js';
import { ledgerPath } from './lib/engine/batterytracker.js';
import { BatteryLedger, saveLedger } from './lib/engine/batteryledger.js';
import { PeakScale } from './lib/common/present.js';
import { RingBuffer } from './lib/engine/ringbuffer.js';
import { AlertMonitor } from './lib/engine/alerts.js';
import { PressureSampler } from './lib/collectors/pressure.js';
import { BucketSeries, RANGES } from './lib/engine/longhistory.js';
import { loadNetUsage, netUsagePath, readBootId } from './lib/engine/netusage.js';
import { RunningStats } from './lib/engine/stats.js';
import { HISTORY_CAPACITY, HISTORY_KEYS } from './ui/panel/constants.js';
import { installMethods } from './ui/panel/mixins.js';
import { setTranslations, resetTranslations, _ } from './lib/common/i18n.js';
import { resetUtils } from './lib/common/utils.js';
import { forgetAppInfo } from './lib/common/appnames.js';
import { SharedMethods } from './ui/panel/shared.js';
import { SizingMethods } from './ui/panel/sizing.js';
import { PollingMethods } from './ui/panel/polling.js';
import { TopbarMethods } from './ui/panel/topbar.js';
import { AlertsMethods } from './ui/panel/alerts.js';
import { ProcessesMethods } from './ui/panel/processes.js';
import { OverviewMethods } from './ui/panel/overview.js';
import { DetailsMethods } from './ui/panel/details.js';
import { CpuPage } from './ui/panel/pages/cpu.js';
import { MemoryPage } from './ui/panel/pages/memory.js';
import { BatteryPage } from './ui/panel/pages/battery.js';
import { PowerPage } from './ui/panel/pages/power.js';
import { DiskPage } from './ui/panel/pages/disk.js';
import { NetworkPage } from './ui/panel/pages/network.js';
import { ThermalPage } from './ui/panel/pages/thermal.js';
import { GpuPage } from './ui/panel/pages/gpu.js';
import { DashboardMethods } from './ui/panel/dashboard.js';
import { AccessibilityMethods } from './ui/panel/a11y.js';

// ─── Extension Class ──────────────────────────────────────────────────────────
// enable() and disable() live here; the panel's methods are grouped by
// responsibility in ui/panel/ and installed on this class below.

export default class ResourcePulseExtension extends Extension {
    enable() {
        // Everything enable() and later code hang on `this` is dropped again
        // in disable(), so no widget reference can outlive its actor.
        this._baseKeys = new Set(Object.keys(this));
        // Extension has bound the domain (metadata's gettext-domain).
        setTranslations(this.gettext.bind(this), this.ngettext.bind(this));
        this._settings = this.getSettings();

        // Samplers
        this._cpu = new CpuSampler();
        this._mem = new MemorySampler();
        this._bat = new BatterySampler();
        this._proc = new ProcessSampler();
        // Bars without a natural maximum scale to the recent peak.
        this._pwrScale = new PeakScale(15);            // watts
        this._netScale = new PeakScale(1000000);       // bytes/s
        this._pwr = new PowerSampler();
        this._pwrStats = new RunningStats();
        this._dsk = new DiskSampler();
        this._net = new NetworkSampler();
        this._thm = new ThermalSampler();
        this._gpu = new GpuSampler();
        this._psi = new PressureSampler();
        // What the panel shows: a glide from _shownFrom to _shownTo over one
        // interval, starting at _shownAt. Raw readings stay in _lastData.
        this._shownFrom = null;
        this._shownTo = null;
        this._shownAt = 0;
        this._smoothPrev = null;
        this._glideId = 0;
        // Network data per day: counted from the file's last counters once loaded.
        this._netUsage = null;
        this._netUsageDirty = false;
        this._netUsageSavedAt = GLib.get_monotonic_time();
        this._bootId = readBootId();
        {
            // A token, not _gen: _gen is bumped further down in enable().
            const token = this._netUsageToken = {};
            loadNetUsage(netUsagePath()).then(({ usage, problem }) => {
                if (problem) console.warn(`ResourcePulse: ${problem}`);
                if (this._netUsageToken === token) this._netUsage = usage;
            });
        }
        this._selfPid = Gio.Credentials.new().get_unix_pid();
        this._uid = Gio.Credentials.new().get_unix_user();
        this._waits = new Map();
        this._alerts = new AlertMonitor();
        this._alertSampled = { dsk: 0, gpu: 0, net: 0, bat: 0, pwr: 0 };
        this._alertCauses = {};
        this._alertProc = null;
        this._causeTimerId = 0;
        this._causeResolve = null;
        this._notifySource = null;

        // Poll state. The generation token invalidates polls that are still
        // awaiting I/O when the extension is disabled or re-enabled.
        this._gen = (this._gen ?? 0) + 1;
        this._pollInFlight = false;
        this._recordPending = false;
        this._lastPollTime = 0;
        this._lastData = null;
        this._deferredPollId = null;
        this._pollDeadlineId = null;
        this._outstanding = {};

        // Time-series history: fixed-capacity buffers owned here, painted by sparklines.
        this._hist = {};
        for (const key of HISTORY_KEYS) this._hist[key] = new RingBuffer(HISTORY_CAPACITY);
        this._histStamp = {};
        // 1 h and 24 h of buckets per key; fixed size, kept across interval changes.
        this._long = {};
        for (const [range, spec] of Object.entries(RANGES)) {
            if (!spec) continue;
            this._long[range] = {};
            for (const key of HISTORY_KEYS) this._long[range][key] = new BucketSeries(spec.bucketUs, spec.capacity);
        }
        this._range = 'live';
        this._sparklines = [];

        // Tooltip state
        this._tooltip = null;
        this._tooltipTexts = {};
        this._bundledIcons = {};

        // Panel indicator
        this._indicator = new PanelMenu.Button(0.0, 'Resource Pulse', false);
        this._indicatorBox = new St.BoxLayout({ style_class: 'resource-pulse-indicator-box' });
        this._indicator.add_child(this._indicatorBox);
        this._topBarWidgets = {};
        this._stageReleaseId = null;

        // Dropdown container
        // Neither this item nor the containers below may be focusable: St
        // never navigates inside a widget that takes focus itself, so Tab and
        // the arrow keys would stop here instead of reaching cards and controls.
        this._menuSection = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, can_focus: false });
        
        // An St.Widget, not a bare Clutter.Actor: keyboard focus navigation
        // (Tab, arrow keys) only descends through St widgets.
        this._popupStack = new St.Widget({
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
            accessible_name: _('Resource Pulse panel'),
            reactive: true,
            x_expand: true,
            y_expand: true
        });

        // Keyboard navigation inside dropdown menu
        this._menuContainer.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape || symbol === Clutter.KEY_BackSpace) {
                if (this._activeTab !== 'overview') {
                    this._activeTab = 'overview';
                    this._updateTabVisibility();
                    return Clutter.EVENT_STOP;
                }
            }
            if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
                const tabs = ['cpu', 'memory', 'battery', 'power', 'disk', 'network', 'thermal', 'gpu'];
                if (this._activeTab !== 'overview') {
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

        // The scrolled child itself carries no padding: before GNOME Shell 49
        // a padded viewport clips picking by its padding at the far edges,
        // leaving a strip on the right and at the bottom that takes no clicks.
        // It is also what the menu's width and height are set on; the padded
        // container fills it.
        this._menuViewport = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
        this._menuViewport.add_child(this._menuContainer);
        this._scrollView.add_child(this._menuViewport);
        this._popupStack.add_child(this._scrollView);

        // Build Corner Resize Handles
        this._buildCornerResizeHandles();

        this._menuSection.add_child(this._popupStack);
        this._indicator.menu.box.add_style_class_name('resource-pulse-popup');
        // Follow the shell's own light/dark style, live.
        this._stSettings = St.Settings.get();
        this._schemeIds = ['notify::color-scheme', 'notify::shell-color-scheme']
            .map(sig => this._stSettings.connect(sig, () => this._applyColorScheme()));
        this._applyColorScheme();
        this._indicator.menu.addMenuItem(this._menuSection);

        // Build UI
        this._activeTab = 'overview';
        this._coreWidgets = null;
        this._procWidgets = [];
        this._buildOverview();
        this._buildDetails();
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
        this._batFmtId = this._settings.connect('changed::battery-top-format', () => { this._rebuildTopBar(); this._poll(); });
        this._netFmtId = this._settings.connect('changed::network-top-format', () => { this._rebuildTopBar(); this._poll(); });
        this._tooltipsId = this._settings.connect('changed::show-tooltips', () => this._hideTooltip());
        this._pollId = this._settings.connect('changed::poll-interval', () => this._startPolling());
        // The panel size is reset from the preferences window: follow it.
        this._sizeId = this._settings.connect('changed::menu-custom-width', () => this._queueDimensionsUpdate());
        this._sizeHId = this._settings.connect('changed::menu-custom-height', () => this._queueDimensionsUpdate());
        // Battery tracking (off until the user starts it in the preferences window).
        this._trackingId = this._settings.connect('changed::battery-tracking', () => this._syncTracking());
        this._flushHistoryId = this._settings.connect('changed::action-flush-history', () => {
            if (!this._settings.get_boolean('action-flush-history')) return;
            this._settings.set_boolean('action-flush-history', false);
            this._tracker?.save();
        });
        this._clearHistoryId = this._settings.connect('changed::action-clear-history', () => {
            if (!this._settings.get_boolean('action-clear-history')) return;
            this._settings.set_boolean('action-clear-history', false);
            if (this._tracker) {
                this._tracker.clear();
            } else {
                saveLedger(ledgerPath(), new BatteryLedger())
                    .catch(e => console.warn(`ResourcePulse: cannot clear the battery history: ${e.message}`));
            }
        });
        this._syncTracking();
        this._openMenuId = this._settings.connect('changed::action-open-menu', () => {
            if (this._settings.get_boolean('action-open-menu')) {
                this._settings.set_boolean('action-open-menu', false);
                this._activeTab = 'overview';
                this._updateTabVisibility();
                this._indicator.menu.open();
            }
        });

        // The panel gives its right side only the room the centre leaves.
        // Re-fit whenever any of the three changes size.
        this._topBarCollapsed = 0;
        this._fitIdleId = 0;
        this._fitSignals = [Main.panel, Main.panel._centerBox, Main.panel._rightBox]
            .filter(actor => actor)
            .map(actor => [actor, actor.connect('notify::allocation', () => this._queueFitTopBar())]);
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
        if (this._sizeId) this._settings.disconnect(this._sizeId);
        if (this._sizeHId) this._settings.disconnect(this._sizeHId);
        if (this._sizeIdleId) GLib.source_remove(this._sizeIdleId);
        if (this._openMenuId) this._settings.disconnect(this._openMenuId);
        for (const id of [this._trackingId, this._flushHistoryId, this._clearHistoryId])
            if (id) this._settings.disconnect(id);
        // Saved with the time of the save: battery used until the next
        // enable (screen lock) is reported as a gap, not attributed.
        this._tracker?.stop();
        this._tracker = null;

        this._gen++;
        this._pollInFlight = false;
        this._lastData = null;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._deferredPollId) {
            GLib.source_remove(this._deferredPollId);
            this._deferredPollId = null;
        }
        if (this._pollDeadlineId) {
            GLib.source_remove(this._pollDeadlineId);
            this._pollDeadlineId = null;
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
        if (this._prefsRetryId) {
            GLib.source_remove(this._prefsRetryId);
            this._prefsRetryId = 0;
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
        this._resizeHandles = {};

        for (const [actor, id] of this._fitSignals ?? []) actor.disconnect(id);
        this._fitSignals = [];
        if (this._fitIdleId) {
            GLib.source_remove(this._fitIdleId);
            this._fitIdleId = 0;
        }

        // Destroying an open menu leaves the shell allocating a disposed BoxPointer.
        this._indicator.menu.close(false);
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
        this._detailBuilders = null;
        this._spanLabel = null;
        this._summaryCards = null;
        this._popupStack = null;
        this._menuContainer = null;
        this._menuViewport = null;
        this._scrollView = null;
        this._shownTab = null;
        this._menuSection = null;
        this._coreWidgets = null;
        this._procWidgets = [];
        this._memProcWidgets = null;
        this._hist = null;
        this._histStamp = null;
        this._sparklines = [];
        this._dskMountRows = null;
        this._netIfaceRows = null;
        this._thmSensorRows = null;
        this._thmFanRows = null;
        this._pwrStats = null;
        this._lastCpu = this._lastMem = this._lastBat = this._lastDsk = null;
        this._lastNet = this._lastThm = this._lastGpu = this._lastPwr = null;
        this._cpu = null;
        this._mem = null;
        this._bat?.destroy();
        this._bat = null;
        if (this._stSettings) {
            for (const id of this._schemeIds) this._stSettings.disconnect(id);
            this._stSettings = null;
            this._schemeIds = null;
        }
        this._proc?.destroy();
        this._proc = null;
        this._pwrScale = null;
        this._netScale = null;
        this._chipFor = null;
        this._lightTheme = undefined;
        this._pwr = null;
        this._dsk = null;
        this._net = null;
        this._thm = null;
        this._gpu?.destroy();
        this._gpu = null;
        if (this._causeTimerId) GLib.source_remove(this._causeTimerId);
        this._causeTimerId = 0;
        this._causeResolve?.();
        this._causeResolve = null;
        this._alertProc?.destroy();
        this._alertProc = null;
        this._notifySource?.destroy();
        this._notifySource = null;
        this._alerts = null;
        if (this._glideId) GLib.source_remove(this._glideId);
        this._glideId = 0;
        this._shownFrom = this._shownTo = this._smoothPrev = null;
        // Counters since the last save; the next enable counts from here.
        if (this._netUsage) this._saveNetUsage();
        this._netUsage = null;
        this._netUsageToken = null;
        for (const [id, resolve] of this._waits ?? []) {
            GLib.source_remove(id);
            resolve(false);
        }
        this._waits = null;
        this._psi = null;
        this._lastPsi = null;
        this._dangerBox = null;

        // Pages are built lazily, so a field left over from the previous
        // session would not be overwritten by the next enable(). Drop them
        // all. _gen survives: it is what invalidates in-flight callbacks.
        const base = this._baseKeys;
        if (base) {
            for (const key of Object.keys(this)) {
                if (key !== '_gen' && !base.has(key)) delete this[key];
            }
        }
        // Module-level state too: what was logged once, cached app names
        // and icons, the installed gettext.
        resetUtils();
        forgetAppInfo();
        resetTranslations();
    }
}

installMethods(ResourcePulseExtension, [SharedMethods, SizingMethods, PollingMethods, TopbarMethods, AlertsMethods, ProcessesMethods, OverviewMethods, DetailsMethods, CpuPage, MemoryPage, BatteryPage, PowerPage, DiskPage, NetworkPage, ThermalPage, GpuPage, DashboardMethods, AccessibilityMethods]);
