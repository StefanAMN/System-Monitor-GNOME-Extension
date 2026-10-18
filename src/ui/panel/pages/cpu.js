// The CPU detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { ProgressBar } from '../widgets.js';

export class CpuPage {
    _buildCpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });

        // CPU Usage Card
        const usageCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        const usageHead = new St.BoxLayout({ style: 'margin-bottom: 4px;' });
        usageHead.add_child(new St.Label({ text: 'CPU Usage', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));
        this._cpuDetailsVal = new St.Label({ text: '--%', style_class: 'rp-c-cpu', style: 'font-size: 1.0em; font-weight: bold;' });
        usageHead.add_child(this._cpuDetailsVal);
        usageCard.add_child(usageHead);

        // CPU Detail Grid Graph
        this._cpuSparkline = this._newSparkline('cpu', 110, {
            showGrid: true,
            color: [0.208, 0.518, 0.894, 1.0],
            fillOpacity: 0.1,
            lineWidth: 1.5,
            paddingLeft: 32,
            paddingBottom: 15,
            paddingTop: 8,
            paddingRight: 8
        });
        this._cpuSparkline.x_expand = true;
        usageCard.add_child(this._cpuSparkline);
        box.add_child(usageCard);

        // Per-Core Usage Card
        const coreCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        coreCard.add_child(new St.Label({ text: 'Per-Core Usage · GHz', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 8px;' }));

        // Two-column layout for cores
        const colsBox = new St.BoxLayout({ style: 'spacing: 16px;' });
        this._cpuCoreCol1 = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        this._cpuCoreCol2 = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        colsBox.add_child(this._cpuCoreCol1);
        colsBox.add_child(this._cpuCoreCol2);
        coreCard.add_child(colsBox);
        box.add_child(coreCard);

        // Details Stats row (3 columns)
        const statsRow = new St.BoxLayout({ style: 'spacing: 8px;', x_expand: true });

        const loadBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rp-surface', style: 'border-radius: 10px; padding: 10px;' });
        loadBox.add_child(new St.Icon({ icon_name: 'system-run-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px; margin-bottom: 4px;' }));
        loadBox.add_child(new St.Label({ text: 'Load Average', style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._cpuDetailsLoad = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        loadBox.add_child(this._cpuDetailsLoad);

        const freqBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rp-surface', style: 'border-radius: 10px; padding: 10px;' });
        freqBox.add_child(new St.Icon({ icon_name: 'power-profile-performance-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px; margin-bottom: 4px;' }));
        freqBox.add_child(new St.Label({ text: 'Frequency', style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._cpuDetailsFreq = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        freqBox.add_child(this._cpuDetailsFreq);

        const uptimeBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'rp-surface', style: 'border-radius: 10px; padding: 10px;' });
        uptimeBox.add_child(new St.Icon({ icon_name: 'preferences-system-time-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px; margin-bottom: 4px;' }));
        uptimeBox.add_child(new St.Label({ text: 'Uptime', style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._cpuDetailsUptime = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        uptimeBox.add_child(this._cpuDetailsUptime);

        statsRow.add_child(loadBox);
        statsRow.add_child(freqBox);
        statsRow.add_child(uptimeBox);
        box.add_child(statsRow);

        const waitCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        this._cpuWait = this._detailRow('Waiting for CPU');
        waitCard.add_child(this._cpuWait.row);
        box.add_child(waitCard);

        // Top CPU Usage Card
        const procCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        const procHead = new St.BoxLayout({ style: 'margin-bottom: 8px;', y_align: Clutter.ActorAlign.CENTER });
        procHead.add_child(new St.Label({ text: 'Top CPU Usage', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));

        const showAllBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 20px; padding: 4px 10px;', label: 'Show All', reactive: true, can_focus: true });
        showAllBtn.child.style_class = 'rp-fg-dim';
        showAllBtn.child.style = 'font-size: 0.75em;';
        showAllBtn.connect('clicked', () => {
            this._launchSystemMonitor('processes');
            this._indicator.menu.close();
        });
        this._addClickAnimations(showAllBtn);
        procHead.add_child(showAllBtn);
        procCard.add_child(procHead);

        this._procList = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        procCard.add_child(this._procList);
        this._procEnd = this._buildEndBar();
        procCard.add_child(this._procEnd.box);
        box.add_child(procCard);

        return box;
    }

    _updateCpuCoresUI(cores, coreFreqs = []) {
        if (!this._cpuCoreCol1 || !this._cpuCoreCol2) return;
        
        if (!this._coreWidgets || this._coreWidgets.length !== cores.length) {
            this._cpuCoreCol1.destroy_all_children();
            this._cpuCoreCol2.destroy_all_children();
            this._coreWidgets = [];
            
            cores.forEach((load, i) => {
                const row = new St.BoxLayout({ style: 'spacing: 6px;', y_align: Clutter.ActorAlign.CENTER });
                const lbl = new St.Label({ text: `Core ${i}`, style_class: 'rp-fg-dim', style: 'font-size: 0.78em;', width: 44 });
                const pbar = new ProgressBar(5, 0.18, 0.76, 0.494);
                pbar.x_expand = true;
                // Unit lives in the card title; with it every row was wider than the
                // menu and the usage bar collapsed to nothing.
                const freqLbl = new St.Label({ text: '', style_class: 'rp-fg-muted', style: 'font-size: 0.72em; text-align: right;', width: 26 });
                freqLbl.x_align = Clutter.ActorAlign.END;
                const val = new St.Label({ text: `${Math.round(load)}%`, style_class: 'rp-fg', style: 'font-size: 0.78em; font-weight: 600; text-align: right;', width: 30 });
                val.x_align = Clutter.ActorAlign.END;

                row.add_child(lbl);
                row.add_child(pbar);
                row.add_child(freqLbl);
                row.add_child(val);

                if (i % 2 === 0) {
                    this._cpuCoreCol1.add_child(row);
                } else {
                    this._cpuCoreCol2.add_child(row);
                }
                this._coreWidgets.push({ pbar, freqLbl, val });
            });
        }
        
        cores.forEach((load, i) => {
            if (this._coreWidgets[i]) {
                const w = this._coreWidgets[i];
                w.pbar.setPercent(load);
                if (load > 75) {
                    w.pbar.setColor(0.88, 0.11, 0.14); // Red
                } else if (load > 40) {
                    w.pbar.setColor(0.96, 0.83, 0.18); // Amber
                } else {
                    w.pbar.setColor(0.18, 0.76, 0.494); // Green
                }
                if (coreFreqs[i]) w.freqLbl.text = coreFreqs[i].replace(' GHz', '');
                w.val.text = `${Math.round(load)}%`;
            }
        });
    }
}
