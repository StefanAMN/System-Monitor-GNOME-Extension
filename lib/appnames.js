// Display name and icon for an app id of the battery ledger. Gio only, so
// both the shell and the preferences window can use it.
import Gio from 'gi://Gio';

const PSEUDO = {
    '@system': ['System services', 'emblem-system-symbolic'],
    '@other': ['Kernel and other users', 'computer-symbolic'],
    '@more': ['Other apps', 'view-more-symbolic'],
    terminal: ['Terminal', 'utilities-terminal-symbolic'],
};
const SERVICES = {
    'org.gnome.Shell': 'GNOME Shell',
    'org.freedesktop.IBus.session.GNOME': 'Input methods (IBus)',
    'xdg-desktop-portal': 'Desktop portal',
    'xdg-desktop-portal-gnome': 'Desktop portal (GNOME)',
    pipewire: 'PipeWire (sound)',
    'pipewire-pulse': 'PipeWire (sound)',
    wireplumber: 'WirePlumber (sound)',
    dbus: 'Message bus',
};
const CACHE_LIMIT = 500;
const cache = new Map();

function desktopInfo(id) {
    try {
        return Gio.DesktopAppInfo.new(`${id}.desktop`);
    } catch (_) {
        // Not a valid desktop id (a service name, say): there is no entry.
        return null;
    }
}

/**
 * @param {string} id ledger app id
 * @returns {{name: string, gicon: ?Gio.Icon, iconName: ?string}}
 */
export function appInfo(id) {
    let info = cache.get(id);
    if (info) return info;
    if (PSEUDO[id]) {
        info = { name: PSEUDO[id][0], gicon: null, iconName: PSEUDO[id][1] };
    } else {
        // Snaps name their desktop file <snap>_<app>.desktop.
        const entry = desktopInfo(id) ?? (id.startsWith('snap.') ? desktopInfo(`${id.slice(5)}_${id.slice(5)}`) : null);
        if (entry) info = { name: entry.get_display_name() || entry.get_name() || id, gicon: entry.get_icon(), iconName: null };
        else if (SERVICES[id]) info = { name: SERVICES[id], gicon: null, iconName: 'system-run-symbolic' };
        else info = { name: id.startsWith('snap.') ? id.slice(5) : id, gicon: null, iconName: 'application-x-executable-symbolic' };
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(id, info);
    return info;
}
