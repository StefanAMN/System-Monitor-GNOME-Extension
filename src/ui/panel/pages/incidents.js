// A saved slowdown capture, rendered from the recorder's fixed time slots.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { appInfo } from '../../../lib/common/appnames.js';
import { formatBytes, formatSpeed, formatTemp } from '../../../lib/common/format.js';
import { _, fill, N_, translated } from '../../../lib/common/i18n.js';
import { INCIDENT_METRICS, INCIDENT_PRE_SECONDS, INCIDENT_SLOTS } from '../../../lib/engine/incidents.js';
import { RingBuffer } from '../../../lib/engine/ringbuffer.js';
import { VERTICAL } from '../compat.js';
import { Sparkline } from '../widgets.js';

const TITLES = translated({
    cpu: N_('CPU load'), memory: N_('Memory used'), swap: N_('Swap used'), disk: N_('Disk busy'),
    thermal: N_('Temperature'), cpuWait: N_('CPU wait'), memoryWait: N_('Memory wait'), ioWait: N_('I/O wait'),
});
const TRIGGERS = translated({ manual: N_('Manual'), cpu: N_('CPU pressure'), memory: N_('Memory pressure'), io: N_('I/O pressure') });

const APP_RESOURCES = [
    { title: N_('CPU'), usage: N_('CPU usage (100% per core)'), format: value => percent(value) },
    { title: N_('Memory'), usage: N_('Memory charged'), format: value => formatBytes(value) },
    { title: N_('Disk I/O'), usage: N_('Disk throughput'), format: value => formatSpeed(value) },
];

function percent(value) {
    return fill(_('{value}%'), { value: value.toFixed(1) });
}

function card(spacing) {
    return new St.BoxLayout({
        ...VERTICAL, x_expand: true, style_class: 'rp-surface',
        style: `border-radius: 12px; padding: 12px; spacing: ${spacing}px;`,
    });
}

function heading(text) {
    return new St.Label({ text, style_class: 'rp-fg', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true });
}

function captureLabel(capture) {
    const date = GLib.DateTime.new_from_unix_local(Math.floor(capture.at / 1000));
    return fill(_('{date} · {trigger}'), { date: date?.format('%x %X') ?? _('Unknown time'), trigger: TRIGGERS[capture.trigger] });
}

