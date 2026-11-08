// The Disk detail page.
// Methods of the extension (installed by extension.js); `this` is the extension.
import St from 'gi://St';
import { _ } from '../../../lib/common/i18n.js';
import { na } from '../../../lib/common/present.js';
import { VERTICAL } from '../compat.js';

export class DiskPage {
    _buildDiskDetails() {
        const box = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 10px;' });
        
        // Read Rate Sparkline
        const readCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        readCard.add_child(new St.Label({ text: _('Read Rate (MB/s)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._dskReadSparkline = this._newSparkline('dskRead', 80, { showGrid: true, color: [0.96, 0.83, 0.18, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskReadSparkline.x_expand = true;
        readCard.add_child(this._dskReadSparkline);
        box.add_child(readCard);

        // Write Rate Sparkline
        const writeCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        writeCard.add_child(new St.Label({ text: _('Write Rate (MB/s)'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 4px;' }));
        this._dskWriteSparkline = this._newSparkline('dskWrite', 80, { showGrid: true, color: [0.88, 0.11, 0.14, 1.0], fillOpacity: 0.1, paddingLeft: 30, paddingBottom: 15 });
        this._dskWriteSparkline.x_expand = true;
        writeCard.add_child(this._dskWriteSparkline);
        box.add_child(writeCard);

        const statsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
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

        const drivesCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        drivesCard.add_child(new St.Label({ text: _('Drive performance'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._dskDriveNote = new St.Label({ text: _('Waiting for drive statistics'), style_class: 'rp-fg-dim', style: 'font-size: 0.85em;' });
        this._wrapLabel(this._dskDriveNote);
        drivesCard.add_child(this._dskDriveNote);
        this._dskDriveList = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 8px;', visible: false });
        this._dskDriveRows = [];
        drivesCard.add_child(this._dskDriveList);
        box.add_child(drivesCard);

        // Top Disk Usage: read + write per process, sampled only on this page.
        const ioCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        ioCard.add_child(new St.Label({ text: _('Top Disk Usage'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 8px;' }));
        const dskSearch = this._buildProcFilter('disk');
        ioCard.add_child(dskSearch.entry);
        this._dskProcList = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 6px;' });
        ioCard.add_child(this._dskProcList);
        ioCard.add_child(dskSearch.noMatch);
        this._dskProcIdle = new St.Label({ text: _('No disk activity'), style_class: 'rp-fg-dim', style: 'font-size: 0.85em;', visible: false });
        this._dskProcIdle.clutter_text.line_wrap = true;
        ioCard.add_child(this._dskProcIdle);
        this._dskProcNote = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.75em; margin-top: 6px;', visible: false });
        this._dskProcNote.clutter_text.line_wrap = true;
        ioCard.add_child(this._dskProcNote);
        this._dskProcEnd = this._buildEndBar();
        this._dskProcList.add_child(this._dskProcEnd.box);
        box.add_child(ioCard);

        // Filesystem Mounts Card
        const mountsCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px;', ...VERTICAL });
        mountsCard.add_child(new St.Label({ text: _('Filesystem Mounts'), style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600; margin-bottom: 6px;' }));
        this._dskMountsBox = new St.BoxLayout({ ...VERTICAL, style: 'spacing: 8px;' });
        mountsCard.add_child(this._dskMountsBox);
        box.add_child(mountsCard);

        return box;
    }

    _updateDriveStats(drives) {
        if (!this._dskDriveList || this._dskDriveSnapshot === drives) return;
        this._dskDriveSnapshot = drives;
        const hasDrives = !!drives?.length;
        this._dskDriveNote.visible = !hasDrives;
        this._dskDriveList.visible = hasDrives;
        if (!hasDrives) {
            this._dskDriveNote.text = drives == null
                ? _('Waiting for drive statistics') : _('No drive statistics available');
            return;
        }
        if (this._dskDriveRows.length !== drives.length ||
            drives.some((drive, i) => drive.name !== this._dskDriveRows[i].name)) {
            this._dskDriveList.destroy_all_children();
            this._dskDriveRows = drives.map(({ name }) => {
                const group = new St.BoxLayout({ ...VERTICAL });
                group.add_child(new St.Label({ text: name, style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: 600;' }));
                const iops = this._detailRow(_('IOPS'));
                const latency = this._detailRow(_('Average request latency'));
                const queue = this._detailRow(_('Average queue depth'));
                for (const detail of [iops, latency, queue]) group.add_child(detail.row);
                this._dskDriveList.add_child(group);
                return { name, iops, latency, queue };
            });
        }
        for (let i = 0; i < drives.length; i++) {
            const drive = drives[i];
            const row = this._dskDriveRows[i];
            row.iops.val.text = Number.isFinite(drive.iops) ? drive.iops.toFixed(2) : na();
            row.latency.val.text = Number.isFinite(drive.latencyMs)
                ? `${drive.latencyMs.toFixed(2)} ms` : drive.iops === 0 ? _('No completed requests') : na();
            row.queue.val.text = Number.isFinite(drive.queueDepth) ? drive.queueDepth.toFixed(2) : na();
        }
    }
}
