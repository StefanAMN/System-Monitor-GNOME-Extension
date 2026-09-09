import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { buildPreferences, metricIcon } from './ui/prefsrows.js';
import { HistorySource, buildTrackingPage } from './ui/prefsbattery.js';
import { buildDiagnosticsPage } from './ui/prefsdiagnostics.js';
import { TRACK_INTERVAL_S } from './lib/batterytracker.js';
import { readSystemState } from './lib/systemstate.js';
import { styleWindow } from './ui/prefsstyle.js';
import Gio from 'gi://Gio';

export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // 1. Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            name: 'settings',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(page);
        window.set_default_size(720, 760);
        styleWindow(window);

        // Closing the window just closes it. Only the explicit back button
        // below returns to the panel menu.
        // 1.5. Inject a small back button into the top-left HeaderBar
        function findHeaderBar(w) {
            if (!w) return null;
            if (w.constructor.name === 'HeaderBar' || w.constructor.$gtype?.name === 'AdwHeaderBar') return w;
            let child = w.get_first_child();
            while (child) {
                const res = findHeaderBar(child);
                if (res) return res;
                child = child.get_next_sibling();
            }
            return null;
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const headerBar = findHeaderBar(window);
            if (headerBar) {
                const backBtn = new Gtk.Button({
                    icon_name: 'go-previous-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER
                });
                backBtn.connect('clicked', () => {
                    settings.set_boolean('action-open-menu', true);
                    window.close();
                });
                headerBar.pack_start(backBtn);
                // The extension's mark in the header (a name would crowd the tabs).
                headerBar.pack_start(new Gtk.Image({
                    gicon: Gio.icon_new_for_string(`${this.path}/icons/rp-cpu-symbolic.svg`),
                    css_classes: ['rp-brand-icon'], valign: Gtk.Align.CENTER, margin_start: 4,
                    tooltip_text: 'Resource Pulse',
                }));
            }
            return GLib.SOURCE_REMOVE;
        });

        // 2. The rows, from the same settings model as the panel menu's page.
        const built = buildPreferences(page, settings, undefined, key => metricIcon(key, this.path));

        // 3. Battery tracking and diagnostics, from the history the extension saves.
        const history = new HistorySource(settings);
        let fullWh = null;
        const tracking = buildTrackingPage(settings, history, { fullWh: () => fullWh });
        window.add(tracking.page);
        const diagnostics = buildDiagnosticsPage(history);
        window.add(diagnostics.page);
        readSystemState().then(state => {
            fullWh = state.battery?.fullWh ?? null;
            tracking.render();
        }, e => console.error(`ResourcePulse: ${e.message}`));
        // Current figures now, and as tracking goes on while the window is open.
        history.requestFlush();
        const flushId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TRACK_INTERVAL_S, () => {
            history.requestFlush();
            return GLib.SOURCE_CONTINUE;
        });

        // The panel can ask for a page (its battery line opens Tracking).
        const wanted = settings.get_string('prefs-page');
        if (wanted) {
            window.set_visible_page_name(wanted);
            settings.set_string('prefs-page', '');
        }

        window.connect('close-request', () => {
            GLib.source_remove(flushId);
            built.dispose();
            tracking.dispose();
            diagnostics.dispose();
            history.dispose();
            return false;
        });
    }
}
