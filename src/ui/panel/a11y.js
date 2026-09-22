// What screen readers are told about the values: the top-bar metrics, the ⚠
// and the overview cards. Names follow readings, never glide frames, so a
// screen reader is not handed a new name four times a second.
// Methods of the extension (installed by extension.js); `this` is the extension.
import { spokenValue } from '../../lib/common/present.js';
import { METRIC_NAMES } from './constants.js';

export class AccessibilityMethods {
    /** Name what is shown; called when it shows a reading, not a glide frame. */
    _nameValues() {
        for (const [key, widget] of Object.entries(this._topBarWidgets ?? {}))
            widget.box.accessible_name = `${METRIC_NAMES[key]} ${spokenValue(widget.text)}`;
        if (this._dangerBox?.visible)
            this._dangerBox.accessible_name = `Alerts: ${spokenValue(this._alertText().replaceAll('\n', ' · '))}`;
        // The cards are read only while the menu is open; opening it renders.
        if (!this._menuOpen || !this._summaryCards) return;
        for (const card of Object.values(this._summaryCards)) {
            const sub = card.subLabel?.visible && card.subLabel.text ? `, ${spokenValue(card.subLabel.text)}` : '';
            card.box.accessible_name = `${card.title} ${spokenValue(card.valueLabel.text)}${sub}, opens ${card.title} details`;
        }
    }
}
