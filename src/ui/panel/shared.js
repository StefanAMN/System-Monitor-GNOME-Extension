// Small helpers used across the panel: settings getters, the tooltip, metric icons, the press animation, opening System Monitor or the preferences window, detail rows.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { METRICS } from '../../lib/common/settingsmodel.js';
import { PREFS_OPEN_ATTEMPTS, PREFS_RETRY_MS } from './constants.js';
import { sanitizeMetricList } from '../../lib/common/present.js';

export class SharedMethods {
    _hasKey(key) {
        return !!(this._settings && this._settings.settings_schema && this._settings.settings_schema.has_key(key));
    }

    _pinnedMetrics() {
        return sanitizeMetricList(this._settings.get_strv('pinned-metrics'));
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

    /**
     * Light styling is one class on the menu box (and on the tooltip, which
     * lives outside the menu); every colour is resolved in stylesheet.css.
     */
    _applyColorScheme() {
        const light = Main.getStyleVariant?.() === 'light';
        if (light === this._lightTheme) return;
        this._lightTheme = light;
        const box = this._indicator?.menu?.box;
        if (box) {
            if (light) box.add_style_class_name('rp-light');
            else box.remove_style_class_name('rp-light');
        }
        if (this._tooltip) {
            if (light) this._tooltip.add_style_class_name('rp-light');
            else this._tooltip.remove_style_class_name('rp-light');
        }
    }

    _showTooltip(actor, text) {
        if (!this._getBoolean('show-tooltips', true) || (this._indicator && this._indicator.menu.isOpen) || !text) {
            this._hideTooltip();
            return;
        }
        if (!this._tooltip) {
            this._tooltip = new St.Label({
                style_class: this._lightTheme ? 'resource-pulse-tooltip rp-light' : 'resource-pulse-tooltip',
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

    _launchSystemMonitor(targetView = null) {
        try {
            const context = global.create_app_launch_context(0, -1);

            // 1. If a specific tab/view is requested, try launching with appropriate commandline flags
            if (targetView) {
                if (GLib.find_program_in_path('resources')) {
                    const appInfo = Gio.AppInfo.create_from_commandline(`resources -t ${targetView}`, null, Gio.AppInfoCreateFlags.NONE);
                    if (appInfo) {
                        appInfo.launch([], context);
                        return;
                    }
                }
                if (GLib.find_program_in_path('gnome-system-monitor')) {
                    const flag = targetView === 'processes' ? '-p' : '-s';
                    const appInfo = Gio.AppInfo.create_from_commandline(`gnome-system-monitor ${flag}`, null, Gio.AppInfoCreateFlags.NONE);
                    if (appInfo) {
                        appInfo.launch([], context);
                        return;
                    }
                }
                if (GLib.find_program_in_path('mission-center')) {
                    const appInfo = Gio.AppInfo.create_from_commandline('mission-center', null, Gio.AppInfoCreateFlags.NONE);
                    if (appInfo) {
                        appInfo.launch([], context);
                        return;
                    }
                }
            }

            // 2. Try activating via Shell.AppSystem using known system monitor desktop IDs
            const candidateAppIds = [
                'net.nokyan.Resources.desktop',
                'org.gnome.SystemMonitor.desktop',
                'io.missioncenter.MissionCenter.desktop',
                'gnome-system-monitor.desktop',
                'resources.desktop',
                'mission-center.desktop',
                'org.kde.plasma-systemmonitor.desktop',
                'mate-system-monitor.desktop',
                'xfce4-taskmanager.desktop'
            ];

            const appSys = Shell.AppSystem.get_default();
            for (const appId of candidateAppIds) {
                const app = appSys.lookup_app(appId);
                if (app) {
                    app.activate();
                    return;
                }
            }

            // 3. Search all installed applications for system resource/monitor desktop apps
            const allApps = appSys.get_installed ? appSys.get_installed() : [];
            for (const app of allApps) {
                const id = app.get_id() || '';
                if (/resource|system-monitor|mission-center|taskmanager/i.test(id)) {
                    app.activate();
                    return;
                }
            }

            // 4. Try launching available GUI binaries from PATH
            const candidateBinaries = [
                'resources',
                'gnome-system-monitor',
                'mission-center',
                'plasma-systemmonitor',
                'mate-system-monitor',
                'xfce4-taskmanager'
            ];

            for (const bin of candidateBinaries) {
                if (GLib.find_program_in_path(bin)) {
                    const appInfo = Gio.AppInfo.create_from_commandline(bin, null, Gio.AppInfoCreateFlags.NONE);
                    if (appInfo) {
                        appInfo.launch([], context);
                        return;
                    }
                }
            }

            // 5. Fallback to terminal-based system monitors
            const termMonitors = ['htop', 'btop', 'top'];
            for (const tbin of termMonitors) {
                if (GLib.find_program_in_path(tbin)) {
                    const terminals = ['ptyxis', 'gnome-terminal', 'kgx', 'x-terminal-emulator', 'kitty', 'alacritty'];
                    for (const term of terminals) {
                        if (GLib.find_program_in_path(term)) {
                            const termCmd = `${term} -- ${tbin}`;
                            const appInfo = Gio.AppInfo.create_from_commandline(termCmd, null, Gio.AppInfoCreateFlags.NONE);
                            if (appInfo) {
                                appInfo.launch([], context);
                                return;
                            }
                        }
                    }
                }
            }

            console.warn('Resource Pulse: No supported system monitor application found on system.');
        } catch (e) {
            console.error(`Failed to launch System Monitor: ${e.message}`);
        }
    }

    _getIconName(key) {
        return METRICS.find(m => m.key === key)?.icon ?? 'image-missing-symbolic';
    }

    /** An icon shipped in the extension's icons/ directory. */
    _bundledIcon(name) {
        if (!this._bundledIcons[name])
            this._bundledIcons[name] = Gio.icon_new_for_string(`${this.path}/icons/${name}-symbolic.svg`);
        return this._bundledIcons[name];
    }

    /**
     * Point an St.Icon at a metric's icon. No icon theme has a temperature
     * icon, so that one is bundled; the CPU icon comes from the theme where
     * it exists (Yaru, or with GNOME System Monitor installed) and falls
     * back to a bundled one elsewhere.
     */
    _setMetricIcon(icon, key) {
        if (key === 'thermal') {
            icon.gicon = this._bundledIcon('rp-thermal');
            icon.fallback_gicon = null;
        } else {
            icon.icon_name = this._getIconName(key);
            icon.fallback_gicon = key === 'cpu' ? this._bundledIcon('rp-cpu') : null;
        }
        return icon;
    }

    /** @param {function(Clutter.Event): boolean} [skip] presses it accepts do not animate */
    _addClickAnimations(actor, skip = null) {
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

        actor.connect('button-press-event', (_actor, event) => {
            if (skip?.(event)) return Clutter.EVENT_PROPAGATE;
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

    /** Open the preferences window, on a given page ('settings', 'tracking', 'diagnostics'). */
    _openDetailsWindow(page = 'settings') {
        this._settings.set_string('prefs-page', page);
        this._indicator.menu.close();
        this._requestPrefsWindow(PREFS_OPEN_ATTEMPTS);
    }

    /**
     * Ask GNOME's preferences service for the window. The service quits when
     * its last window closes; a request that reaches it while it is quitting
     * fails (seen when the window was closed and opened again within a
     * second). The shell's own openPreferences() drops that error (GNOME
     * 46-49 do not even return it), so the same D-Bus call is made here, the
     * failure logged, and the request sent again: D-Bus starts a new service.
     */
    _requestPrefsWindow(attemptsLeft) {
        const gen = this._gen;
        Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions', 'OpenExtensionPrefs',
            new GLib.Variant('(ssa{sv})', [this.uuid, '', {}]), null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    if (gen !== this._gen) return;
                    if (attemptsLeft <= 1) {
                        console.error(`ResourcePulse: cannot open the preferences window: ${e.message}`);
                        return;
                    }
                    console.warn(`ResourcePulse: opening the preferences window failed (${e.message}); trying again`);
                    this._prefsRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREFS_RETRY_MS, () => {
                        this._prefsRetryId = 0;
                        this._requestPrefsWindow(attemptsLeft - 1);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
    }

    /** Let a label wrap onto further lines instead of ending in an ellipsis. */
    _wrapLabel(label) {
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }

    /** Show a detail row with `text`, or leave it out when there is no reading (null). */
    _setDetailRow(row, text) {
        row.row.visible = text !== null;
        if (text !== null) row.val.text = text;
    }

    _detailRow(labelText, valueText = '--') {
        const row = new St.BoxLayout({ style: 'padding: 4px 0; spacing: 8px;', x_expand: true });
        const lbl = new St.Label({ text: labelText, style_class: 'rp-fg-dim', style: 'font-size: 0.85em;', x_expand: true });
        const val = new St.Label({ text: valueText, style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: 600;' });
        row.add_child(lbl);
        row.add_child(val);
        return { row, lbl, val };
    }
}
