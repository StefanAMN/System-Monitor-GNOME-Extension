// The Battery detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { appInfo as ledgerAppInfo } from '../../../lib/common/appnames.js';
import { _, fill } from '../../../lib/common/i18n.js';
import { batteryStateLabel } from '../../../lib/common/format.js';
import { VERTICAL } from '../compat.js';

export class BatteryPage {
    _buildBatteryDetails() {
        const box = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;' });
        
        // Percent History
        const sparkCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        sparkCard.add_child(new St.Label({ text: _('Charge Level History (%)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._batSparkline = this._newSparkline('bat', 90, { showGrid: true, color: [0.18, 0.76, 0.494, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._batSparkline.x_expand = true;
        sparkCard.add_child(this._batSparkline);
        box.add_child(sparkCard);

        // Power Rate History (W)
        const rateCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        rateCard.add_child(new St.Label({ text: _('Charge/Discharge Rate (W)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._batRateSparkline = this._newSparkline('batRate', 90, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._batRateSparkline.x_expand = true;
        rateCard.add_child(this._batRateSparkline);
        box.add_child(rateCard);

        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        statsCard.add_child(new St.Label({ text: _('Stats'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._batState  = this._detailRow(_('State'));
        statsCard.add_child(this._batState.row);
        this._batTimeEst = this._detailRow(_('Time Estimate'));
        statsCard.add_child(this._batTimeEst.row);
        this._batHealth = this._detailRow(_('Health'));
        statsCard.add_child(this._batHealth.row);
        this._batCycles = this._detailRow(_('Cycle Count'));
        statsCard.add_child(this._batCycles.row);
        this._batCapacity = this._detailRow(_('Current / Full'));
        statsCard.add_child(this._batCapacity.row);
        this._batDesign = this._detailRow(_('Design Capacity'));
        statsCard.add_child(this._batDesign.row);
        box.add_child(statsCard);

        // Each battery, when there is more than one; the figures above are
        // for all of them together.
        this._batListCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL, visible: false });
        this._batListCard.add_child(new St.Label({ text: _('Batteries'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._batListBox = new St.BoxLayout({ ...VERTICAL });
        this._batListCard.add_child(this._batListBox);
        this._batListNames = null;
        box.add_child(this._batListCard);

        // Battery use per app lives in the details window; one line here.
        this._batTopApp = new St.Button({ style_class: 'rp-surface rp-top-app', reactive: true, can_focus: true, x_expand: true });
        const topBox = new St.BoxLayout({ style: 'spacing: 10px;', x_expand: true });
        topBox.add_child(new St.Icon({ icon_name: 'battery-level-70-symbolic', style_class: 'rp-c-battery', style: 'icon-size: 16px;', y_align: Clutter.ActorAlign.CENTER }));
        this._batTopAppLabel = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.85em;', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._wrapLabel(this._batTopAppLabel);
        topBox.add_child(this._batTopAppLabel);
        topBox.add_child(new St.Icon({ icon_name: 'go-next-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px;', y_align: Clutter.ActorAlign.CENTER }));
        this._batTopApp.set_child(topBox);
        this._batTopApp.connect('clicked', () => this._openDetailsWindow('tracking'));
        this._batTopAppStamp = null;
        box.add_child(this._batTopApp);
        this._refreshTopApp();
        return box;
    }

    /**
     * The Battery page's line about the app that used the battery most today.
     * Recomputed only when the tracker has taken a new sample.
     */
    _refreshTopApp() {
        if (!this._batTopAppLabel) return;
        // Read out as its line of text.
        const show = (text, opens = true) => {
            this._batTopAppLabel.text = text;
            this._batTopApp.accessible_name = opens ? fill(_('{line} Opens the Tracking page.'), { line: text }) : text;
        };
        const stamp = this._tracker ? (this._tracker.lastSample ?? 'starting') : 'off';
        if (stamp === this._batTopAppStamp) return;
        this._batTopAppStamp = stamp;
        if (!this._tracker) {
            show(_('Battery use per app: tracking is off. Open the Tracking page to start it.'), false);
            return;
        }
        const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
        const sum = this._tracker.ledger?.summarize({ from: today, batteryOnly: true });
        const top = sum?.apps.find(a => !a.id.startsWith('@') && a.cpu > 0);
        if (!top) {
            show(_('Battery use per app: no time on battery recorded today yet.'));
            return;
        }
        const name = ledgerAppInfo(top.id).name;
        const share = sum.hasEnergy
            ? (sum.attributedWh > 0 ? top.wh / sum.attributedWh : 0)
            : (sum.cpu > 0 ? top.cpu / sum.cpu : 0);
        show(fill(sum.hasEnergy
            ? _('Top app on battery today: {app} ({share} % of the processor\'s energy).')
            : _('Top app on battery today: {app} ({share} % of the processor\'s time).'), { app: name, share: Math.round(share * 100) }));
    }

    /** The Batteries card: one row per battery, rebuilt when the set changes. */
    _updateBatteryList(bat) {
        if (!this._batListCard) return;
        const list = bat?.batteries ?? [];
        this._batListCard.visible = list.length > 1;
        if (list.length < 2) return;
        const names = list.map(b => b.name).join();
        if (names !== this._batListNames) {
            this._batListBox.destroy_all_children();
            this._batListRows = list.map(b => {
                const row = this._detailRow(b.name);
                this._batListBox.add_child(row.row);
                return row;
            });
            this._batListNames = names;
        }
        list.forEach((b, i) => {
            this._batListRows[i].val.text = fill(_('{percent}% · {state} · health {health}%'),
                { percent: Math.round(b.percent), state: batteryStateLabel(b.state), health: Math.round(b.health) });
        });
    }
}
