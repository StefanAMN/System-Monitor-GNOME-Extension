// The machine's power-related state, for the diagnostics: battery health
// and charge limit (UPower), power mode (power-profiles-daemon), screen
// backlight (sysfs) and whether CPU energy can be read. Read on demand by
// the preferences window, never polled. All of it works unprivileged; what
// is missing on a machine comes back as null.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readFileAsync, listDirAsync, noteReadError } from './utils.js';
import { PowerSampler } from './power.js';

const UPOWER = 'org.freedesktop.UPower';
const UPOWER_DEVICE_BATTERY = 2;
// power-profiles-daemon has two names; the newer one first.
const PROFILE_SERVICES = [
    ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
    ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
];

function call(bus, name, path, iface, method, params, replyType) {
    return new Promise((resolve, reject) => {
        bus.call(name, path, iface, method, params, replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 2000, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function getAll(name, path, iface) {
    const reply = await call(Gio.DBus.system, name, path, 'org.freedesktop.DBus.Properties', 'GetAll',
        new GLib.Variant('(s)', [iface]), '(a{sv})');
    return reply.recursiveUnpack()[0];
}

/**
 * Battery facts from a UPower device's properties.
 * @returns {?{healthPct: number, cycles: ?number, fullWh: number, chargeLimit: string}}
 *   chargeLimit is 'unsupported', 'off' or 'on'; null when it is not a present battery
 */
export function batteryFromProperties(p) {
    if (!p || p.Type !== UPOWER_DEVICE_BATTERY || p.IsPresent === false || !p.PowerSupply) return null;
    const full = p.EnergyFull ?? 0;
    const design = p.EnergyFullDesign ?? 0;
    const healthPct = design > 0 ? full / design * 100 : (p.Capacity ?? null);
    const cycles = Number.isFinite(p.ChargeCycles) && p.ChargeCycles > 0 ? p.ChargeCycles : null;
    let chargeLimit = 'unsupported';
    if (p.ChargeThresholdSupported) chargeLimit = p.ChargeThresholdEnabled ? 'on' : 'off';
    return { healthPct, cycles, fullWh: full, chargeLimit };
}

/** Backlight level 0..1 of the first backlight device, or null. */
export async function readBacklight(root = '/sys/class/backlight') {
    const names = await listDirAsync(root);
    if (names.length === 0) return null;
    names.sort();
    try {
        const [now, max] = await Promise.all([
            readFileAsync(`${root}/${names[0]}/brightness`),
            readFileAsync(`${root}/${names[0]}/max_brightness`),
        ]);
        const level = parseInt(now, 10) / parseInt(max, 10);
        return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null;
    } catch (e) {
        noteReadError(e);
        return null;
    }
}

async function readBattery() {
    try {
        const [paths] = (await call(Gio.DBus.system, UPOWER, '/org/freedesktop/UPower', UPOWER, 'EnumerateDevices', null, '(ao)'))
            .recursiveUnpack();
        for (const path of paths) {
            const battery = batteryFromProperties(await getAll(UPOWER, path, `${UPOWER}.Device`));
            if (battery) return battery;
        }
    } catch (e) {
        console.warn(`ResourcePulse: UPower battery not readable: ${e.message}`);
    }
    return null;
}

async function readOnBattery() {
    try {
        return !!(await getAll(UPOWER, '/org/freedesktop/UPower', UPOWER)).OnBattery;
    } catch (e) {
        console.warn(`ResourcePulse: UPower not readable: ${e.message}`);
        return false;
    }
}

async function profileService() {
    for (const [name, path] of PROFILE_SERVICES) {
        try {
            const props = await getAll(name, path, name);
            return { name, path, active: props.ActiveProfile ?? null };
        } catch (e) {
            // Not running under this name: try the next one.
            if (!e.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN) && !e.matches?.(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER))
                console.warn(`ResourcePulse: ${name}: ${e.message}`);
        }
    }
    return null;
}

/** The state diagnose() takes. */
export async function readSystemState({ backlightRoot = '/sys/class/backlight' } = {}) {
    const [battery, onBattery, backlight, profile, power] = await Promise.all([
        readBattery(),
        readOnBattery(),
        readBacklight(backlightRoot),
        profileService(),
        new PowerSampler().sample(),
    ]);
    return {
        battery,
        onBattery,
        backlight,
        powerProfile: profile?.active ?? null,
        energyReadable: !!power?.raplSupported,
    };
}

/** Switch the power mode (power-profiles-daemon allows the active user without a password). */
export async function setPowerProfile(value) {
    const service = await profileService();
    if (!service) throw new Error('power-profiles-daemon is not running');
    await call(Gio.DBus.system, service.name, service.path, 'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', [service.name, 'ActiveProfile', new GLib.Variant('s', value)]), null);
}
