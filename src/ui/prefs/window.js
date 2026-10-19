// The preferences window's content. GTK side (preferences process).
//
// Opened from the Extensions app it holds the settings only. Opened from the
// panel (⋮, the battery line) it also has the Tracking and Diagnostics tabs
// and a button back to the panel. The panel says it is the one asking by
// setting `prefs-page` just before it opens the window; the Extensions app
// never sets it. When the window is already open (GNOME then only raises
// it), the same key adds the panel's tabs on the spot.
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { buildPreferences, metricIcon } from './rows.js';
import { buildBackupGroup } from './backup.js';
import { HistorySource, buildTrackingPage } from './tracking.js';
import { buildDiagnosticsPage } from './diagnostics.js';
import { styleWindow } from './style.js';
import { TRACK_INTERVAL_S } from '../../lib/engine/batterytracker.js';
import { readSystemState } from '../../lib/collectors/systemstate.js';
import { _ } from '../../lib/common/i18n.js';

function findHeaderBar(widget) {
    if (!widget) return null;
    if (widget instanceof Adw.HeaderBar || widget instanceof Gtk.HeaderBar) return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findHeaderBar(child);
        if (found) return found;
    }
    return null;
}

/**
 * @param {Adw.PreferencesWindow} window
 * @param {object} opts
 * @param {Gio.Settings} opts.settings
 * @param {string} opts.path the extension's directory (icons)
 * @param {string} [opts.historyPath] battery history file, for tests
 * @param {object} [opts.tracking] extra options for buildTrackingPage, for tests
 * @param {object} [opts.diagnostics] options for buildDiagnosticsPage, for tests
 * @returns {{panelPages: function(): boolean, dispose: function()}}
 */
export function fillWindow(window, { settings, path, historyPath, tracking: trackingOpts = {}, diagnostics: diagnosticsOpts = {} }) {
    const page = new Adw.PreferencesPage({ title: _('Settings'), name: 'settings', icon_name: 'preferences-system-symbolic' });
    window.add(page);
    window.set_default_size(720, 760);
    styleWindow(window);
    const built = buildPreferences(page, settings, undefined, key => metricIcon(key, path));
    buildBackupGroup(page, settings);

    // The mark in the header (a name would crowd the tabs); the panel's
    // back button joins it when the panel's tabs are added.
    let header = null;
    let backButton = null;
    const decorate = () => {
        header ??= findHeaderBar(window);
        if (!header) return false;
        if (!header.rpMark) {
            header.rpMark = new Gtk.Image({
                gicon: Gio.icon_new_for_string(`${path}/icons/rp-cpu-symbolic.svg`),
                css_classes: ['rp-brand-icon'], valign: Gtk.Align.CENTER, margin_start: 4,
                tooltip_text: 'Resource Pulse',
            });
            header.pack_start(header.rpMark);
        }
        if (panel && !backButton) {
            backButton = new Gtk.Button({ icon_name: 'go-previous-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: _('Back to the panel') });
            backButton.connect('clicked', () => {
                settings.set_boolean('action-open-menu', true);
                window.close();
            });
            // Before the mark: back is the first thing in the header.
            header.remove(header.rpMark);
            header.pack_start(backButton);
            header.pack_start(header.rpMark);
        }
        return true;
    };
    let decorateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        decorateId = 0;
        decorate();
        return GLib.SOURCE_REMOVE;
    });

    // The panel's tabs: battery tracking and diagnostics, from the history
    // the extension saves. Added once.
    let panel = null;
    const addPanelPages = () => {
        if (panel) return;
        const history = new HistorySource(settings, historyPath);
        let fullWh = null;
        const tracking = buildTrackingPage(settings, history, { fullWh: () => fullWh, ...trackingOpts });
        window.add(tracking.page);
        const diagnostics = buildDiagnosticsPage(history, diagnosticsOpts);
        window.add(diagnostics.page);
        (diagnosticsOpts.readState ?? readSystemState)().then(state => {
            fullWh = state.battery?.fullWh ?? null;
            if (panel) tracking.render();
        }, e => console.error(`ResourcePulse: ${e.message}`));
        // Current figures now, and as tracking goes on while the window is open.
        history.requestFlush();
        const flushId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TRACK_INTERVAL_S, () => {
            history.requestFlush();
            return GLib.SOURCE_CONTINUE;
        });
        panel = { history, tracking, diagnostics, flushId };
        if (!decorateId) decorate();
    };

    // The panel asks for a page: show its tabs and that page.
    const takeRequest = () => {
        const wanted = settings.get_string('prefs-page');
        if (!wanted) return;
        addPanelPages();
        window.set_visible_page_name(wanted);
        settings.set_string('prefs-page', '');
        window.present();
    };
    takeRequest();
    const requestId = settings.connect('changed::prefs-page', takeRequest);

    const dispose = () => {
        settings.disconnect(requestId);
        if (decorateId) GLib.source_remove(decorateId);
        decorateId = 0;
        built.dispose();
        if (panel) {
            GLib.source_remove(panel.flushId);
            panel.tracking.dispose();
            panel.diagnostics.dispose();
            panel.history.dispose();
            panel = null;
        }
    };
    window.connect('close-request', () => {
        dispose();
        return false;
    });
    return { panelPages: () => !!panel, dispose };
}
