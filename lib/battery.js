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
    }

    async _initProxy() {
        if (this._proxy) return this._proxy;
        try {
            this._proxy = await createDBusProxy(
                Gio.BusType.SYSTEM,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice',
                'org.freedesktop.UPower.Device'
            );
            return this._proxy;
        } catch (e) {
            console.error(`Failed to initialize UPower DBus proxy: ${e.message}`);
            return null;
        }
    }

    async sample() {
        try {
            const proxy = await this._initProxy();
            if (proxy) {
                const getProp = (name) => {
                    const val = proxy.get_cached_property(name);
                    return val ? val.unpack() : null;
                };

                const isPresent = getProp('IsPresent');
                const type = getProp('Type');

                // UPower device type 2 is battery. DisplayDevice represents combined batteries.
                if (isPresent === true && type === 2) {
                    const percent = getProp('Percentage') ?? 0;
                    const stateVal = getProp('State') ?? 0;
                    const timeToEmpty = getProp('TimeToEmpty') ?? 0;
                    const timeToFull = getProp('TimeToFull') ?? 0;
                    const health = getProp('Capacity') ?? 100;
                    const cycleCount = getProp('CycleCount') ?? 0;
                    const energyRate = getProp('EnergyRate') ?? 0;

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
                        health: health,
                        cycleCount: cycleCount,
                        energyRate: energyRate
                    };
                }
            }
        } catch (e) {
            console.error(`UPower battery sample failed: ${e.message}`);
        }

        // Fallback to sysfs
        return await this._sampleSysfs();
    }

    async _sampleSysfs() {
        try {
            const capacityFile = Gio.File.new_for_path('/sys/class/power_supply/BAT0/capacity');
            if (capacityFile.query_exists(null)) {
                const percentStr = await readFileAsync('/sys/class/power_supply/BAT0/capacity');
                const percent = parseFloat(percentStr.trim()) || 0;

                const statusStr = await readFileAsync('/sys/class/power_supply/BAT0/status');
                const status = statusStr.trim().toLowerCase();

                let cycleCount = 0;
                try {
                    const cycleStr = await readFileAsync('/sys/class/power_supply/BAT0/cycle_count');
                    cycleCount = parseInt(cycleStr.trim(), 10) || 0;
                } catch (e) {}

                let energyNow = 0;
                let energyFull = 0;
                let energyFullDesign = 0;
                let powerNow = 0;

                try {
                    const enStr = await readFileAsync('/sys/class/power_supply/BAT0/energy_now');
                    energyNow = parseInt(enStr.trim(), 10) || 0;
                    const efStr = await readFileAsync('/sys/class/power_supply/BAT0/energy_full');
                    energyFull = parseInt(efStr.trim(), 10) || 0;
                    const efdStr = await readFileAsync('/sys/class/power_supply/BAT0/energy_full_design');
                    energyFullDesign = parseInt(efdStr.trim(), 10) || 0;
                    const pnStr = await readFileAsync('/sys/class/power_supply/BAT0/power_now');
                    powerNow = parseInt(pnStr.trim(), 10) || 0;
                } catch (e) {
                    try {
                        const cnStr = await readFileAsync('/sys/class/power_supply/BAT0/charge_now');
                        energyNow = parseInt(cnStr.trim(), 10) || 0;
                        const cfStr = await readFileAsync('/sys/class/power_supply/BAT0/charge_full');
                        energyFull = parseInt(cfStr.trim(), 10) || 0;
                        const cfdStr = await readFileAsync('/sys/class/power_supply/BAT0/charge_full_design');
                        energyFullDesign = parseInt(cfdStr.trim(), 10) || 0;
                        const cnCurrentStr = await readFileAsync('/sys/class/power_supply/BAT0/current_now');
                        powerNow = parseInt(cnCurrentStr.trim(), 10) || 0;
                    } catch (e2) {}
                }

                let timeRemaining = 0;
                if (status === 'discharging' && powerNow > 0) {
                    timeRemaining = (energyNow / powerNow) * 3600;
                } else if (status === 'charging' && powerNow > 0) {
                    timeRemaining = ((energyFull - energyNow) / powerNow) * 3600;
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
                    energyRate: energyRate
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
            energyRate: 0
        };
    }
}
