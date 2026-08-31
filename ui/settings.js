// Widgets of the in-menu settings page. Every row is a SettingRow: a title
// on the left and one control in a column of fixed width on the right, so
// all controls on the page start and end at the same x. There are three
// kinds of control (switch, segmented choice, stepper), all of one height.
// The widgets only report what the user did; the page stores the setting
// and pushes the stored value back with setState / setValue / setText.
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';

export const SettingRow = GObject.registerClass({
    GTypeName: 'ResourcePulseSettingRow',
}, class SettingRow extends St.BoxLayout {
    /**
     * @param {string} title
     * @param {St.Widget} control fills the control column unless it sets its own x_align
     */
    _init(title, control) {
        super._init({ style_class: 'rp-set-row', x_expand: true });
        this.titleLabel = new St.Label({ text: title, style_class: 'rp-set-title', y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this.titleLabel);
        // Secondary text on the same line (e.g. the current panel size); it
        // also takes the free space between title and control.
        this.asideLabel = new St.Label({ style_class: 'rp-set-aside', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this.asideLabel);
        this.control = control;
        this.controlBin = new St.Bin({ style_class: 'rp-set-control', child: control, y_align: Clutter.ActorAlign.CENTER });
        this.add_child(this.controlBin);
    }
});

export const SwitchButton = GObject.registerClass({
    GTypeName: 'ResourcePulseSwitchButton',
}, class SwitchButton extends St.Button {
    /** @param {function(boolean)} onToggle called with the state the user asked for */
    _init(onToggle) {
        // Drawn here rather than with the shell's own switch, so it takes the
        // same accent as the other controls and looks alike on every release.
        super._init({
            style_class: 'rp-set-switch',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // x_expand: without it the bin centres its child whatever x_align says.
        this.knob = new St.Widget({
            style_class: 'rp-set-knob',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(this.knob);
        this.state = false;
        this.connect('clicked', () => onToggle(!this.state));
    }

    setState(state) {
        this.state = state;
        this.knob.x_align = state ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        if (state) this.add_style_class_name('active');
        else this.remove_style_class_name('active');
    }
});

export const SegmentedControl = GObject.registerClass({
    GTypeName: 'ResourcePulseSegmentedControl',
}, class SegmentedControl extends St.BoxLayout {
    /**
     * @param {Array<[string, string]>} choices [value, label] pairs
     * @param {function(string)} onSelect called with the value the user picked
     */
    _init(choices, onSelect) {
        super._init({ style_class: 'rp-set-group', x_expand: true });
        this.layout_manager.homogeneous = true;
        this.value = null;
        this.buttons = new Map();
        const values = choices.map(([value]) => value);
        for (const [value, label] of choices) {
            const button = new St.Button({ label, style_class: 'rp-set-segment', can_focus: true, x_expand: true });
            button.connect('clicked', () => onSelect(value));
            // Left / Right move the selection, like a radio group.
            button.connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();
                if (symbol !== Clutter.KEY_Left && symbol !== Clutter.KEY_Right)
                    return Clutter.EVENT_PROPAGATE;
                const next = values.indexOf(value) + (symbol === Clutter.KEY_Right ? 1 : -1);
                if (next >= 0 && next < values.length) {
                    this.buttons.get(values[next]).grab_key_focus();
                    onSelect(values[next]);
                }
                return Clutter.EVENT_STOP;
            });
            this.add_child(button);
            this.buttons.set(value, button);
        }
    }

    setValue(value) {
        this.value = value;
        for (const [candidate, button] of this.buttons) {
            if (candidate === value) button.add_style_class_name('active');
            else button.remove_style_class_name('active');
        }
    }
});

export const Stepper = GObject.registerClass({
    GTypeName: 'ResourcePulseStepper',
}, class Stepper extends St.BoxLayout {
    /** @param {function(number)} onStep called with -1 or +1 */
    _init(onStep) {
        super._init({ style_class: 'rp-set-group', x_expand: true });
        this.decButton = new St.Button({ label: '−', style_class: 'rp-set-step', can_focus: true });
        this.valueLabel = new St.Label({
            style_class: 'rp-set-value',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.incButton = new St.Button({ label: '+', style_class: 'rp-set-step', can_focus: true });
        for (const [button, direction] of [[this.decButton, -1], [this.incButton, 1]]) {
            button.connect('clicked', () => onStep(direction));
            // Left / Right change the value from either button.
            button.connect('key-press-event', (_actor, event) => {
                const symbol = event.get_key_symbol();
                if (symbol !== Clutter.KEY_Left && symbol !== Clutter.KEY_Right)
                    return Clutter.EVENT_PROPAGATE;
                onStep(symbol === Clutter.KEY_Right ? 1 : -1);
                return Clutter.EVENT_STOP;
            });
        }
        this.add_child(this.decButton);
        this.add_child(this.valueLabel);
        this.add_child(this.incButton);
    }

    setText(text) {
        if (this.valueLabel.text !== text) this.valueLabel.text = text;
    }

    /** A button that cannot change the value any further is shown insensitive. */
    setLimits(canDecrease, canIncrease) {
        this.decButton.reactive = canDecrease;
        this.incButton.reactive = canIncrease;
    }
});

export const ActionButton = GObject.registerClass({
    GTypeName: 'ResourcePulseActionButton',
}, class ActionButton extends St.Button {
    /**
     * @param {string} label
     * @param {function()} onActivate
     */
    _init(label, onActivate) {
        super._init({ label, style_class: 'rp-set-action', can_focus: true, x_expand: true });
        this.connect('clicked', () => onActivate());
    }
});

export const PinTile = GObject.registerClass({
    GTypeName: 'ResourcePulsePinTile',
}, class PinTile extends St.Button {
    /**
     * @param {St.Icon} icon the metric's icon
     * @param {string} name
     * @param {function()} onToggle
     */
    _init(icon, name, onToggle) {
        super._init({ style_class: 'rp-set-tile', can_focus: true, x_expand: true });
        const box = new St.BoxLayout({ style_class: 'rp-set-tile-box', x_expand: true });
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        this.nameLabel = new St.Label({ text: name, style_class: 'rp-set-tile-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this.nameLabel);
        // Position in the top bar; the top bar drops labels from the highest
        // number down when it runs out of room.
        this.badge = new St.Label({ style_class: 'rp-set-badge', y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this.badge);
        this.set_child(box);
        // Not `position`: that is the actor's own coordinate property.
        this.pinPosition = 0;
        this.connect('clicked', () => onToggle());
    }

    /** @param {number} position 1-based place in the top bar, 0 when not pinned */
    setPosition(position) {
        this.pinPosition = position;
        this.badge.text = position > 0 ? `${position}` : '';
        // Kept in the layout either way, so the name does not shift.
        this.badge.opacity = position > 0 ? 255 : 0;
        if (position > 0) this.add_style_class_name('active');
        else this.remove_style_class_name('active');
    }
});

export const Note = GObject.registerClass({
    GTypeName: 'ResourcePulseSettingNote',
}, class Note extends St.Label {
    /** Explanatory text below a row; it wraps instead of being cut off. */
    _init() {
        super._init({ style_class: 'rp-set-note', x_expand: true, visible: false });
        this.clutter_text.line_wrap = true;
        this.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }
});
