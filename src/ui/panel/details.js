// The detail-page frame: header, range switch, building pages on first visit, switching tabs.
// Methods of the extension (installed by extension.js); `this` is the extension.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import { RANGES } from '../../lib/engine/longhistory.js';
import { _, fill, N_, translated } from '../../lib/common/i18n.js';

// The detail pages' titles, as on the overview cards.
const PAGE_TITLES = translated({
    cpu: N_('CPU'), memory: N_('Memory'), battery: N_('Battery'), power: N_('Power'),
    disk: N_('Disk'), network: N_('Network'), thermal: N_('Thermal'), gpu: N_('GPU'),
});

export class DetailsMethods {
    _buildDetails() {
        this._detailArea = new St.BoxLayout({
            vertical: true,
            style_class: 'resource-pulse-detail-area',
            x_expand: true,
            y_expand: true
        });

        // Top bar for CPU detail header (matches Right Panel header)
        this._detailHeader = new St.BoxLayout({ style: 'margin-bottom: 14px; spacing: 8px;', y_align: Clutter.ActorAlign.CENTER });

        const backBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 99px; padding: 6px;', reactive: true, accessible_name: _('Back to the overview') });
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
        // Range of the page's charts: the live samples, the last hour, the last day.
        const rangeBox = new St.BoxLayout({ style_class: 'rp-chip-bg rp-range-box', y_align: Clutter.ActorAlign.CENTER });
        this._rangeButtons = {};
        for (const range of Object.keys(RANGES)) {
            const button = new St.Button({
                style_class: 'rp-range',
                label: RANGES[range] ? _(RANGES[range].label) : (this._spanLabel || _('live')),
                can_focus: true,
                toggle_mode: true,
                accessible_name: range === 'live' ? _('Recent samples') : fill(_('Last {span}'), { span: _(RANGES[range].label) }),
                accessible_role: Atk.Role.TOGGLE_BUTTON,
            });
            button.connect('clicked', () => {
                this._range = range;
                this._applyRange();
            });
            rangeBox.add_child(button);
            this._rangeButtons[range] = button;
        }
        this._detailHeader.add_child(rangeBox);
        this._applyRange();
        this._addClickAnimations(optBtn);
        this._detailHeader.add_child(optBtn);

        this._detailArea.add_child(this._detailHeader);

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
        };

        this._menuContainer.add_child(this._detailArea);
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
            this._shownTab = this._activeTab;
            this._scrollView?.get_vadjustment().set_value(0);
        }
        if (this._activeTab !== 'overview') this._ensureDetailSection(this._activeTab);
        // Detail data (sensor list, mounts, processes) is only sampled for
        // the visible tab: fetch it now instead of after up to one interval.
        // _poll() itself coalesces bursts (keyboard navigation, re-renders).
        if (this._menuOpen) this._poll();
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
            this._setMetricIcon(this._detailHeaderIcon, this._activeTab);
            this._detailHeaderIcon.style_class = `rp-c-${this._activeTab}`;
            this._detailHeaderTitle.text = PAGE_TITLES[this._activeTab];

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
