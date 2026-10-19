// The Disk detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';
import { _ } from '../../../lib/common/i18n.js';

export class DiskPage {
    _buildDiskDetails() {
        const box = new St.BoxLayout({ vertical: true, style: 'spacing: 10px;' });
        
        // Read Rate Sparkline
        const readCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        readCard.add_child(new St.Label({ text: _('Read Rate (MB/s)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._dskReadSparkline = this._newSparkline('dskRead', 80, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskReadSparkline.x_expand = true;
        readCard.add_child(this._dskReadSparkline);
        box.add_child(readCard);

        // Write Rate Sparkline
        const writeCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        writeCard.add_child(new St.Label({ text: _('Write Rate (MB/s)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._dskWriteSparkline = this._newSparkline('dskWrite', 80, { showGrid: true, color: [0.88, 0.11, 0.14, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskWriteSparkline.x_expand = true;
        writeCard.add_child(this._dskWriteSparkline);
        box.add_child(writeCard);

        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        statsCard.add_child(new St.Label({ text: _('Stats'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._dskRead  = this._detailRow(_('Read rate'));
        statsCard.add_child(this._dskRead.row);
        this._dskWrite = this._detailRow(_('Write rate'));
        statsCard.add_child(this._dskWrite.row);
        this._dskUsage = this._detailRow(_('Busy (active time)'));
        statsCard.add_child(this._dskUsage.row);
        this._dskWait = this._detailRow(_('Waiting for disk'));
        statsCard.add_child(this._dskWait.row);
        box.add_child(statsCard);

        // Top Disk Usage: read + write per process, sampled only on this page.
        const ioCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        ioCard.add_child(new St.Label({ text: _('Top Disk Usage'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 8px;' }));
        const dskSearch = this._buildProcFilter('disk');
        ioCard.add_child(dskSearch.entry);
        this._dskProcList = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        ioCard.add_child(this._dskProcList);
        ioCard.add_child(dskSearch.noMatch);
        this._dskProcIdle = new St.Label({ text: _('None of your processes is reading or writing right now.'), style_class: 'rp-fg-dim', style: 'font-size: 0.85em;', visible: false });
        this._dskProcIdle.clutter_text.line_wrap = true;
        ioCard.add_child(this._dskProcIdle);
        this._dskProcNote = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.75em; margin-top: 6px;', visible: false });
        this._dskProcNote.clutter_text.line_wrap = true;
        ioCard.add_child(this._dskProcNote);
        this._dskProcEnd = this._buildEndBar();
        ioCard.add_child(this._dskProcEnd.box);
        box.add_child(ioCard);

        // Filesystem Mounts Card
        const mountsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', vertical: true });
        mountsCard.add_child(new St.Label({ text: _('Filesystem Mounts'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._dskMountsBox = new St.BoxLayout({ vertical: true, style: 'spacing: 8px;' });
        mountsCard.add_child(this._dskMountsBox);
        box.add_child(mountsCard);

        return box;
    }
}
