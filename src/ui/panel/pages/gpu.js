// The GPU detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { ProgressBar } from '../widgets.js';
import { _ } from '../../../lib/common/i18n.js';

export class GpuPage {
    _buildGpuDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });

        this._gpuHwCard = new St.BoxLayout({
            style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;',
            vertical: true,
            x_expand: true
        });

        const hwTop = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });

        // Brand Chip Badge
        this._gpuChipBox = new St.BoxLayout({
            style: 'background-color: #107c41; border-radius: 6px; padding: 6px 10px;',
            vertical: true
        });
        this._gpuChipLabel1 = new St.Label({ text: 'GEFORCE', style: 'font-size: 0.65em; color: #a0f0c8; font-weight: 300;' });
        this._gpuChipLabel2 = new St.Label({ text: 'RTX', style: 'font-size: 0.9em; color: #ffffff; font-weight: bold;' });
        this._gpuChipBox.add_child(this._gpuChipLabel1);
        this._gpuChipBox.add_child(this._gpuChipLabel2);
        hwTop.add_child(this._gpuChipBox);

        const hwDesc = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;', x_expand: true });
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

        const clockBox = new St.BoxLayout({ vertical: true, x_expand: true });
        clockBox.add_child(new St.Label({ text: _('Clock'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._gpuHwClockVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        clockBox.add_child(this._gpuHwClockVal);

        const tempBox = new St.BoxLayout({ vertical: true, x_expand: true });
        tempBox.add_child(new St.Label({ text: _('Temperature'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._gpuHwTempVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 0.95em; font-weight: bold;' });
        tempBox.add_child(this._gpuHwTempVal);

        const powerBox = new St.BoxLayout({ vertical: true, x_expand: true });
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
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        this._gpuSparkCard = sparkCard;
        sparkCard.add_child(new St.Label({ text: _('GPU Utilization (%)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._gpuSparkline = this._newSparkline('gpu', 100, { showGrid: true, color: [0.2, 0.82, 0.48, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._gpuSparkline.x_expand = true;
        sparkCard.add_child(this._gpuSparkline);
        box.add_child(sparkCard);

        // 3. VRAM Card (if dedicated or shared VRAM reported)
        this._gpuVramCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        const vramHead = new St.BoxLayout({ style: 'margin-bottom: 6px;', y_align: Clutter.ActorAlign.CENTER });
        vramHead.add_child(new St.Label({ text: _('Video Memory (VRAM)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));
        this._gpuVramPctLbl = new St.Label({ text: '--%', style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: bold;' });
        vramHead.add_child(this._gpuVramPctLbl);
        this._gpuVramCard.add_child(vramHead);

        this._gpuVramBar = new ProgressBar(6, 0.2, 0.82, 0.48);
        this._gpuVramCard.add_child(this._gpuVramBar);

        const vramStatsBox = new St.BoxLayout({ vertical: true, style: 'margin-top: 8px;' });
        this._gpuVramUsed = this._detailRow(_('Used / Total'));
        vramStatsBox.add_child(this._gpuVramUsed.row);
        this._gpuVramFree = this._detailRow(_('Free VRAM'));
        vramStatsBox.add_child(this._gpuVramFree.row);
        this._gpuVramCard.add_child(vramStatsBox);
        box.add_child(this._gpuVramCard);

        // 4. Performance & Thermal Stats Card
        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
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
            vertical: true,
            visible: false
        });
        const inactTitle = new St.Label({
            text: _('No Active GPU Detected'),
            style_class: 'rp-fg', style: 'font-size: 1.0em; font-weight: bold; margin-bottom: 6px;'
        });
        const inactMsg = new St.Label({
            text: _('GPU telemetry requires NVIDIA proprietary drivers (nvidia-smi), AMD GPU sysfs (amdgpu), or Intel DRM driver (i915/xe).'),
            style_class: 'rp-fg-dim', style: 'font-size: 0.8em;'
        });
        this._wrapLabel(inactMsg);
        this._gpuInactiveCard.add_child(inactTitle);
        this._gpuInactiveCard.add_child(inactMsg);
        box.add_child(this._gpuInactiveCard);

        return box;
    }
}
