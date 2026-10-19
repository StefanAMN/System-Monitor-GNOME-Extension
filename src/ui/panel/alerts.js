// Sustained-threshold alerts: the ⚠ in the top bar, red values, notifications with the cause.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { ProcessSampler } from '../../lib/collectors/process.js';
import { thermalUnavailable } from '../../lib/common/present.js';
import { alertReadings, alertLine } from '../../lib/engine/alerts.js';
import { formatBytes, formatTemp } from '../../lib/common/format.js';
import { PRESSURE_LIMIT, ALERTS } from './constants.js';
import { _, fill } from '../../lib/common/i18n.js';

export class AlertsMethods {
    _updateAlerts(data, now) {
        if (!this._alerts) return;
        const s = this._settings;
        const limits = {
            cpu: s.get_int('threshold-cpu'),
            memory: s.get_int('threshold-mem'),
            thermal: s.get_int('threshold-temp'),
            gpu: s.get_int('threshold-gpu'),
            disk: s.get_int('threshold-disk'),
            pressure: PRESSURE_LIMIT,
        };
        const { raised, cleared } = this._alerts.update(alertReadings(data, limits, thermalUnavailable), now);
        for (const key of cleared) delete this._alertCauses[key];
        for (const key of raised) this._onAlertRaised(key, now);
        if (raised.length || cleared.length) this._showDanger();
    }

    /** The ⚠ in the top bar, and the pinned values of the metrics in alert. */
    _showDanger() {
        if (!this._dangerBox || !this._alerts) return;
        const active = new Set(this._alerts.active().map(a => ALERTS[a.key].tab));
        this._dangerBox.visible = active.size > 0;
        if (active.size > 0) this._nameValues();
        for (const [key, widget] of Object.entries(this._topBarWidgets)) {
            if (!widget.label) continue;
            if (active.has(key)) widget.label.add_style_class_name('resource-pulse-label-danger');
            else widget.label.remove_style_class_name('resource-pulse-label-danger');
        }
    }

    _alertLine(alert, now) {
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const info = ALERTS[alert.key];
        if (alert.key === 'disk') {
            const free = this._lastDsk?.mounts?.[0]?.free;
            const full = fill(_('{name} {percent} % full'), { name: _(info.name), percent: Math.round(alert.value) });
            return free !== undefined
                ? `${full} · ${fill(_('{free} free'), { free: formatBytes(free, this._settings.get_string('unit-mem') === 'GiB') })}`
                : full;
        }
        const format = alert.key === 'thermal' ? v => formatTemp(v, tempUnit) : v => `${Math.round(v)} %`;
        const line = alertLine(alert, now, { name: _(info.name), format });
        const cause = this._alertCauses[alert.key];
        return cause ? `${line} — ${cause}` : line;
    }

    /** Tooltip of the ⚠: one line per metric in alert. */
    _alertText() {
        const now = GLib.get_monotonic_time();
        const lines = this._alerts?.active().map(a => this._alertLine(a, now)) ?? [];
        return lines.length ? lines.join('\n') : _('No alerts');
    }

    async _onAlertRaised(key, now) {
        const gen = this._gen;
        if (key === 'cpu' || key === 'memory') {
            const cause = await this._alertCause(key);
            if (gen !== this._gen || !this._alerts?.isActive(key)) return;
            if (cause) this._alertCauses[key] = cause;
        }
        if (this._settings.get_boolean('alert-notify') && this._alerts.takeNotification(key, now)) {
            const alert = this._alerts.active().find(a => a.key === key);
            if (alert) this._notifyAlert(key, this._alertLine(alert, GLib.get_monotonic_time()));
        }
    }

    /**
     * The process behind a CPU or memory alert: one scan for memory, two a
     * second apart for CPU (rates need a baseline). A separate sampler, so
     * the panel's process list keeps its own baseline.
     */
    async _alertCause(key) {
        this._alertProc ??= new ProcessSampler();
        const memTotal = this._lastMem?.total || 0;
        const byMemory = key === 'memory';
        let result = await this._alertProc.sample(memTotal, byMemory, 1);
        if (!byMemory && result) {
            // disable() ends the wait early through _causeResolve.
            await new Promise(resolve => {
                this._causeResolve = resolve;
                this._causeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._causeTimerId = 0;
                    this._causeResolve = null;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            });
            if (!this._alertProc) return '';
            result = await this._alertProc.sample(memTotal, false, 1);
        }
        this._alertProc?.reset();
        const top = result?.top?.[0];
        if (!top) return '';
        const name = top.count > 1 ? `${top.comm} ×${top.count}` : top.comm;
        // Process CPU is per core (100 = one core), so say it in cores.
        return byMemory
            ? fill(_('{process} using {memory}'), { process: name, memory: formatBytes(top.rssBytes, this._settings.get_string('unit-mem') === 'GiB') })
            : fill(_('{process} using {cores} cores'), { process: name, cores: (top.cpu / 100).toFixed(1) });
    }

    _notifyAlert(key, body) {
        if (!this._notifySource) {
            this._notifySource = new MessageTray.Source({ title: 'Resource Pulse', iconName: 'dialog-warning-symbolic' });
            this._notifySource.connect('destroy', () => {
                this._notifySource = null;
            });
            Main.messageTray.add(this._notifySource);
        }
        const notification = new MessageTray.Notification({ source: this._notifySource, title: _(ALERTS[key].title), body });
        notification.connect('activated', () => {
            if (!this._indicator) return;
            this._activeTab = ALERTS[key].tab;
            this._updateTabVisibility();
            this._indicator.menu.open();
        });
        this._notifySource.addNotification(notification);
    }
}
