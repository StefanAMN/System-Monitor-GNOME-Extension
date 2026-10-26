import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { fillWindow } from './ui/prefs/window.js';
import { migrateSettings } from './lib/common/utils.js';
import { setTranslations } from './lib/common/i18n.js';

// Settings only from the Extensions app; the panel's Tracking and
// Diagnostics tabs only when the panel opens the window (ui/prefs/window.js).
export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // ExtensionPreferences has bound the domain (metadata's gettext-domain).
        setTranslations(this.gettext.bind(this), this.ngettext.bind(this));
        const settings = this.getSettings();
        migrateSettings(settings);
        fillWindow(window, { settings, path: this.path });
    }
}
