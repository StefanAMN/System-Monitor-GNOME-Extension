import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

async function readFileAsync(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
            try {
                const [, contents] = obj.load_contents_finish(res);
                const decoder = new TextDecoder('utf-8');
                resolve(decoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

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

export class BatterySampler {
    constructor() {
        this._proxy = null;
        this._batName = null;
    }

    async _detectBatteryName() {
        if (this._batName) return this._batName;
        this._batName = 'BAT0'; // Default fallback
        try {
            const psDir = Gio.File.new_for_path('/sys/class/power_supply');
            const enumerator = await new Promise((resolve, reject) => {
                psDir.enumerate_children_async(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (obj, res) => {
                        try {
                            resolve(obj.enumerate_children_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (name.startsWith('BAT')) {
                    this._batName = name;
                    break;
                }
            }
        } catch (e) {
            // Fail soft
        }
        return this._batName;
    }

    async _initProxy(batName) {
        if (this._proxy) return this._proxy;
        try {
            // Try specific battery first (e.g. battery_BAT1)
            this._proxy = await createDBusProxy(
                Gio.BusType.SYSTEM,
                'org.freedesktop.UPower',
                `/org/freedesktop/UPower/devices/battery_${batName}`,
                'org.freedesktop.UPower.Device'
            );
            return this._proxy;
        } catch (e) {
            try {
                // Fallback to DisplayDevice
                this._proxy = await createDBusProxy(
                    Gio.BusType.SYSTEM,
                    'org.freedesktop.UPower',
                    '/org/freedesktop/UPower/devices/DisplayDevice',
                    'org.freedesktop.UPower.Device'
                );
                return this._proxy;
            } catch (e2) {
                console.error(`Failed to initialize UPower DBus proxy: ${e2.message}`);
                return null;
            }
        }
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
                    let health = 100;
                    if (energyFullDesign > 0) {
                        health = (energyFull / energyFullDesign) * 100;
                    } else {
                        health = getProp('Capacity') ?? 100;
                    }

                    // State map:
                    // 0: Unknown, 1: Charging, 2: Discharging, 3: Empty, 4: Fully charged
                    let state = 'unknown';
                    if (stateVal === 1) state = 'charging';
                    else if (stateVal === 2) state = 'discharging';
                    else if (stateVal === 4) state = 'full';

                    return {
                        present: true,
                        percent: percent,
                        state: state,
                        timeRemaining: state === 'charging' ? timeToFull : timeToEmpty,
                        timeToEmpty: timeToEmpty,
                        timeToFull: timeToFull,
                        health: Math.max(0, Math.min(100, health)),
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
                        } catch (ev) {}

                        energyNow = chargeNow * voltage;
                        energyFull = chargeFull * voltage;
                        energyFullDesign = chargeFullDesign * voltage;
                        const cnCurrentStr = await readFileAsync(`/sys/class/power_supply/${batName}/current_now`);
                        powerNow = parseInt(cnCurrentStr.trim(), 10) || 0;
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