export class IncidentPage {
    _buildIncidentDetails() {
        const page = new St.BoxLayout({ ...VERTICAL, x_expand: true, style: 'spacing: 10px;' });
        const controls = card(8);
        const description = new St.Label({
            text: _('Each capture keeps one minute before the trigger and 30 seconds after.'),
            style_class: 'rp-fg-dim', x_expand: true,
        });
        this._wrapLabel(description);
        controls.add_child(description);

        this._incidentCaptureButton = new St.Button({
            label: _('Record now'), accessible_name: _('Record now'), style_class: 'rp-range rp-range-on', can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._incidentCaptureButton.connect('clicked', () => {
            if (this._incidents?.active) return;
            if (this._captureIncident()) this._incidentFollowCapture = this._incidents.active?.at;
        });
        controls.add_child(this._incidentCaptureButton);

        this._incidentStatusLabel = new St.Label({ style_class: 'rp-fg', visible: false, x_expand: true });
        this._wrapLabel(this._incidentStatusLabel);
        controls.add_child(this._incidentStatusLabel);
        page.add_child(controls);

        const recent = card(6);
        recent.add_child(heading(_('Recent captures')));
        this._incidentEmpty = new St.Label({ text: _('No captures yet'), style_class: 'rp-fg-dim', x_expand: true });
        recent.add_child(this._incidentEmpty);
        this._incidentList = new St.BoxLayout({ ...VERTICAL, x_expand: true, style: 'spacing: 4px;' });
        recent.add_child(this._incidentList);
        page.add_child(recent);
        this._incidentRows = [];

        this._incidentAppCard = card(6);
        this._incidentAppCard.visible = false;
        this._incidentAppCard.add_child(heading(_('Apps around the trigger')));
        this._incidentAppBody = new St.BoxLayout({ ...VERTICAL, x_expand: true, style: 'spacing: 6px;' });
        this._incidentAppCard.add_child(this._incidentAppBody);
        page.add_child(this._incidentAppCard);

        const timeline = card(6);
        timeline.visible = false;
        timeline.add_child(heading(_('Capture timeline')));
        const legend = new St.Label({
            text: _('Each 2-second slot shows its highest recorded reading. The dashed line marks the trigger. Gaps indicate missing readings.'),
            style_class: 'rp-fg-dim', x_expand: true,
        });
        this._wrapLabel(legend);
        timeline.add_child(legend);
        this._incidentCharts = new Map();
        for (const key of INCIDENT_METRICS) {
            const label = heading(TITLES[key]);
            const chart = new Sparkline(new RingBuffer(INCIDENT_SLOTS), 78, {
                showGrid: true, paddingLeft: 42, paddingRight: 5, paddingBottom: 16,
                gridRows: 2, relativeStartSeconds: -INCIDENT_PRE_SECONDS,
                ...(key === 'thermal' ? { autoScale: true, formatValue: value => formatTemp(value, this._incidentTempUnit) } : {}),
            });
            chart.accessible_role = Atk.Role.IMAGE;
            chart.accessible_name = fill(_('{metric} before and after the trigger'), { metric: TITLES[key] });
            this._incidentCharts.set(key, chart);
            timeline.add_child(label);
            timeline.add_child(chart);
        }
        this._incidentTimeline = timeline;
        page.add_child(timeline);
        return page;
    }

    _updateIncidentApps(capture) {
        this._incidentAppCard.visible = !!capture;
        this._incidentAppBody.destroy_all_children();
        const add = (text, title = false) => {
            const label = title ? heading(text) : new St.Label({ text, style_class: 'rp-fg-dim', x_expand: true });
            this._wrapLabel(label);
            this._incidentAppBody.add_child(label);
        };
        const apps = capture?.apps;
        if (!apps || !apps.scopes.some(Boolean)) {
            if (capture) add(_('App measurements are unavailable for this capture.'));
            return;
        }
        add(_('Pressure shows the apps that waited. Usage ranks resource consumption separately. Wait percentages use the scope with the most wait for each app.'));
        const ranking = (title, list, format, seen, total) => {
            const entries = list.map(app => fill(_('{app} ({value})'), { app: appInfo(app.id).name, value: format(app.value) }));
            const result = entries.join(' · ') || (seen ? _('No activity observed') : _('Unavailable'));
            add(fill(_('{title} · {seen}/{total} scopes\n{result}'), { title, seen, total, result }));
        };
        for (let i = 0; i < APP_RESOURCES.length; i++) {
            const { title, usage, format } = APP_RESOURCES[i];
            const { coverage, recent, wait, usage: users } = apps.resources[i];
            add(_(title), true);
            ranking(_('Wait near trigger (10-second trend)'), recent, percent, coverage[0], apps.scopes[0]);
            ranking(_('Wait after trigger'), wait, percent, coverage[1], apps.scopes[1]);
            ranking(_(usage), users, format, coverage[2], apps.scopes[i === 1 ? 2 : 1]);
        }
        if (apps.estimated) add(_('Some disk rates are estimated from paired, readable process counters.'));
    }

    _updateIncidentPage() {
        if (!this._incidentStatusLabel || !this._incidents || !this._menuOpen || this._activeTab !== 'incidents') return;
        const { active, captures } = this._incidents;
        this._incidentCaptureButton.reactive = !active;
        this._incidentCaptureButton.can_focus = !active;
        this._incidentCaptureButton.opacity = active ? 160 : 255;
        this._incidentStatusLabel.visible = !!active;
        if (active) {
            const seconds = Math.max(0, Math.ceil((active.end - GLib.get_monotonic_time()) / 1e6));
            this._incidentStatusLabel.text = seconds > 0
                ? fill(_('Recording · {seconds} s remaining'), { seconds })
                : _('Finishing capture…');
        }

        const newest = captures[0] ?? null;
        const followed = captures.find(capture => capture.at === this._incidentFollowCapture && capture.trigger === 'manual');
        if (followed) {
            this._incidentSelected = followed;
            this._incidentFollowCapture = undefined;
        } else if (!captures.includes(this._incidentSelected)) {
            this._incidentSelected = newest;
        }
        this._incidentEmpty.visible = captures.length === 0;
        while (this._incidentRows.length > captures.length) this._incidentRows.pop().destroy();
        for (let i = 0; i < captures.length; i++) {
            let button = this._incidentRows[i];
            if (!button) {
                button = new St.Button({
                    style_class: 'rp-range rp-chip-bg', can_focus: true, x_expand: true,
                    toggle_mode: true, accessible_role: Atk.Role.TOGGLE_BUTTON,
                });
                button.connect('clicked', () => {
                    this._incidentSelected = button.capture;
                    this._updateIncidentPage();
                });
                this._incidentRows.push(button);
                this._incidentList.add_child(button);
            }
            const capture = captures[i];
            if (button.capture !== capture) {
                button.capture = capture;
                button.label = captureLabel(capture);
            }
            const selected = this._incidentSelected === capture;
            button.checked = selected;
            if (selected) button.add_style_class_name('rp-range-on');
            else button.remove_style_class_name('rp-range-on');
        }

        const capture = this._incidentSelected;
        this._incidentTimeline.visible = !!capture;
        const tempUnit = this._settings?.get_string('unit-temp') || 'C';
        if (tempUnit !== this._incidentTempUnit) {
            this._incidentTempUnit = tempUnit;
            this._incidentCharts.get('thermal').refresh();
        }
        if (capture === this._incidentChartCapture) return;
        this._incidentChartCapture = capture;
        this._updateIncidentApps(capture);
        if (!capture) return;
        INCIDENT_METRICS.forEach((key, index) => {
            const chart = this._incidentCharts.get(key);
            chart.setSampleSeconds(capture.intervalSeconds);
            chart.history.clear();
            for (let i = 0; i < INCIDENT_SLOTS; i++) {
                const value = capture.rows[i]?.[index];
                if (Number.isFinite(value)) chart.history.push(value);
                else chart.history.pushGap();
            }
            chart.refresh();
        });
    }
}
