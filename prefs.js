import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { fillWindow } from './ui/prefswindow.js';

// Settings only from the Extensions app; the panel's Tracking and
// Diagnostics tabs only when the panel opens the window (ui/prefswindow.js).
export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        fillWindow(window, { settings: this.getSettings(), path: this.path });
    }
}
