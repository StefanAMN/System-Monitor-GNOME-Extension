// The preferences window in the extension's own look: the panel's surfaces
// and metric tints, and the extension's blue accent instead of the system
// accent. GTK side (preferences process).
//
// Scoped to this window where libadwaita allows it: from libadwaita 1.6
// (GNOME 47) colours are CSS variables, overridden on window.rp-window only.
// Libadwaita 1.5 (GNOME 46) only has process-wide named colours; there the
// stylesheet is added only while this window is open, since the Extensions
// app may show other extensions' preferences in the same process.
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

const ACCENT = '#3584e4';

// [dark, light] per metric: background, border (from stylesheet.css).
export const TINTS = {
    cpu: [['#1f2937', 'rgba(53, 132, 228, 0.4)'], ['#e4eefb', 'rgba(53, 132, 228, 0.45)']],
    memory: [['#1e1a2e', 'rgba(145, 65, 172, 0.4)'], ['#f2e7f6', 'rgba(145, 65, 172, 0.45)']],
    battery: [['#192820', 'rgba(46, 194, 126, 0.4)'], ['#e1f5eb', 'rgba(38, 162, 105, 0.5)']],
    power: [['#22200a', 'rgba(246, 211, 45, 0.35)'], ['#fdf6d6', 'rgba(229, 165, 10, 0.6)']],
    disk: [['#22200a', 'rgba(246, 211, 45, 0.35)'], ['#fdf6d6', 'rgba(229, 165, 10, 0.6)']],
    thermal: [['#221608', 'rgba(255, 120, 0, 0.35)'], ['#ffedda', 'rgba(255, 120, 0, 0.5)']],
    gpu: [['#0b2014', 'rgba(51, 209, 122, 0.35)'], ['#e1f7eb', 'rgba(38, 162, 105, 0.5)']],
    network: [['#22100f', 'rgba(224, 27, 36, 0.35)'], ['#fce5e6', 'rgba(224, 27, 36, 0.4)']],
};
export const METRIC_COLORS = {
    cpu: '#3584e4', memory: '#9141ac', battery: '#2ec27e', power: '#f6d32d', disk: '#e5a50a',
    thermal: '#ff7800', gpu: '#33d17a', network: '#e01b24',
};

// The window in the panel's family, kept calm for reading: charcoal (dark)
// or near-white (light) surfaces with only a hint of blue, faint neutral
// borders, off-white text, and the blue accent kept for what can be used
// (switches, the selected tab, buttons, highlights). The first version used
// navy surfaces with blue borders on every card and pure white text, which
// the owner found too contrasty and tiring.
export function palette(dark) {
    return dark
        ? {
            window: '#16191f', header: '#1a1e25', card: '#1f242c', hover: '#262c35', popover: '#1f242c',
            fg: '#e4e7eb', dim: '#9ba1ab', border: 'rgba(255, 255, 255, 0.08)', divider: 'rgba(255, 255, 255, 0.06)',
            accentText: '#8ab4ea', track: 'rgba(255, 255, 255, 0.08)', button: 'rgba(255, 255, 255, 0.07)',
            buttonHover: 'rgba(255, 255, 255, 0.11)', selected: 'rgba(53, 132, 228, 0.22)',
        }
        : {
            window: '#f5f6f8', header: '#eceef2', card: '#fcfcfd', hover: '#eef1f5', popover: '#fcfcfd',
            fg: '#2a2d33', dim: '#61656d', border: 'rgba(0, 0, 0, 0.09)', divider: 'rgba(0, 0, 0, 0.06)',
            accentText: '#1c71d8', track: 'rgba(0, 0, 0, 0.08)', button: 'rgba(0, 0, 0, 0.05)',
            buttonHover: 'rgba(0, 0, 0, 0.09)', selected: 'rgba(53, 132, 228, 0.14)',
        };
}

/**
 * The stylesheet for one variant.
 * @param {boolean} dark
 * @param {boolean} variables libadwaita 1.6 or later
 */
