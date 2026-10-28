import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readFileAsync, listDirAsync, noteReadError, logOnce } from '../common/utils.js';

function createDBusProxy(busType, name, objectPath, interfaceName) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            busType,
            Gio.DBusProxyFlags.NONE,
            null,
            name,
            objectPath,
            interfaceName,
            null,
            (source, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    resolve(proxy);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

// org.freedesktop.UPower.Device State
const UPOWER_STATES = ['unknown', 'charging', 'discharging', 'empty', 'full', 'not charging', 'not charging'];

/** Collector state string for an org.freedesktop.UPower.Device State value. */
export function upowerState(value) {
    return UPOWER_STATES[value] ?? 'unknown';
}

/** Battery health: full-charge capacity as a share of design capacity, 0-100. */
export function batteryHealth(energyFull, energyFullDesign, fallback = 100) {
    const h = energyFullDesign > 0 ? (energyFull / energyFullDesign) * 100 : fallback;
    return Math.max(0, Math.min(100, h));
}

/**
 * One reading for several batteries (a laptop with a second, removable one):
 * charge from the summed energy, health from the summed capacities, the time
 * estimate from the summed rate. `batteries` lists each one for the Battery
 * page. With one battery, its reading as it is.
 * @param {object[]} list readings, each with its `name` (BAT0, BAT1)
 * @returns {?object} null when none is present
 */
export function combineBatteries(list) {
    const present = list.filter(b => b?.present);
    if (present.length === 0) return null;
    if (present.length === 1) return present[0];
    const sum = key => present.reduce((total, b) => total + (b[key] || 0), 0);
    const energy = sum('energy');
    const energyFull = sum('energyFull');
    const energyFullDesign = sum('energyFullDesign');
    const energyRate = sum('energyRate');
    const states = present.map(b => b.state);
    const state = states.includes('charging') ? 'charging'
        : states.includes('discharging') ? 'discharging'
            : states.every(st => st === 'full') ? 'full' : states[0];
    const percent = energyFull > 0 ? (energy / energyFull) * 100 : sum('percent') / present.length;
    const timeToEmpty = state === 'discharging' && energyRate > 0 ? Math.round((energy / energyRate) * 3600) : 0;
    const timeToFull = state === 'charging' && energyRate > 0 ? Math.round(((energyFull - energy) / energyRate) * 3600) : 0;
    return {
        present: true,
        percent,
        state,
        timeRemaining: state === 'charging' ? timeToFull : timeToEmpty,
        timeToEmpty,
        timeToFull,
        health: batteryHealth(energyFull, energyFullDesign, sum('health') / present.length),
        cycleCount: Math.max(...present.map(b => b.cycleCount || 0)),
        energyRate,
        energy,
        energyFull,
        energyFullDesign,
        batteries: present.map(b => ({ name: b.name, percent: b.percent, state: b.state, health: b.health, cycleCount: b.cycleCount })),
    };
}

// Batteries are looked for again this often: a dock or a removable second
// battery can come and go.
const DETECT_EVERY_US = 60e6;

export class BatterySampler {
    /** @param {string} [sysRoot] the sysfs root (a fixture in the unit tests) */
    constructor(sysRoot = '/sys') {
        this._supply = `${sysRoot}/class/power_supply`;
        this._proxy = null;
        this._batName = null;
        this._batNames = [];
        this._lastDetect = 0;
    }

    /** Every battery's name, BAT0 first; the first is the one UPower is asked about. */
    async _detectBatteries() {
        const now = GLib.get_monotonic_time();
        if (this._batName && now - this._lastDetect < DETECT_EVERY_US) return this._batNames;
        this._lastDetect = now;
        const names = (await listDirAsync(this._supply)).filter(n => n.startsWith('BAT')).sort();
        this._batNames = names;
        this._batName = names[0] ?? 'BAT0';
        return names;
    }

    async _initProxy(batName) {
        if (this._proxy) return this._proxy;
        // A proxy for a non-existent object path is created without error and
        // simply has no cached properties, so check before settling on it.
        const paths = [
            `/org/freedesktop/UPower/devices/battery_${batName}`,
            '/org/freedesktop/UPower/devices/DisplayDevice'
        ];
        for (const path of paths) {
            try {
                const proxy = await createDBusProxy(
                    Gio.BusType.SYSTEM, 'org.freedesktop.UPower', path, 'org.freedesktop.UPower.Device');
                if (proxy.get_cached_property('IsPresent') !== null) {
                    this._proxy = proxy;
                    return proxy;
                }
            } catch (e) {
                logOnce(`UPower proxy for ${path} failed: ${e.message}`, 'error');
            }
        }
        return null;
    }

    destroy() {
        this._proxy = null;
    }

    async sample() {
        const names = await this._detectBatteries();
        if (names.length > 1) {
            const each = [];
            for (const name of names) each.push(await this._sampleSysfs(name));
            const combined = combineBatteries(each);
            if (combined) return combined;
        }
        const batName = this._batName;
        try {
            const proxy = await this._initProxy(batName);
            if (proxy) {
                const getProp = (name) => {
                    const val = proxy.get_cached_property(name);
                    return val ? val.unpack() : null;
                };

                const isPresent = getProp('IsPresent');
                const type = getProp('Type');

                // UPower device type 2 is battery
                if (isPresent === true && type === 2) {
                    const percent = getProp('Percentage') ?? 0;
                    const stateVal = getProp('State') ?? 0;
                    const timeToEmpty = getProp('TimeToEmpty') ?? 0;
                    const timeToFull = getProp('TimeToFull') ?? 0;
                    let cycleCount = getProp('CycleCount') ?? 0;
                    if (cycleCount === 0) {
                        try {
                            const cycleStr = await readFileAsync(`${this._supply}/${batName}/cycle_count`);
                            cycleCount = parseInt(cycleStr.trim(), 10) || 0;
                        } catch (e) { noteReadError(e); }
                    }
                    const energyRate = getProp('EnergyRate') ?? 0;

                    // Wh energy capacity figures
                    const energy = getProp('Energy') ?? 0;
                    const energyFull = getProp('EnergyFull') ?? 0;
                    const energyFullDesign = getProp('EnergyFullDesign') ?? 0;

                    // Calculate real wear-based battery health
                    const health = batteryHealth(energyFull, energyFullDesign, getProp('Capacity') ?? 100);

                    const state = upowerState(stateVal);

                    return {
                        present: true,
                        percent: percent,
                        state: state,
                        timeRemaining: state === 'charging' ? timeToFull : timeToEmpty,
                        timeToEmpty: timeToEmpty,
                        timeToFull: timeToFull,
                        health,
                        cycleCount: cycleCount,
                        energyRate: energyRate,
                        energy: energy,
                        energyFull: energyFull,
                        energyFullDesign: energyFullDesign
                    };
                }
            }
        } catch (e) {
            logOnce(`UPower battery sample failed: ${e.message}`, 'error');
        }

        // Fallback to sysfs
        return await this._sampleSysfs(batName);
    }

    async _sampleSysfs(batName) {
        try {
            let percentStr = null;
            try {
                percentStr = await readFileAsync(`${this._supply}/${batName}/capacity`);
            } catch (e) { noteReadError(e); }
            if (percentStr !== null) {
                const percent = parseFloat(percentStr.trim()) || 0;

                const statusStr = await readFileAsync(`${this._supply}/${batName}/status`);
                const status = statusStr.trim().toLowerCase();

                let cycleCount = 0;
                try {
                    const cycleStr = await readFileAsync(`${this._supply}/${batName}/cycle_count`);
                    cycleCount = parseInt(cycleStr.trim(), 10) || 0;
                } catch (e) { noteReadError(e); }

                let energyNow = 0;
                let energyFull = 0;
                let energyFullDesign = 0;
                let powerNow = 0;

                try {
                    const enStr = await readFileAsync(`${this._supply}/${batName}/energy_now`);
                    energyNow = (parseInt(enStr.trim(), 10) || 0) / 1000000;
                    const efStr = await readFileAsync(`${this._supply}/${batName}/energy_full`);
                    energyFull = (parseInt(efStr.trim(), 10) || 0) / 1000000;
                    const efdStr = await readFileAsync(`${this._supply}/${batName}/energy_full_design`);
                    energyFullDesign = (parseInt(efdStr.trim(), 10) || 0) / 1000000;
                    const pnStr = await readFileAsync(`${this._supply}/${batName}/power_now`);
                    // Some drivers sign the figure by direction; `status` says which.
                    powerNow = Math.abs(parseInt(pnStr.trim(), 10) || 0);
                } catch (e) {
                    try {
                        const cnStr = await readFileAsync(`${this._supply}/${batName}/charge_now`);
                        const chargeNow = (parseInt(cnStr.trim(), 10) || 0) / 1000000;
                        const cfStr = await readFileAsync(`${this._supply}/${batName}/charge_full`);
                        const chargeFull = (parseInt(cfStr.trim(), 10) || 0) / 1000000;
                        const cfdStr = await readFileAsync(`${this._supply}/${batName}/charge_full_design`);
                        const chargeFullDesign = (parseInt(cfdStr.trim(), 10) || 0) / 1000000;

                        let voltage = 12.0;
                        try {
                            const voltStr = await readFileAsync(`${this._supply}/${batName}/voltage_now`);
                            voltage = (parseInt(voltStr.trim(), 10) || 12000000) / 1000000;
                        } catch (ev) {
                            try {
                                const voltMinStr = await readFileAsync(`${this._supply}/${batName}/voltage_min_design`);
                                voltage = (parseInt(voltMinStr.trim(), 10) || 12000000) / 1000000;
                            } catch (_) { noteReadError(_); }
                        }

                        energyNow = chargeNow * voltage;
                        energyFull = chargeFull * voltage;
                        energyFullDesign = chargeFullDesign * voltage;
                        const cnCurrentStr = await readFileAsync(`${this._supply}/${batName}/current_now`);
                        const currentNowUa = parseInt(cnCurrentStr.trim(), 10) || 0;
                        powerNow = Math.abs(Math.round(currentNowUa * voltage));
                    } catch (e2) { noteReadError(e2); }
                }

                let timeRemaining = 0;
                if (status === 'discharging' && powerNow > 0) {
                    timeRemaining = (energyNow / (powerNow / 1000000)) * 3600;
                } else if (status === 'charging' && powerNow > 0) {
                    timeRemaining = ((energyFull - energyNow) / (powerNow / 1000000)) * 3600;
                }

                let health = 100;
                if (energyFullDesign > 0) {
                    health = (energyFull / energyFullDesign) * 100;
                }

                const energyRate = powerNow / 1000000;

                return {
                    present: true,
                    name: batName,
                    percent: percent,
                    state: status,
                    timeRemaining: Math.round(timeRemaining),
                    health: Math.max(0, Math.min(100, health)),
                    cycleCount: cycleCount,
                    energyRate: energyRate,
                    energy: energyNow,
                    energyFull: energyFull,
                    energyFullDesign: energyFullDesign
                };
            }
        } catch (e) {
            logOnce(`Sysfs battery sample failed: ${e.message}`, 'error');
        }

        return {
            present: false,
            percent: 0,
            state: 'unknown',
            timeRemaining: 0,
            health: 0,
            cycleCount: 0,
            energyRate: 0,
            energy: 0,
            energyFull: 0,
            energyFullDesign: 0
        };
    }
}
