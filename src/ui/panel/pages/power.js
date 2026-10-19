// The Power detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';
import { _ } from '../../../lib/common/i18n.js';

export class PowerPage {
    _buildPowerDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        sparkCard.add_child(new St.Label({ text: _('Draw History'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._pwrSparkline = this._newSparkline('pwr', 100, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._pwrSparkline.x_expand = true;
        sparkCard.add_child(this._pwrSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: _('Stats'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._pwrSystem  = this._detailRow(_('System Draw'));
        statsCard.add_child(this._pwrSystem.row);
        this._pwrPackage = this._detailRow(_('CPU Package'));
        statsCard.add_child(this._pwrPackage.row);
        this._pwrGpu     = this._detailRow(_('GPU Draw'));
        statsCard.add_child(this._pwrGpu.row);
        this._pwrCharging = this._detailRow(_('Charging Rate'));
        statsCard.add_child(this._pwrCharging.row);
        this._pwrPeak    = this._detailRow(_('Session Peak'));
        statsCard.add_child(this._pwrPeak.row);
        this._pwrAvg     = this._detailRow(_('Session Avg'));
        statsCard.add_child(this._pwrAvg.row);
        box.add_child(statsCard);
        return box;
    }
}
