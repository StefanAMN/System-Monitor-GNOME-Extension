// The detail-page frame: header, range slider, and lazy component pages.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

import { RANGES } from '../../lib/engine/longhistory.js';
import { _, fill, N_, translated } from '../../lib/common/i18n.js';
import { VERTICAL } from './compat.js';

// The detail pages' titles, as on the overview cards.
const RANGE_ORDER = Object.keys(RANGES);
const LAST_RANGE = RANGE_ORDER.length - 1;

const RangeSlider = GObject.registerClass({
    GTypeName: 'ResourcePulseRangeSlider',
}, class RangeSlider extends Slider {
    // GNOME 51's binding pool calls these before the key-event vfunc.
    _moveLeft() {
        this.stepStop(this.get_text_direction() === Clutter.TextDirection.RTL ? 1 : -1);
    }

    _moveRight() {
        this.stepStop(this.get_text_direction() === Clutter.TextDirection.RTL ? -1 : 1);
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Home) this.selectStop(0);
        else if (key === Clutter.KEY_End) this.selectStop(LAST_RANGE);
        else if (key === Clutter.KEY_Left) this._moveLeft();
        else if (key === Clutter.KEY_Right) this._moveRight();
        else return super.vfunc_key_press_event(event);
        return Clutter.EVENT_STOP;
    }
});

const PAGE_TITLES = translated({
    cpu: N_('CPU'), memory: N_('Memory'), battery: N_('Battery'), power: N_('Power'),
    disk: N_('Disk'), network: N_('Network'), thermal: N_('Thermal'), gpu: N_('GPU'),
    incidents: N_('Slowdowns'),
});

