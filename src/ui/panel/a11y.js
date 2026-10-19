// What screen readers are told about the values: the top-bar metrics, the ⚠
// and the overview cards. Names follow readings, never glide frames, so a
// screen reader is not handed a new name four times a second.
// Methods of the extension (installed by extension.js); `this` is the extension.
import { spokenValue } from '../../lib/common/present.js';
import { METRIC_NAMES } from './constants.js';
import { _, fill } from '../../lib/common/i18n.js';

export class AccessibilityMethods {
    /** Name what is shown; called when it shows a reading, not a glide frame. */
    _nameValues() {
        for (const [key, widget] of Object.entries(this._topBarWidgets ?? {}))
            widget.box.accessible_name = fill(_('{metric} {value}'), { metric: METRIC_NAMES[key], value: spokenValue(widget.text) });
        if (this._dangerBox?.visible)
            this._dangerBox.accessible_name = fill(_('Alerts: {alerts}'), { alerts: spokenValue(this._alertText().replaceAll('\n', ' · ')) });
        // The cards are read only while the menu is open; opening it renders.
        if (!this._menuOpen || !this._summaryCards) return;
        for (const card of Object.values(this._summaryCards)) {
            const sub = card.subLabel?.visible && card.subLabel.text ? `, ${spokenValue(card.subLabel.text)}` : '';
            card.box.accessible_name = fill(_('{metric} {value}, opens {metric} details'), { metric: card.title, value: spokenValue(card.valueLabel.text) + sub });
        }
    }
}
