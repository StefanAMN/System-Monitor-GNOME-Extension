import Gio from 'gi://Gio';

import { readFileAsync, listDirAsync } from './utils.js';

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

export class BatterySampler {
    constructor() {
        this._proxy = null;
        this._batName = null;
    }

    async _detectBatteryName() {
        if (this._batName) return this._batName;
        this._batName = 'BAT0'; // Default fallback
        const names = await listDirAsync('/sys/class/power_supply');
        const bat = names.filter(n => n.startsWith('BAT')).sort()[0];
        if (bat) this._batName = bat;
        return this._batName;
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
                console.error(`UPower proxy for ${path} failed: ${e.message}`);
            }
        }
        return null;
    }

    destroy() {
        this._proxy = null;
    }

    async sample() {
        const batName = await this._detectBatteryName();
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
                            const cycleStr = await readFileAsync(`/sys/class/power_supply/${batName}/cycle_count`);
                            cycleCount = parseInt(cycleStr.trim(), 10) || 0;
                        } catch (e) {}
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
            console.error(`UPower battery sample failed: ${e.message}`);
        }

        // Fallback to sysfs
        return await this._sampleSysfs(batName);
    }

    async _sampleSysfs(batName) {
        try {
            let capacityExists = false;
            try {
                await readFileAsync(`/sys/class/power_supply/${batName}/capacity`);
                capacityExists = true;
            } catch (e) {}
            if (capacityExists) {
                const percentStr = await readFileAsync(`/sys/class/power_supply/${batName}/capacity`);
                const percent = parseFloat(percentStr.trim()) || 0;

                const statusStr = await readFileAsync(`/sys/class/power_supply/${batName}/status`);
                const status = statusStr.trim().toLowerCase();

                let cycleCount = 0;
                try {
                    const cycleStr = await readFileAsync(`/sys/class/power_supply/${batName}/cycle_count`);
                    cycleCount = parseInt(cycleStr.trim(), 10) || 0;
                } catch (e) {}

                let energyNow = 0;
                let energyFull = 0;
                let energyFullDesign = 0;
                let powerNow = 0;

                try {
                    const enStr = await readFileAsync(`/sys/class/power_supply/${batName}/energy_now`);
                    energyNow = (parseInt(enStr.trim(), 10) || 0) / 1000000;
                    const efStr = await readFileAsync(`/sys/class/power_supply/${batName}/energy_full`);
                    energyFull = (parseInt(efStr.trim(), 10) || 0) / 1000000;
                    const efdStr = await readFileAsync(`/sys/class/power_supply/${batName}/energy_full_design`);
                    energyFullDesign = (parseInt(efdStr.trim(), 10) || 0) / 1000000;
                    const pnStr = await readFileAsync(`/sys/class/power_supply/${batName}/power_now`);
                    powerNow = parseInt(pnStr.trim(), 10) || 0;
                } catch (e) {
                    try {
                        const cnStr = await readFileAsync(`/sys/class/power_supply/${batName}/charge_now`);
                        const chargeNow = (parseInt(cnStr.trim(), 10) || 0) / 1000000;
                        const cfStr = await readFileAsync(`/sys/class/power_supply/${batName}/charge_full`);
                        const chargeFull = (parseInt(cfStr.trim(), 10) || 0) / 1000000;
                        const cfdStr = await readFileAsync(`/sys/class/power_supply/${batName}/charge_full_design`);
                        const chargeFullDesign = (parseInt(cfdStr.trim(), 10) || 0) / 1000000;

                        let voltage = 12.0;
                        try {
                            const voltStr = await readFileAsync(`/sys/class/power_supply/${batName}/voltage_now`);
                            voltage = (parseInt(voltStr.trim(), 10) || 12000000) / 1000000;
                        } catch (ev) {
                            try {
                                const voltMinStr = await readFileAsync(`/sys/class/power_supply/${batName}/voltage_min_design`);
                                voltage = (parseInt(voltMinStr.trim(), 10) || 12000000) / 1000000;
                            } catch (_) {}
                        }

                        energyNow = chargeNow * voltage;
                        energyFull = chargeFull * voltage;
                        energyFullDesign = chargeFullDesign * voltage;
                        const cnCurrentStr = await readFileAsync(`/sys/class/power_supply/${batName}/current_now`);
                        const currentNowUa = parseInt(cnCurrentStr.trim(), 10) || 0;
                        powerNow = Math.round(currentNowUa * voltage);
                    } catch (e2) {}
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
            console.error(`Sysfs battery sample failed: ${e.message}`);
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
