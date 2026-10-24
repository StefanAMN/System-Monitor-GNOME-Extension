import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { fillWindow } from './ui/prefs/window.js';
import { setTranslations } from './lib/common/i18n.js';

// Settings and About from the Extensions app; the panel's Tracking and
// Diagnostics tabs only when the panel opens the window (ui/prefs/window.js).
export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // ExtensionPreferences has bound the domain (metadata's gettext-domain).
        setTranslations(this.gettext.bind(this), this.ngettext.bind(this));
        fillWindow(window, { settings: this.getSettings(), path: this.path, metadata: this.metadata });
    }
}
