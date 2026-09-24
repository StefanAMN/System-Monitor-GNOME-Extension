// Applying one reading (or one glide frame) to the overview and every built detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import { powerReadout, thermalUnavailable, visibleInterfaces, gpuReadings, na } from '../../lib/common/present.js';
import { _, fill, ngettext } from '../../lib/common/i18n.js';
import { ProgressBar } from './widgets.js';
import { formatBytes, formatSpeed, formatTemp, formatUptime, formatDuration, batteryStateLabel } from '../../lib/common/format.js';

export class DashboardMethods {
    _updateDashboardUI(data, frame = false) {
        if (!this._settings || !this._indicator) return;
        // Pressure: the share of the last 10 s in which programs were stalled.
        for (const [row, key] of [[this._cpuWait, 'cpu'], [this._memWait, 'memory'], [this._dskWait, 'io']]) {
            if (!row) continue;
            const some = data.psi?.[key]?.some;
            row.val.text = Number.isFinite(some)
                ? fill(_('{percent} % of the time'), { percent: some.toFixed(1) })
                : _('n/a (no pressure figures from this kernel)');
        }
        const tempUnit = this._settings.get_string('unit-temp') || 'C';
        const memUnit  = this._settings.get_string('unit-mem')  || 'GB';
        const useGiB   = memUnit === 'GiB';

        // ── CPU ──
        if (data.cpu) {
            const cpu = data.cpu;
            if (this._summaryCards?.cpu) {
                this._summaryCards.cpu.valueLabel.text = `${Math.round(cpu.total)}%`;
                this._summaryCards.cpu.pbar.setPercent(cpu.total);
            }
            if (this._cpuDetailsVal) this._cpuDetailsVal.text = `${Math.round(cpu.total)}%`;

            // Hardware details on Overview
            if (this._hwName) this._hwName.text = cpu.hardwareModel || _('Unknown CPU');
            if (this._hwStats) {
                const parts = [];
                if (cpu.cpuGen) parts.push(cpu.cpuGen);
                if (cpu.coresCount) parts.push(fill(ngettext('{n} core', '{n} cores', cpu.coresCount), { n: cpu.coresCount }));
                const threads = cpu.threadsCount || cpu.cores.length;
                parts.push(fill(ngettext('{n} thread', '{n} threads', threads), { n: threads }));
                this._hwStats.text = parts.join(' · ');
            }
            
            // Vendor badge: identity never changes, so style it once.
            if (this._chipBox && this._chipFor !== cpu.hardwareModel) {
                this._chipFor = cpu.hardwareModel;
                const badge = cpu.vendor === 'amd'
                    ? { bg: '#d22630', top: 'AMD', mid: /ryzen/i.test(cpu.hardwareModel) ? 'RYZEN' : 'CPU', c1: '#f9b8bb', c3: '#ffaaaa' }
                    : cpu.vendor === 'intel'
                        ? { bg: '#0e5fa6', top: 'intel', mid: /^i\d|ultra/i.test(cpu.hardwareModel) ? 'CORE' : 'CPU', c1: '#a0c8f0', c3: '#5bc3ff' }
                        : { bg: '#4a4a55', top: '', mid: 'CPU', c1: '#c0c0c8', c3: '#e0e0e8' };
                this._chipBox.style = `background-color: ${badge.bg}; border-radius: 6px; padding: 6px 10px;`;
                this._chipLabel1.text = badge.top;
                this._chipLabel1.visible = badge.top !== '';
                this._chipLabel1.style = `font-size: 0.65em; color: ${badge.c1}; font-weight: 300;`;
                this._chipLabel2.text = badge.mid;
                this._chipLabel3.text = cpu.tier || '';
                this._chipLabel3.visible = !!cpu.tier;
                this._chipLabel3.style = `font-size: 1.1em; color: ${badge.c3}; font-weight: bold;`;
            }

            if (this._hwUptimeVal) this._hwUptimeVal.text = formatUptime(cpu.uptime);
            if (this._hwLoadVal) this._hwLoadVal.text = cpu.loadavg.join(' · ');
            if (this._hwOsVal) this._hwOsVal.text = cpu.osName || `GNOME ${Config.PACKAGE_VERSION.split('.')[0]}`;

            // Details Stats row
            if (this._cpuDetailsLoad) this._cpuDetailsLoad.text = cpu.loadavg.join(' · ');
            if (this._cpuDetailsFreq && cpu.frequency) this._cpuDetailsFreq.text = cpu.frequency;
            if (this._cpuDetailsUptime) this._cpuDetailsUptime.text = formatUptime(cpu.uptime);

            if (cpu.cores) this._updateCpuCoresUI(cpu.cores, cpu.coreFreqs);
        }

        // ── Memory ──
        if (data.mem) {
            const mem = data.mem;
            if (this._summaryCards?.memory) {
                this._summaryCards.memory.valueLabel.text = `${Math.round(mem.percent)}%`;
                this._summaryCards.memory.pbar.setPercent(mem.percent);
            }
            if (this._memUsed) this._memUsed.val.text =
                `${formatBytes(mem.used, useGiB)} / ${formatBytes(mem.total, useGiB)}`;
            if (this._memAvail) this._memAvail.val.text =
                `${formatBytes(mem.available, useGiB)}`;
            if (this._memBuffersCache) this._memBuffersCache.val.text =
                `${formatBytes(mem.buffers, useGiB)} / ${formatBytes(mem.cached, useGiB)}`;
            if (this._memSwap) this._memSwap.val.text =
                `${Math.round(mem.swapPercent)}% (${formatBytes(mem.swapUsed, useGiB)} / ${formatBytes(mem.swapTotal, useGiB)})`;
            if (this._memSwapActivity) {
                const inStr = mem.swapInRate > 0 ? `${formatBytes(mem.swapInRate, false)}/s` : '0 B/s';
                const outStr = mem.swapOutRate > 0 ? `${formatBytes(mem.swapOutRate, false)}/s` : '0 B/s';
                this._memSwapActivity.val.text = (mem.swapInRate > 0 || mem.swapOutRate > 0)
                    ? fill(_('In: {in} · Out: {out}'), { in: inStr, out: outStr })
                    : _('Idle');
            }
        }

        // ── Battery ──
        if (data.bat) {
            const bat = data.bat;
            const sc = this._summaryCards?.battery;
            if (sc) {
                sc.box.visible = bat.present;
                if (bat.present) {
                    sc.valueLabel.text = `${Math.round(bat.percent)}%`;
                    sc.pbar.setPercent(bat.percent);
                    
                    let stateStr = batteryStateLabel(bat.state);
                    if (bat.timeRemaining > 0)
                        stateStr += ` · ${fill(bat.state === 'charging' ? _('{time} to full') : _('{time} left'), { time: formatDuration(bat.timeRemaining) })}`;
                    sc.statusLbl.text = stateStr;
                }
            }
            if (bat.present) {
                if (this._batState) {
                    this._batState.val.text = batteryStateLabel(bat.state);
                }
                if (this._batTimeEst) {
                    let estText = '--';
                    if (bat.state === 'charging' && (bat.timeToFull > 0 || bat.timeRemaining > 0)) {
                        const t = bat.timeToFull || bat.timeRemaining;
                        const h = Math.floor(t / 3600);
                        const m = Math.floor((t % 3600) / 60);
                        estText = fill(_('{h}h {m}m to full'), { h, m });
                    } else if (bat.state === 'discharging' && (bat.timeToEmpty > 0 || bat.timeRemaining > 0)) {
                        const t = bat.timeToEmpty || bat.timeRemaining;
                        const h = Math.floor(t / 3600);
                        const m = Math.floor((t % 3600) / 60);
                        estText = fill(_('{h}h {m}m remaining'), { h, m });
                    } else if (bat.state === 'full') {
                        estText = _('Fully Charged');
                    }
                    this._batTimeEst.val.text = estText;
                }
                if (this._batHealth) this._batHealth.val.text = `${bat.health.toFixed(1)}%`;
                if (this._activeTab === 'battery') this._refreshTopApp();
                if (this._batCycles) this._batCycles.val.text = `${bat.cycleCount}`;
                if (this._batCapacity) this._batCapacity.val.text = `${bat.energy.toFixed(1)} Wh / ${bat.energyFull.toFixed(1)} Wh`;
                if (this._batDesign) this._batDesign.val.text = `${bat.energyFullDesign.toFixed(1)} Wh`;
            }
        }

        // ── Power ──
        if (data.pwr) {
            const pwr = data.pwr;
            const hasDraw = pwr.raplSupported || pwr.systemPower !== null;
            const sc = this._summaryCards?.power;
            
            const readout = powerReadout(pwr);
            const draw = readout.value ?? 0;
            const drawStr = readout.value === null ? na() : `${draw.toFixed(1)} W`;

            const bat = data.bat;
            const isCharging = bat && bat.present && bat.state === 'charging' && bat.energyRate > 0;

            if (sc) {
                sc.box.visible = true;
                sc.valueLabel.text = drawStr;
                sc.pbar.setPercent(this._pwrScale.percent(draw, GLib.get_monotonic_time()));
                sc.subLabel.visible = true;
                if (isCharging) {
                    sc.subLabel.text = fill(_('Charging (+{watts} W)'), { watts: bat.energyRate.toFixed(1) });
                } else {
                    sc.subLabel.text = readout.value === null ? _('Energy counters not readable') : readout.source;
                }
            }
            if (hasDraw) {
                if (this._pwrSystem)  this._pwrSystem.val.text  = pwr.systemPower  !== null ? `${pwr.systemPower.toFixed(1)} W`  : '--';
                if (this._pwrPackage) this._pwrPackage.val.text = pwr.packagePower !== null ? `${pwr.packagePower.toFixed(1)} W` : '--';
                
                const gpuPwr = data.gpu && data.gpu.present && data.gpu.powerDraw ? data.gpu.powerDraw : null;
                if (this._pwrGpu) this._pwrGpu.val.text = gpuPwr !== null ? `${gpuPwr.toFixed(1)} W` : '--';
                if (this._pwrCharging) {
                    if (isCharging) {
                        this._pwrCharging.val.text = `+${bat.energyRate.toFixed(1)} W`;
                    } else if (bat && bat.present && bat.state === 'full') {
                        this._pwrCharging.val.text = _('0.0 W (Full)');
                    } else {
                        this._pwrCharging.val.text = '--';
                    }
                }
                if (this._pwrPeak) this._pwrPeak.val.text = `${this._pwrStats.peak.toFixed(1)} W`;
                if (this._pwrAvg) this._pwrAvg.val.text = `${this._pwrStats.mean.toFixed(1)} W`;
            }
        }

        // ── Disk ──
        if (data.dsk) {
            const dsk = data.dsk;
            const diskPct = dsk.diskPercent || 0;
            const readMB  = dsk.readRate  / 1000000;
            const writeMB = dsk.writeRate / 1000000;
            const totalMB = readMB + writeMB;

            const sc = this._summaryCards?.disk;
            if (sc) {
                // Same figure as the top bar: space used on the root filesystem.
                const root = dsk.mounts && dsk.mounts[0];
                sc.valueLabel.text = root ? `${Math.round(root.percent)}%` : na();
                sc.pbar.setPercent(root ? root.percent : 0);
                sc.subLabel.visible = true;
                sc.subLabel.text = fill(_('used on / · {busy}% busy'), { busy: Math.round(diskPct) });
            }
            if (this._dskRead)  this._dskRead.val.text  = `${readMB.toFixed(2)} MB/s`;
            if (this._dskWrite) this._dskWrite.val.text = `${writeMB.toFixed(2)} MB/s`;
            if (this._dskUsage) this._dskUsage.val.text = `${Math.round(diskPct)}% (${totalMB.toFixed(1)} MB/s)`;

            // Only a detailed sample has the full mount list.
            if (this._menuOpen && this._activeTab === 'disk' && this._dskMountsBox && dsk.mounts && dsk.detailed) {
                if (!this._dskMountRows) this._dskMountRows = [];
                if (this._dskMountRows.length !== dsk.mounts.length) {
                    this._dskMountsBox.destroy_all_children();
                    this._dskMountRows = [];
                    dsk.mounts.forEach(m => {
                        const row = new St.BoxLayout({ vertical: true, style: 'spacing: 2px;' });
                        const headRow = new St.BoxLayout();
                        const mountLbl = new St.Label({ text: m.mount, style_class: 'rp-fg', style: 'font-size: 0.8em; font-weight: 500;', x_expand: true });
                        const statLbl = new St.Label({ text: '', style_class: 'rp-fg-dim', style: 'font-size: 0.8em;' });
                        headRow.add_child(mountLbl);
                        headRow.add_child(statLbl);
                        row.add_child(headRow);

                        const pbar = new ProgressBar(4, 0.96, 0.83, 0.18);
                        row.add_child(pbar);

                        this._dskMountsBox.add_child(row);
                        this._dskMountRows.push({ mountLbl, statLbl, pbar });
                    });
                }
                dsk.mounts.forEach((m, idx) => {
                    const r = this._dskMountRows[idx];
                    if (r) {
                        r.mountLbl.text = m.mount;
                        r.statLbl.text = `${formatBytes(m.used, useGiB)} / ${formatBytes(m.size, useGiB)} (${Math.round(m.percent)}%)`;
                        r.pbar.setPercent(m.percent);
                    }
                });
            }
        }

        // ── Network ──
        if (data.net) {
            const net = data.net;
            const sc = this._summaryCards?.network;
            if (sc) {
                sc.valueLabel.text = formatSpeed(net.total.rxRate + net.total.txRate);
                sc.pbar.setPercent(this._netScale.percent(net.total.rxRate + net.total.txRate, GLib.get_monotonic_time()));
                sc.subLabel.visible = true;
                sc.subLabel.text = `↓ ${formatSpeed(net.total.rxRate)}   ↑ ${formatSpeed(net.total.txRate)}`;
            }
            if (this._netRx) this._netRx.val.text = formatSpeed(net.total.rxRate);
            if (this._netTx) this._netTx.val.text = formatSpeed(net.total.txRate);
            if (this._netSessionRx) this._netSessionRx.val.text = formatBytes(net.sessionRx || 0, useGiB);
            if (this._netSessionTx) this._netSessionTx.val.text = formatBytes(net.sessionTx || 0, useGiB);
            if (this._netToday) {
                const now = GLib.DateTime.new_now_local();
                const usage = this._netUsage;
                const show = prefix => {
                    const t = usage?.total(prefix);
                    return t ? `↓ ${formatBytes(t.rx, useGiB)}  ↑ ${formatBytes(t.tx, useGiB)}` : '--';
                };
                this._netToday.val.text = show(now.format('%Y-%m-%d'));
                this._netMonth.val.text = show(now.format('%Y-%m'));
            }

            if (this._menuOpen && this._activeTab === 'network' && this._netIfaceList && net.interfaces) {
                const activeIfaces = visibleInterfaces(net.interfaces);
                if (!this._netIfaceRows) this._netIfaceRows = [];
                if (this._netIfaceRows.length !== activeIfaces.length) {
                    this._netIfaceList.destroy_all_children();
                    this._netIfaceRows = [];
                    activeIfaces.forEach(() => {
                        const row = new St.BoxLayout({ style: 'padding: 2px 0;' });
                        const nameLbl = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.8em; font-weight: 500;', width: 80 });
                        const statLbl = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.8em;', x_expand: true });
                        row.add_child(nameLbl);
                        row.add_child(statLbl);
                        this._netIfaceList.add_child(row);
                        this._netIfaceRows.push({ nameLbl, statLbl });
                    });
                }
                activeIfaces.forEach(([name, iface], idx) => {
                    const r = this._netIfaceRows[idx];
                    if (r) {
                        r.nameLbl.text = name;
                        r.statLbl.text = `↓ ${formatSpeed(iface.rxRate)}   ↑ ${formatSpeed(iface.txRate)}`;
                    }
                });
            }
        }

        // ── Thermal ──
        if (data.thm) {
            const thm = data.thm;
            const sc = this._summaryCards?.thermal;
            if (sc) {
                const missing = thermalUnavailable(thm);
                sc.valueLabel.text = missing ? na() : formatTemp(thm.packageTemp, tempUnit);
                sc.pbar.setPercent(missing ? 0 : Math.min(100, thm.packageTemp)); // 100 °C full scale
                sc.subLabel.visible = missing;
                if (missing) sc.subLabel.text = _('No sensor found');
            }
            // A top-bar sample carries only the package sensor; rendering it
            // here would collapse the list to one row until the next detailed one.
            if (this._menuOpen && this._activeTab === 'thermal' && thm.detailed !== false) {
                if (this._thmSensorsBox && thm.sensors) {
                    if (!this._thmSensorRows) this._thmSensorRows = [];
                    if (this._thmSensorRows.length !== thm.sensors.length) {
                        this._thmSensorsBox.destroy_all_children();
                        this._thmSensorRows = [];
                        if (thm.sensors.length > 0) {
                            thm.sensors.forEach(sensor => {
                                const row = this._detailRow(sensor.label, '');
                                this._thmSensorsBox.add_child(row.row);
                                this._thmSensorRows.push(row);
                            });
                        } else {
                            const row = this._detailRow(_('No sensors found'), '--');
                            this._thmSensorsBox.add_child(row.row);
                        }
                    }
                    thm.sensors.forEach((sensor, idx) => {
                        const r = this._thmSensorRows[idx];
                        if (r) {
                            r.lbl.text = sensor.label;
                            r.val.text = formatTemp(sensor.temp, tempUnit);
                        }
                    });
                }
                if (this._thmFansCard && this._thmFansBox && thm.fans) {
                    if (!this._thmFanRows) this._thmFanRows = [];
                    if (thm.fans.length > 0) {
                        this._thmFansCard.visible = true;
                        if (this._thmFanRows.length !== thm.fans.length) {
                            this._thmFansBox.destroy_all_children();
                            this._thmFanRows = [];
                            thm.fans.forEach(fan => {
                                const row = this._detailRow(fan.label, '');
                                this._thmFansBox.add_child(row.row);
                                this._thmFanRows.push(row);
                            });
                        }
                        thm.fans.forEach((fan, idx) => {
                            const r = this._thmFanRows[idx];
                            if (r) {
                                r.lbl.text = fan.label;
                                r.val.text = `${fan.rpm} RPM`;
                            }
                        });
                    } else {
                        this._thmFansCard.visible = false;
                    }
                }
            }
        }

        // ── GPU ──
        if (data.gpu) {
            const gpu = data.gpu;
            const sc = this._summaryCards?.gpu;
            if (sc) {
                sc.box.visible = true;
                if (gpu.present) {
                    sc.valueLabel.text = `${Math.round(gpu.percent)}%`;
                    sc.pbar.setPercent(gpu.percent);
                    sc.subLabel.visible = true;
                    const clockText = gpu.clock ? ` · ${Math.round(gpu.clock)} MHz` : '';
                    sc.subLabel.text = `${gpu.brand || _('GPU')}${clockText}`;
                } else {
                    sc.valueLabel.text = na();
                    sc.pbar.setPercent(0);
                    sc.subLabel.visible = true;
                    sc.subLabel.text = _('No GPU Detected');
                }
            }

            // Without a GPU only the notice is shown, not cards of placeholders.
            if (this._gpuInactiveCard) {
                this._gpuInactiveCard.visible = !gpu.present;
                this._gpuHwCard.visible = gpu.present;
                this._gpuSparkCard.visible = gpu.present;
                this._gpuStatsCard.visible = gpu.present;
            }

            // Update Model / Chip Badge
            if (this._gpuModelName) this._gpuModelName.text = gpu.model || fill(_('{brand} Graphics'), { brand: gpu.brand });
            if (this._gpuDriverDesc) {
                this._gpuDriverDesc.visible = !!gpu.driver;
                this._gpuDriverDesc.text = fill(_('Driver: {driver}'), { driver: gpu.driver || '' });
            }

            if (this._gpuChipBox) {
                const brand = (gpu.brand || '').toLowerCase();
                if (brand.includes('nvidia')) {
                    this._gpuChipBox.style = 'background-color: #76b900; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'NVIDIA';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #223300; font-weight: bold;';
                    this._gpuChipLabel2.text = 'GEFORCE';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #000000; font-weight: bold;';
                } else if (brand.includes('amd')) {
                    this._gpuChipBox.style = 'background-color: #d22630; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'AMD';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #f9b8bb; font-weight: 300;';
                    this._gpuChipLabel2.text = 'RADEON';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold;';
                } else {
                    this._gpuChipBox.style = 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;';
                    this._gpuChipLabel1.text = 'intel';
                    this._gpuChipLabel1.style = 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;';
                    this._gpuChipLabel2.text = 'GRAPHICS';
                    this._gpuChipLabel2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold;';
                }
            }

            // Quick Hardware Sub-Stats: only what this GPU reports.
            const readings = gpuReadings(gpu, tempUnit);
            if (this._gpuHwFields) {
                this._gpuHwFields.clock.visible = readings.clock !== null;
                this._gpuHwFields.temp.visible = readings.temp !== null;
                this._gpuHwFields.power.visible = readings.power !== null;
                this._gpuHwStatsRow.visible = readings.clock !== null || readings.temp !== null || readings.power !== null;
                if (readings.clock !== null) this._gpuHwClockVal.text = readings.clock;
                if (readings.temp !== null) this._gpuHwTempVal.text = readings.temp;
                if (readings.power !== null) this._gpuHwPowerVal.text = readings.power;
            }

            // Sparkline

            // VRAM Card
            if (this._gpuVramCard) {
                if (gpu.memTotal > 0) {
                    this._gpuVramCard.visible = true;
                    if (this._gpuVramPctLbl) this._gpuVramPctLbl.text = `${Math.round(gpu.memPercent)}%`;
                    if (this._gpuVramBar) this._gpuVramBar.setPercent(gpu.memPercent);
                    if (this._gpuVramUsed) {
                        this._gpuVramUsed.val.text = `${formatBytes(gpu.memUsed, useGiB)} / ${formatBytes(gpu.memTotal, useGiB)} (${gpu.memPercent.toFixed(1)}%)`;
                    }
                    if (this._gpuVramFree) {
                        this._gpuVramFree.val.text = formatBytes(gpu.memFree || (gpu.memTotal - gpu.memUsed), useGiB);
                    }
                } else {
                    this._gpuVramCard.visible = false;
                }
            }

            // Stats Card
            if (this._gpuUsage) this._gpuUsage.val.text = `${Math.round(gpu.percent)}%`;
            if (this._gpuCoreClock) {
                this._setDetailRow(this._gpuCoreClock, readings.clock);
                this._setDetailRow(this._gpuTemp, readings.temp);
                this._setDetailRow(this._gpuFan, readings.fan);
                this._setDetailRow(this._gpuPower, readings.power);
            }
        }

        if (!frame) for (const spark of this._sparklines) spark.refresh();

        // ── Top Processes (CPU & Memory tabs) ──
        // A snapshot sorted for the other tab (or taken before the tab was
        // opened) is not shown as if it were current: the list is dimmed
        // until a sample for this tab arrives.
        const lists = {
            cpu: [this._procList, '_procWidgets'],
            memory: [this._memProcList, '_memProcWidgets'],
            disk: [this._dskProcList, '_dskProcWidgets'],
        };
        if (this._menuOpen && lists[this._activeTab]) {
            const [list, widgetsKey] = lists[this._activeTab];
            const fresh = data.procSort === this._activeTab && data.processes.length > 0;
            // Disk: only processes that are reading or writing.
            const rows = this._activeTab === 'disk' ? data.processes.filter(p => p.ioRate > 0) : data.processes;
            if (list) {
                if (fresh) this._renderProcessListUI(list, widgetsKey, rows, this._activeTab);
                list.opacity = fresh ? 255 : 110;
            }
            if (this._activeTab === 'disk' && this._dskProcIdle && fresh) this._dskProcIdle.visible = rows.length === 0;
            if (this._activeTab === 'disk' && this._dskProcNote && fresh) {
                // Unprivileged: other users' counters are not readable. Said, not hidden.
                this._dskProcNote.visible = data.ioDenied > 0;
                this._dskProcNote.text = fill(ngettext(
                    'Your processes only: {n} process of another user (a system service) cannot be read without administrator rights.',
                    'Your processes only: {n} processes of other users (system services) cannot be read without administrator rights.',
                    data.ioDenied), { n: data.ioDenied });
            }
        }
    }
}
