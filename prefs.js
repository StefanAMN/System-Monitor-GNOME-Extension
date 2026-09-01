import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { buildPreferences } from './ui/prefsrows.js';

export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // 1. Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(page);

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
            }
            return GLib.SOURCE_REMOVE;
        });

        // 2. The rows, from the same settings model as the panel menu's page.
        const built = buildPreferences(page, settings);
        window.connect('close-request', () => {
            built.dispose();
            return false;
        });
    }
}
