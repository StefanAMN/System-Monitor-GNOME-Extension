// The Thermal detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';
import { _ } from '../../../lib/common/i18n.js';
import { VERTICAL } from '../compat.js';

export class ThermalPage {
    _buildThermalDetails() {
        const box = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;' });
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        sparkCard.add_child(new St.Label({ text: _('Temperature History'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._thmSparkline = this._newSparkline('thm', 100, { showGrid: true, color: [1.0, 0.47, 0.0, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._thmSparkline.x_expand = true;
        sparkCard.add_child(this._thmSparkline);
        box.add_child(sparkCard);
        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        statsCard.add_child(new St.Label({ text: _('Components'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._thmSensorsBox = new St.BoxLayout({ ...VERTICAL });
        statsCard.add_child(this._thmSensorsBox);
        box.add_child(statsCard);

        this._thmFansCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        this._thmFansCard.add_child(new St.Label({ text: _('Fans'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._thmFansBox = new St.BoxLayout({ ...VERTICAL });
        this._thmFansCard.add_child(this._thmFansBox);
        box.add_child(this._thmFansCard);
        
        return box;
    }
}