export function windowCss(dark, variables) {
    const p = palette(dark);
    const colours = variables
        ? `window.rp-window {
    --window-bg-color: ${p.window}; --window-fg-color: ${p.fg};
    --view-bg-color: ${p.window}; --view-fg-color: ${p.fg};
    --headerbar-bg-color: ${p.header}; --headerbar-fg-color: ${p.fg};
    --headerbar-backdrop-color: ${p.header}; --headerbar-border-color: ${p.divider};
    --card-bg-color: ${p.card}; --card-fg-color: ${p.fg};
    --dialog-bg-color: ${p.card}; --dialog-fg-color: ${p.fg};
    --popover-bg-color: ${p.popover}; --popover-fg-color: ${p.fg};
    --border-color: ${p.divider};
    --accent-bg-color: ${ACCENT}; --accent-fg-color: #ffffff; --accent-color: ${p.accentText};
}`
        : `@define-color window_bg_color ${p.window};
@define-color window_fg_color ${p.fg};
@define-color view_bg_color ${p.window};
@define-color view_fg_color ${p.fg};
@define-color headerbar_bg_color ${p.header};
@define-color headerbar_fg_color ${p.fg};
@define-color headerbar_backdrop_color ${p.header};
@define-color headerbar_border_color ${p.divider};
@define-color card_bg_color ${p.card};
@define-color card_fg_color ${p.fg};
@define-color dialog_bg_color ${p.card};
@define-color dialog_fg_color ${p.fg};
@define-color popover_bg_color ${p.popover};
@define-color popover_fg_color ${p.fg};
@define-color borders ${p.divider};
@define-color accent_bg_color ${ACCENT};
@define-color accent_fg_color #ffffff;
@define-color accent_color ${p.accentText};`;

    const tints = Object.entries(TINTS).map(([key, variants]) => {
        const [bg, border] = variants[dark ? 0 : 1];
        return `window.rp-window .rp-tint-${key},
window.rp-window button.rp-pin-chip.rp-tint-${key},
window.rp-window button.rp-pin-chip.rp-tint-${key}:hover { background-color: ${bg}; border-color: ${border}; }
window.rp-window .rp-c-${key} { color: ${METRIC_COLORS[key]}; }
window.rp-window levelbar.rp-bar-${key} block.filled { background-color: ${METRIC_COLORS[key]}; }`;
    }).join('\n');

    return `${colours}
window.rp-window,
window.rp-window.background { background-color: ${p.window}; color: ${p.fg}; }
window.rp-window * { color: inherit; }
window.rp-window .subtitle,
window.rp-window .dim-label { color: ${p.dim}; }
window.rp-window .accent { color: ${p.accentText}; }
window.rp-window headerbar {
    background-color: ${p.header};
    color: ${p.fg};
    box-shadow: inset 0 -1px ${p.divider};
}
window.rp-window viewswitcher button { background-color: transparent; box-shadow: none; }
window.rp-window viewswitcher button:hover { background-color: ${p.button}; }
window.rp-window viewswitcher button:checked,
window.rp-window viewswitcher button:checked:hover {
    background-color: ${p.selected};
    color: ${dark ? p.fg : '#1c71d8'};
}
window.rp-window .boxed-list,
window.rp-window .card {
    background-color: ${p.card};
    border: 1px solid ${p.border};
    border-radius: 12px;
    box-shadow: none;
}
window.rp-window .boxed-list > row,
window.rp-window .boxed-list row.expander list > row { background-color: transparent; border-bottom: 1px solid ${p.divider}; }
window.rp-window .boxed-list > row:last-child { border-bottom: none; }
window.rp-window .boxed-list > row.activatable:hover,
window.rp-window .boxed-list row.expander list > row.activatable:hover { background-color: ${p.hover}; }
window.rp-window .boxed-list row.expander list { background-color: transparent; }
window.rp-window button { background-color: ${p.button}; box-shadow: none; }
window.rp-window button:hover { background-color: ${p.buttonHover}; }
window.rp-window button.flat,
window.rp-window headerbar button,
window.rp-window windowcontrols button { background-color: transparent; }
window.rp-window button.flat:hover,
window.rp-window headerbar button:hover { background-color: ${p.button}; }
window.rp-window windowcontrols button > image { background-color: ${p.button}; }
window.rp-window windowcontrols button:hover > image { background-color: ${p.buttonHover}; }
window.rp-window button.suggested-action { background-color: ${ACCENT}; color: #ffffff; }
window.rp-window button.destructive-action {
    background-color: rgba(224, 27, 36, ${dark ? '0.22' : '0.14'});
    color: ${dark ? '#ff7b7b' : '#c01c28'};
}
window.rp-window row spinbutton,
window.rp-window row spinbutton > text { background-color: transparent; box-shadow: none; }
window.rp-window entry { background-color: ${p.button}; box-shadow: none; }
/* Text views (the agent's prompt, the report preview): themes such as
   Orchis paint them white whatever the variant. */
window.rp-window textview,
window.rp-window textview > text { background-color: ${p.card}; color: ${p.fg}; }
window.rp-window textview > text selection { background-color: ${p.selected}; }
window.rp-window frame { border: 1px solid ${p.border}; border-radius: 8px; }
/* Dialogs (the agent confirmation, the report preview) draw on a sheet,
   which themes give their own .background colour. */
window.rp-window sheet,
window.rp-window sheet.background { background-color: ${p.card}; color: ${p.fg}; }
window.rp-window switch { background-color: ${dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)'}; border-color: transparent; }
window.rp-window switch:checked { background-color: ${ACCENT}; }
window.rp-window switch > slider { background-color: #ffffff; }
window.rp-window check:checked,
window.rp-window radio:checked { background-color: ${ACCENT}; color: #ffffff; }
window.rp-window popover > contents,
window.rp-window popover > arrow {
    background-color: ${p.popover};
    color: ${p.fg};
    border: 1px solid ${p.border};
}
/* Lists draw on the surface they sit on: themes such as Orchis paint every
   listview and list white, which left a dropdown's options (Tracking ›
   Period) as off-white text on white. */
window.rp-window popover listview,
window.rp-window popover list,
window.rp-window popover .view,
window.rp-window popover scrolledwindow,
window.rp-window popover viewport { background-color: transparent; color: ${p.fg}; }
window.rp-window popover listview > row,
window.rp-window popover list > row { background-color: transparent; color: ${p.fg}; }
window.rp-window popover listview > row:selected,
window.rp-window popover listview > row:hover,
window.rp-window popover list > row:hover { background-color: ${p.selected}; }
/* The same for a dropdown's current value, an inline list in its row. */
window.rp-window row.combo listview.inline,
window.rp-window row.combo listview.inline > row { background-color: transparent; color: inherit; }
window.rp-window .rp-brand { font-weight: 800; }
window.rp-window .rp-brand-icon { color: ${ACCENT}; }
window.rp-window .rp-tile {
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid ${p.border};
    background-color: ${p.card};
}
window.rp-window .rp-tile-label { color: ${p.dim}; font-size: 0.85em; font-weight: 600; }
window.rp-window .rp-tile-value { font-size: 1.5em; font-weight: 800; }
window.rp-window .rp-tile-detail { color: ${p.dim}; font-size: 0.85em; }
window.rp-window .rp-chart {
    padding: 12px;
    border-radius: 12px;
    border: 1px solid ${p.border};
    background-color: ${p.card};
}
window.rp-window .rp-chart-area { color: ${p.dim}; font-size: 0.8em; }
window.rp-window levelbar block.empty { background-color: ${p.track}; border: none; }
window.rp-window levelbar block.filled { background-color: ${ACCENT}; border: none; }
/* The Settings page. The top-bar preview is dark in both variants, as
   GNOME's top bar is, so its text keeps its own off-white. */
window.rp-window .rp-preview {
    padding: 18px 12px 12px;
    border-radius: 14px;
    border: 1px solid ${p.border};
    background-color: ${p.card};
}
window.rp-window .rp-preview-bar {
    background-color: #0b0c0f;
    border-radius: 99px;
    padding: 7px 14px;
    min-height: 22px;
}
window.rp-window .rp-preview-item { padding: 0 10px; }
window.rp-window .rp-preview-value { color: #eef1f5; font-weight: 700; font-size: 0.95em; }
window.rp-window .rp-preview-divider { background-color: rgba(255, 255, 255, 0.18); min-width: 1px; margin: 3px 0; }
window.rp-window .rp-preview-caption { color: ${p.dim}; font-size: 0.8em; }
window.rp-window button.rp-pin-chip {
    background-color: ${p.card};
    border: 1px solid ${p.border};
    border-radius: 12px;
    padding: 8px 10px;
    font-weight: 600;
}
window.rp-window button.rp-pin-chip:hover { background-color: ${p.hover}; }
window.rp-window button.rp-pin-chip:checked { border-width: 1px; }
window.rp-window .rp-pin-badge {
    background-color: ${ACCENT};
    color: #ffffff;
    border-radius: 99px;
    min-width: 18px;
    min-height: 18px;
    font-size: 0.75em;
    font-weight: 800;
}
window.rp-window .rp-segmented button { padding: 4px 12px; font-weight: 600; }
window.rp-window .rp-segmented button:checked { background-color: ${ACCENT}; color: #ffffff; }
window.rp-window scale.rp-slider trough { background-color: ${p.track}; }
window.rp-window scale.rp-slider highlight { background-color: ${ACCENT}; }
/* The knob: themes draw their own (Orchis: a pink image on a 32 px area). */
window.rp-window scale.rp-slider > trough > slider,
window.rp-window scale.rp-slider > trough > slider:hover,
window.rp-window scale.rp-slider > trough > slider:focus,
window.rp-window scale.rp-slider > trough > slider:active {
    background-image: none;
    background-color: #ffffff;
    border: 2px solid ${ACCENT};
    border-radius: 50%;
    min-width: 16px;
    min-height: 16px;
    margin: -8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    outline: none;
}
window.rp-window .rp-slider-value { font-weight: 700; }
window.rp-window .rp-finding-warning { color: #ff7800; }
window.rp-window .rp-finding-suggestion { color: ${ACCENT}; }
window.rp-window .rp-finding-info { color: ${p.dim}; }
${tints}
`;
}

/**
 * Give a preferences window the extension's look, following dark / light.
 * @param {Adw.PreferencesWindow} window
 * @returns {{dark: function(): boolean, css: function(): string}} for tests
 */
export function styleWindow(window) {
    window.add_css_class('rp-window');
    const variables = Adw.get_major_version() > 1 || Adw.get_minor_version() >= 6;
    const manager = Adw.StyleManager.get_default();
    const provider = new Gtk.CssProvider();
    let css = '';
    const load = () => {
        css = windowCss(manager.dark, variables);
        provider.load_from_string(css);
    };
    load();
    const display = window.get_display();
    // Above the user stylesheet (~/.config/gtk-4.0/gtk.css), where third-party
    // themes such as Orchis install themselves with hard-coded colours; every
    // rule here is scoped to this window.
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);
    const darkId = manager.connect('notify::dark', load);
    window.connect('close-request', () => {
        manager.disconnect(darkId);
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false;
    });
    return { dark: () => manager.dark, css: () => css, variables };
}