export class DetailsMethods {
    _buildDetails() {
        this._detailArea = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'resource-pulse-detail-area',
            x_expand: true,
            y_expand: true
        });

        // Top bar for CPU detail header (matches Right Panel header)
        this._detailHeader = new St.BoxLayout({ style: 'margin-bottom: 14px; spacing: 6px;', y_align: Clutter.ActorAlign.CENTER });

        const backBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 99px; padding: 6px;', reactive: true, can_focus: true, accessible_name: _('Back to the overview') });
        this._detailBackBtn = backBtn;
        backBtn.add_child(new St.Icon({ icon_name: 'go-previous-symbolic', style_class: 'rp-fg', style: 'icon-size: 16px;' }));
        backBtn.connect('clicked', () => {
            this._activeTab = 'overview';
            this._updateTabVisibility();
        });

        this._detailHeaderTitleBox = new St.BoxLayout({ style: 'spacing: 8px;', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._detailHeaderIcon = this._setMetricIcon(new St.Icon({ style_class: 'rp-c-cpu', style: 'icon-size: 18px;' }), 'cpu');
        this._detailHeaderTitle = new St.Label({ text: _('CPU'), style_class: 'rp-fg', style: 'font-size: 1.1em; font-weight: bold;' });
        this._detailHeaderTitleBox.add_child(this._detailHeaderIcon);
        this._detailHeaderTitleBox.add_child(this._detailHeaderTitle);

        const optBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 99px; padding: 6px;', reactive: true, accessible_name: _('Settings') });
        const optIcon = new St.Icon({ icon_name: 'view-more-symbolic', style_class: 'rp-fg', style: 'icon-size: 16px;' });
        optIcon.set_pivot_point(0.5, 0.5);
        optBtn.add_child(optIcon);
        optBtn.connect('clicked', () => this._openDetailsWindow('settings'));
        this._detailOptBtn = optBtn;
        this._detailOptIcon = optIcon;

        this._addClickAnimations(backBtn);
        this._detailHeader.add_child(backBtn);
        this._detailHeader.add_child(this._detailHeaderTitleBox);
        this._buildRangeSlider();
        this._detailHeader.add_child(this._rangeControl);
        this._detailHeader.add_child(this._detailRangeBox);
        this._applyRange();
        this._addClickAnimations(optBtn);
        this._detailHeader.add_child(optBtn);

        this._detailArea.add_child(this._detailHeader);
        this._sampleStatusLabel = new St.Label({ style_class: 'rp-muted', visible: false, x_expand: true });
        this._sampleStatusLabel.clutter_text.line_wrap = true;
        this._detailArea.add_child(this._sampleStatusLabel);

        // Sections are built on first visit: most opens only ever show the
        // overview, so enable() should not pay for eight unseen pages.
        this._detailSections = {};
        this._detailBuilders = {
            cpu:     () => this._buildCpuDetails(),
            memory:  () => this._buildMemoryDetails(),
            battery: () => this._buildBatteryDetails(),
            power:   () => this._buildPowerDetails(),
            disk:    () => this._buildDiskDetails(),
            network: () => this._buildNetworkDetails(),
            thermal: () => this._buildThermalDetails(),
            gpu:     () => this._buildGpuDetails(),
            incidents: () => this._buildIncidentDetails(),
        };

        this._menuContainer.add_child(this._detailArea);
    }

    _buildRangeSlider() {
        const trigger = this._detailRangeBox = new St.Button({
            style_class: 'rp-range rp-range-trigger', can_focus: true,
            toggle_mode: true, accessible_role: Atk.Role.TOGGLE_BUTTON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const contents = new St.BoxLayout({ style_class: 'rp-range-trigger-content' });
        contents.add_child(new St.Icon({
            icon_name: 'preferences-system-time-symbolic', icon_size: 12,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._rangeValue = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        contents.add_child(this._rangeValue);
        trigger.set_child(contents);

        const control = this._rangeControl = new St.BoxLayout({
            ...VERTICAL, visible: false, style_class: 'rp-range-control',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const slider = this._rangeSlider = new RangeSlider(0);
        slider.add_style_class_name('rp-range-slider');
        slider.height = 14;
        slider.y_align = Clutter.ActorAlign.CENTER;
        control.add_child(slider);
        const limits = new St.BoxLayout({ style_class: 'rp-range-limits' });
        this._rangeMin = new St.Label({ text: _('Live'), style_class: 'rp-fg-dim', x_expand: true });
        this._rangeMax = new St.Label({ text: _(RANGES.day.label), style_class: 'rp-fg-dim' });
        limits.add_child(this._rangeMin);
        limits.add_child(this._rangeMax);
        control.add_child(limits);

        slider.connect('drag-begin', () => { this._rangeDragging = true; });
        slider.connect('notify::value', () => {
            if (!control.visible || this._rangeSliderSyncing) return;
            const index = Math.round(slider.value * LAST_RANGE);
            if (this._rangeDragging) this._showRangeValue(RANGE_ORDER[index]);
            else this._selectChartRange(index, slider.value);
        });
        slider.connect('drag-end', () => {
            this._rangeDragging = false;
            if (control.visible) this._selectChartRange(Math.round(slider.value * LAST_RANGE), slider.value);
        });
        slider.selectStop = index => this._selectChartRange(index);
        slider.stepStop = delta => this._selectChartRange(RANGE_ORDER.indexOf(this._range) + delta);
        trigger.connect('clicked', () => this._showRangeSlider(!control.visible, true));
    }

    _selectChartRange(index, position = null) {
        const stop = Math.max(0, Math.min(index, LAST_RANGE));
        this._rangePosition = position ?? stop / LAST_RANGE;
        const range = RANGE_ORDER[stop];
        if (range === this._range) {
            this._syncRangeSlider();
            return;
        }
        this._range = range;
        this._applyRange();
    }

    _showRangeValue(range) {
        const spec = RANGES[range];
        const live = this._rangeControl.visible ? _('Live') : this._spanLabel || _('Live');
        const label = spec ? _(spec.label) : live;
        this._rangeValue.text = label;
        const name = fill(_('Chart range: {span}'), { span: label });
        this._detailRangeBox.accessible_name = name;
        this._rangeSlider.accessible_name = name;
    }

    _syncRangeSlider() {
        if (!this._rangeSlider) return;
        this._rangeSliderSyncing = true;
        this._rangeSlider.value = this._rangePosition ?? 0;
        this._rangeSliderSyncing = false;
        this._showRangeValue(this._range);
    }

    _showRangeSlider(open, focus = false) {
        if (!this._rangeControl || this._rangeControl.visible === open) return;
        this._rangeDragging = false;
        this._rangeControl.visible = open;
        this._detailRangeBox.checked = open;
        this._syncRangeSlider();
        if (focus) (open ? this._rangeSlider : this._detailRangeBox).grab_key_focus();
    }

    _ensureDetailSection(key) {
        if (!this._detailSections || this._detailSections[key] || !this._detailBuilders?.[key]) return;
        const section = this._detailBuilders[key]();
        this._detailSections[key] = section;
        this._detailArea.add_child(section);
        // Show what is already known instead of placeholders until the next sample.
        if (this._lastData) this._updateDashboardUI(this._lastData);
    }

    /** Whether the keyboard focus is on something inside the panel. */
    _focusInPanel() {
        const focus = global.stage.get_key_focus();
        return !!focus && this._menuContainer.contains(focus);
    }

    _updateTabVisibility() {
        const hadFocus = this._focusInPanel();
        // A page opens at its top, not at the offset the last one was left at.
        if (this._shownTab !== this._activeTab) {
            this._showRangeSlider(false);
            if (this._shownTab === 'disk') this._updateDriveStats(null);
            this._closeProcessMemoryPage(this._shownTab);
            this._shownTab = this._activeTab;
            this._scrollView?.get_vadjustment().set_value(0);
        }
        if (this._activeTab !== 'overview') this._ensureDetailSection(this._activeTab);
        // Detail data (sensor list, mounts, processes) is only sampled for
        // the visible tab: fetch it now instead of after up to one interval.
        // _poll() itself coalesces bursts (keyboard navigation, re-renders).
        if (this._menuOpen && this._activeTab !== 'incidents') this._poll();
        if (this._activeTab === 'overview') {
            if (!this._overviewPage.visible) {
                this._overviewPage.opacity = 0;
                this._overviewPage.visible = true;
                this._overviewPage.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            this._detailArea.visible = false;
        } else {
            this._overviewPage.visible = false;
            if (!this._detailArea.visible) {
                this._detailArea.opacity = 0;
                this._detailArea.visible = true;
                this._detailArea.ease({
                    opacity: 255,
                    duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            
            // Set header title & icon dynamically
            const incidents = this._activeTab === 'incidents';
            if (incidents) {
                this._detailHeaderIcon.icon_name = 'document-open-recent-symbolic';
                this._detailHeaderIcon.fallback_gicon = null;
            } else {
                this._setMetricIcon(this._detailHeaderIcon, this._activeTab);
            }
            this._detailHeaderIcon.style_class = incidents ? 'rp-fg-dim' : `rp-c-${this._activeTab}`;
            this._detailHeaderTitle.text = PAGE_TITLES[this._activeTab];
            this._detailRangeBox.visible = !incidents;
            if (incidents) {
                this._sampleStatusLabel.visible = false;
                this._updateIncidentPage();
            }

            for (const [key, section] of Object.entries(this._detailSections || {})) {
                if (section) section.visible = (key === this._activeTab);
            }
        }
        // Hiding the page that held the keyboard focus drops the focus;
        // hand it to the page now shown so a keyboard user keeps their place.
        if (hadFocus && !this._focusInPanel())
            this._menuContainer.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }
}
