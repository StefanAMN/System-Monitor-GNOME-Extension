// The GPU detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { ProgressBar } from '../widgets.js';
import { _, fill } from '../../../lib/common/i18n.js';
import { VERTICAL } from '../compat.js';
import { gpuReadings } from '../../../lib/common/present.js';
import { formatBytes } from '../../../lib/common/format.js';

export class GpuPage {
    _buildGpuDetails() {
        const box = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;' });

        // A machine with several GPUs (a hybrid laptop): a card for each, in
        // place of the cards below.
        this._gpuCardsBox = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;', visible: false });
        this._gpuCards = [];
        this._gpuCardKeys = null;
        box.add_child(this._gpuCardsBox);

        this._gpuHwCard = new St.BoxLayout({
            style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;',
            ...VERTICAL,
            x_expand: true
        });

        const hwTop = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });

        // Brand Chip Badge
        this._gpuChipBox = new St.BoxLayout({
            style: 'background-color: #107c41; border-radius: 6px; padding: 6px 10px;',
            ...VERTICAL
        });
        this._gpuChipLabel1 = new St.Label({ text: 'GEFORCE', style: 'font-size: 0.65em; color: #a0f0c8; font-weight: 300;' });
        this._gpuChipLabel2 = new St.Label({ text: 'RTX', style: 'font-size: 0.9em; color: #ffffff; font-weight: bold;' });
        this._gpuChipBox.add_child(this._gpuChipLabel1);
        this._gpuChipBox.add_child(this._gpuChipLabel2);
        hwTop.add_child(this._gpuChipBox);

        const hwDesc = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 4px;', x_expand: true });
        this._gpuModelName = new St.Label({ text: _('Graphics Processor'), style_class: 'rp-fg', style: 'font-size: 1.05em; font-weight: bold;' });
        // Model names are long ("Intel Alder Lake-UP3 GT2 [Iris Xe Graphics]"):
        // wrap onto a second line instead of cutting the name off.
        this._wrapLabel(this._gpuModelName);
        this._gpuDriverDesc = new St.Label({ text: _('Driver: --'), style_class: 'rp-fg-dim', style: 'font-size: 0.8em;' });
        hwDesc.add_child(this._gpuModelName);
        hwDesc.add_child(this._gpuDriverDesc);
        hwTop.add_child(hwDesc);
        this._gpuHwCard.add_child(hwTop);

        // Hardware Sub Stats (Clock, Temp, Power)
        // Shown per reading: a GPU that reports no temperature has no
        // temperature field, instead of one that reads "--".
        const hwStatsRow = new St.BoxLayout({ style: 'margin-top: 10px; spacing: 16px;', x_expand: true });
        this._gpuHwStatsRow = hwStatsRow;

        const clockBox = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        clockBox.add_child(new St.Label({ text: _('Clock'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._gpuHwClockVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        clockBox.add_child(this._gpuHwClockVal);

        const tempBox = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        tempBox.add_child(new St.Label({ text: _('Temperature'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._gpuHwTempVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        tempBox.add_child(this._gpuHwTempVal);

        const powerBox = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        powerBox.add_child(new St.Label({ text: _('Power'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._gpuHwPowerVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        powerBox.add_child(this._gpuHwPowerVal);

        hwStatsRow.add_child(clockBox);
        hwStatsRow.add_child(tempBox);
        hwStatsRow.add_child(powerBox);
        this._gpuHwFields = { clock: clockBox, temp: tempBox, power: powerBox };
        this._gpuHwCard.add_child(hwStatsRow);
        this._addCardInteractions(this._gpuHwCard);
        box.add_child(this._gpuHwCard);

        // 2. GPU Usage Sparkline Card
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        this._gpuSparkCard = sparkCard;
        sparkCard.add_child(new St.Label({ text: _('GPU Utilization (%)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._gpuSparkline = this._newSparkline('gpu', 100, { showGrid: true, color: [0.2, 0.82, 0.48, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._gpuSparkline.x_expand = true;
        sparkCard.add_child(this._gpuSparkline);
        box.add_child(sparkCard);

        // 3. VRAM Card (if dedicated or shared VRAM reported)
        this._gpuVramCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        const vramHead = new St.BoxLayout({ style: 'margin-bottom: 6px;', y_align: Clutter.ActorAlign.CENTER });
        vramHead.add_child(new St.Label({ text: _('Video Memory (VRAM)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));
        this._gpuVramPctLbl = new St.Label({ text: '--%', style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: bold;' });
        vramHead.add_child(this._gpuVramPctLbl);
        this._gpuVramCard.add_child(vramHead);

        this._gpuVramBar = new ProgressBar(6, 0.2, 0.82, 0.48);
        this._gpuVramCard.add_child(this._gpuVramBar);

        const vramStatsBox = new St.BoxLayout({ ...VERTICAL, style: 'margin-top: 8px;' });
        this._gpuVramUsed = this._detailRow(_('Used / Total'));
        vramStatsBox.add_child(this._gpuVramUsed.row);
        this._gpuVramFree = this._detailRow(_('Free VRAM'));
        vramStatsBox.add_child(this._gpuVramFree.row);
        this._gpuVramCard.add_child(vramStatsBox);
        box.add_child(this._gpuVramCard);

        // 4. Performance & Thermal Stats Card
        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        this._gpuStatsCard = statsCard;
        statsCard.add_child(new St.Label({ text: _('Performance & Sensors'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._gpuUsage = this._detailRow(_('Core Utilization'));
        statsCard.add_child(this._gpuUsage.row);
        this._gpuCoreClock = this._detailRow(_('Core Clock'));
        statsCard.add_child(this._gpuCoreClock.row);
        this._gpuTemp  = this._detailRow(_('Temperature'));
        statsCard.add_child(this._gpuTemp.row);
        this._gpuFan = this._detailRow(_('Fan Speed'));
        statsCard.add_child(this._gpuFan.row);
        this._gpuPower = this._detailRow(_('Power Draw'));
        statsCard.add_child(this._gpuPower.row);
        box.add_child(statsCard);

        // 5. Inactive / None Fallback Notice
        this._gpuInactiveCard = new St.BoxLayout({
            style_class: 'rp-base', style: 'border-radius: 12px; padding: 16px;',
            ...VERTICAL,
            visible: false
        });
        const inactTitle = new St.Label({
            text: _('No Active GPU Detected'),
            style_class: 'rp-fg', style: 'font-size: 1.0em; font-weight: bold; margin-bottom: 6px;'
        });
        const inactMsg = new St.Label({
            text: _('No supported GPU driver (nvidia-smi, amdgpu, i915 or xe)'),
            style_class: 'rp-fg-dim', style: 'font-size: 0.8em;'
        });
        this._wrapLabel(inactMsg);
        this._gpuInactiveCard.add_child(inactTitle);
        this._gpuInactiveCard.add_child(inactMsg);
        box.add_child(this._gpuInactiveCard);

        return box;
    }

    /** The brand badge's colours and words. */
    _styleGpuChip(chip, line1, line2, brandName) {
        const brand = (brandName || '').toLowerCase();
        if (brand.includes('nvidia')) {
            chip.style = 'background-color: #76b900; border-radius: 6px; padding: 6px 10px;';
            line1.text = 'NVIDIA';
            line1.style = 'font-size: 0.65em; color: #223300; font-weight: bold;';
            line2.text = 'GEFORCE';
            line2.style = 'font-size: 0.85em; color: #000000; font-weight: bold;';
        } else if (brand.includes('amd')) {
            chip.style = 'background-color: #d22630; border-radius: 6px; padding: 6px 10px;';
            line1.text = 'AMD';
            line1.style = 'font-size: 0.65em; color: #f9b8bb; font-weight: 300;';
            line2.text = 'RADEON';
            line2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold;';
        } else {
            chip.style = 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;';
            line1.text = 'intel';
            line1.style = 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;';
            line2.text = 'GRAPHICS';
            line2.style = 'font-size: 0.85em; color: #ffffff; font-weight: bold;';
        }
    }

    /** One GPU's card on a machine with several. */
    _newGpuCard(g) {
        const box = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL, x_expand: true });

        const top = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });
        const chip = new St.BoxLayout({ ...VERTICAL });
        const line1 = new St.Label();
        const line2 = new St.Label();
        chip.add_child(line1);
        chip.add_child(line2);
        this._styleGpuChip(chip, line1, line2, g.brand);
        top.add_child(chip);
        const desc = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 4px;', x_expand: true });
        const model = new St.Label({ style_class: 'rp-fg', style: 'font-size: 1.05em; font-weight: bold;', x_expand: true });
        this._wrapLabel(model);
        const driver = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.8em;' });
        desc.add_child(model);
        desc.add_child(driver);
        top.add_child(desc);
        box.add_child(top);

        // Beside the bar, not the name: next to a name that wraps, St measures
        // the row too short and the driver line runs into what follows.
        const loadRow = new St.BoxLayout({ style: 'margin-top: 8px; spacing: 10px;', x_expand: true });
        const bar = new ProgressBar(6, 0.2, 0.82, 0.48);
        bar.y_align = Clutter.ActorAlign.CENTER;
        const load = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER });
        loadRow.add_child(bar);
        loadRow.add_child(load);
        box.add_child(loadRow);

        const details = new St.BoxLayout({ ...VERTICAL });

        // Past GPU_CHARTS GPUs a card has no chart; its readings are still here.
        const hist = this._gpuHistKey(g.key);
        let spark = null;
        if (hist) {
            spark = this._newSparkline(hist, 70, { showGrid: true, color: [0.2, 0.82, 0.48, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
            spark.x_expand = true;
            spark.style = 'margin-top: 8px;';
            spark.accessible_name = fill(_('{chart} over time'), { chart: fill(_('{gpu} usage'), { gpu: g.model || g.brand || _('GPU') }) });
            details.add_child(spark);
        }

        const rows = {
            clock: this._detailRow(_('Core Clock')),
            temp: this._detailRow(_('Temperature')),
            fan: this._detailRow(_('Fan Speed')),
            power: this._detailRow(_('Power Draw')),
            vram: this._detailRow(_('Video Memory (VRAM)')),
        };
        const stats = new St.BoxLayout({ ...VERTICAL, style: 'margin-top: 6px;' });
        for (const row of Object.values(rows)) stats.add_child(row.row);
        details.add_child(stats);
        box.add_child(details);

        this._addCardInteractions(box);
        return { box, top, model, driver, load, loadRow, bar, spark, details, rows };
    }

    /** The cards of a machine with several GPUs; rebuilt only when the set changes. */
    _updateGpuCards(gpus, tempUnit, useGiB) {
        if (!this._gpuCardsBox) return;
        const several = gpus.length > 1;
        this._gpuCardsBox.visible = several;
        if (!several || this._activeTab !== 'gpu') return;
        const keys = gpus.map(g => g.key).join();
        if (keys !== this._gpuCardKeys) {
            const gone = new Set(this._gpuCards.map(card => card.spark));
            this._sparklines = this._sparklines.filter(spark => !gone.has(spark));
            this._gpuCardsBox.destroy_all_children();
            this._gpuCards = gpus.map(g => {
                const card = this._newGpuCard(g);
                this._gpuCardsBox.add_child(card.box);
                return card;
            });
            this._gpuCardKeys = keys;
        }
        gpus.forEach((g, i) => {
            const card = this._gpuCards[i];
            card.model.text = g.model || fill(_('{brand} Graphics'), { brand: g.brand });
            card.driver.visible = !!g.driver;
            card.driver.text = fill(_('Driver: {driver}'), { driver: g.driver || '' });
            card.load.text = g.asleep ? _('asleep') : `${Math.round(g.percent)}%`;
            // A sleeping GPU was not read: nothing to show but that it sleeps.
            card.details.visible = !g.asleep;
            card.bar.visible = !g.asleep;
            // Without the bar the word keeps to the right edge.
            card.load.x_expand = !!g.asleep;
            if (g.asleep) return;
            card.bar.setPercent(g.percent);
            const readings = gpuReadings(g, tempUnit);
            this._setDetailRow(card.rows.clock, readings.clock);
            this._setDetailRow(card.rows.temp, readings.temp);
            this._setDetailRow(card.rows.fan, readings.fan);
            this._setDetailRow(card.rows.power, readings.power);
            this._setDetailRow(card.rows.vram, g.memTotal > 0
                ? `${formatBytes(g.memUsed, useGiB)} / ${formatBytes(g.memTotal, useGiB)} (${Math.round(g.memPercent)}%)`
                : null);
        });
    }
}
