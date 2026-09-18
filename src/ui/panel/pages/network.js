// The Network detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';

export class NetworkPage {
    _buildNetworkDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        
        // Download Sparkline
        const rxCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        rxCard.add_child(new St.Label({ text: 'Download Rate', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._netRxSparkline = this._newSparkline('netRx', 80, { showGrid: true, color: [0.208, 0.518, 0.894, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netRxSparkline.x_expand = true;
        rxCard.add_child(this._netRxSparkline);
        box.add_child(rxCard);

        // Upload Sparkline
        const txCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        txCard.add_child(new St.Label({ text: 'Upload Rate', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._netTxSparkline = this._newSparkline('netTx', 80, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._netTxSparkline.x_expand = true;
        txCard.add_child(this._netTxSparkline);
        box.add_child(txCard);

        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: 'Stats & Session Totals', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._netRx = this._detailRow('Current Download');
        statsCard.add_child(this._netRx.row);
        this._netTx = this._detailRow('Current Upload');
        statsCard.add_child(this._netTx.row);
        this._netSessionRx = this._detailRow('Session Downloaded');
        statsCard.add_child(this._netSessionRx.row);
        this._netSessionTx = this._detailRow('Session Uploaded');
        statsCard.add_child(this._netSessionTx.row);
        // Kept across sessions (network-usage.json); physical interfaces only.
        this._netToday = this._detailRow('Today');
        statsCard.add_child(this._netToday.row);
        this._netMonth = this._detailRow('This month');
        statsCard.add_child(this._netMonth.row);
        box.add_child(statsCard);

        // Per-interface breakdown card
        const ifaceCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        ifaceCard.add_child(new St.Label({ text: 'Interfaces', style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._netIfaceList = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;' });
        ifaceCard.add_child(this._netIfaceList);
        box.add_child(ifaceCard);

        return box;
    }
}
