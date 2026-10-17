// The Network detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';
import { _ } from '../../../lib/common/i18n.js';
import { VERTICAL } from '../compat.js';

export class NetworkPage {
    _buildNetworkDetails() {
        const box = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;' });
        
        // Download Sparkline
        const rxCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        rxCard.add_child(new St.Label({ text: _('Download Rate'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._netRxSparkline = this._newSparkline('netRx', 80, { showGrid: true, color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netRxSparkline.x_expand = true;
        rxCard.add_child(this._netRxSparkline);
        box.add_child(rxCard);

        // Upload Sparkline
        const txCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        txCard.add_child(new St.Label({ text: _('Upload Rate'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._netTxSparkline = this._newSparkline('netTx', 80, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netTxSparkline.x_expand = true;
        txCard.add_child(this._netTxSparkline);
        box.add_child(txCard);

        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        statsCard.add_child(new St.Label({ text: _('Stats & Session Totals'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._netRx = this._detailRow(_('Current Download'));
        statsCard.add_child(this._netRx.row);
        this._netTx = this._detailRow(_('Current Upload'));
        statsCard.add_child(this._netTx.row);
        this._netSessionRx = this._detailRow(_('Session Downloaded'));
        statsCard.add_child(this._netSessionRx.row);
        this._netSessionTx = this._detailRow(_('Session Uploaded'));
        statsCard.add_child(this._netSessionTx.row);
        // Kept across sessions (network-usage.json); physical interfaces only.
        this._netToday = this._detailRow(_('Today'));
        statsCard.add_child(this._netToday.row);
        this._netMonth = this._detailRow(_('This month'));
        statsCard.add_child(this._netMonth.row);
        box.add_child(statsCard);

        // Per-interface breakdown card
        const ifaceCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        ifaceCard.add_child(new St.Label({ text: _('Interfaces'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._netIfaceList = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 4px;' });
        ifaceCard.add_child(this._netIfaceList);
        box.add_child(ifaceCard);

        return box;
    }
}
