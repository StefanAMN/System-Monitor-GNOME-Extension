// The Memory detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class MemoryPage {
    _buildMemoryDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: 'Memory Usage', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._memSparkline = this._newSparkline('mem', 100, { showGrid: true, color: [0.569, 0.255, 0.675, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._memSparkline.x_expand = true;
        sparkCard.add_child(this._memSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._memUsed = this._detailRow('Used / Total');
        statsCard.add_child(this._memUsed.row);
        this._memAvail = this._detailRow('Available');
        statsCard.add_child(this._memAvail.row);
        this._memBuffersCache = this._detailRow('Buffers / Cache');
        statsCard.add_child(this._memBuffersCache.row);
        this._memSwap = this._detailRow('Swap');
        statsCard.add_child(this._memSwap.row);
        this._memSwapActivity = this._detailRow('Swap Activity');
        statsCard.add_child(this._memSwapActivity.row);
        this._memWait = this._detailRow('Waiting for memory');
        statsCard.add_child(this._memWait.row);
        box.add_child(statsCard);

        const memProcCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        const memProcHead = new St.BoxLayout({ style: 'margin-bottom: 8px;', y_align: Clutter.ActorAlign.CENTER });
        memProcHead.add_child(new St.Label({ text: 'Top Memory Usage', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));
        const memShowAllBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 20px; padding: 4px 10px;', label: 'Show All', reactive: true, can_focus: true });
        memShowAllBtn.child.style_class = 'rp-fg-dim';
        memShowAllBtn.child.style = 'font-size: 0.75em;';
        memShowAllBtn.connect('clicked', () => {
            this._launchSystemMonitor('processes');
            this._indicator.menu.close();
        });
        this._addClickAnimations(memShowAllBtn);
        memProcHead.add_child(memShowAllBtn);
        memProcCard.add_child(memProcHead);
        this._memProcList = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        memProcCard.add_child(this._memProcList);
        this._memProcEnd = this._buildEndBar();
        memProcCard.add_child(this._memProcEnd.box);
        box.add_child(memProcCard);

        return box;
    }
}
