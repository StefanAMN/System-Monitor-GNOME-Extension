// What differs between the GNOME Shell versions the extension runs on
// (46-51), in one place. Shell side only.
import Clutter from 'gi://Clutter';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

export const SHELL_MAJOR = Number(Config.PACKAGE_VERSION.split('.')[0]);

// A vertical St.BoxLayout: `orientation` since GNOME 48, where `vertical`
// was deprecated; GNOME 51 removed `vertical`. Spread into the parameters:
// new St.BoxLayout({ ...VERTICAL, style: ... }).
export const VERTICAL = SHELL_MAJOR >= 48 ? { orientation: Clutter.Orientation.VERTICAL } : { vertical: true };

/** Close a popup menu at once, without its animation. */
export function closeMenuNow(menu) {
    // GNOME 51 takes an options object; earlier versions an animation
    // flag, where false is BoxPointer.PopupAnimation.NONE.
    if (SHELL_MAJOR >= 51) menu.close({ animate: false });
    else menu.close(false);
}
