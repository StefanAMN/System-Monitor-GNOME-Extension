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
    thermal: [['#221608', 'rgba(255, 120, 0, 0.35)'], ['#ffedda', 'rgba(255, 120, 0, 0.5)']],
    gpu: [['#0b2014', 'rgba(51, 209, 122, 0.35)'], ['#e1f7eb', 'rgba(38, 162, 105, 0.5)']],
    network: [['#22100f', 'rgba(224, 27, 36, 0.35)'], ['#fce5e6', 'rgba(224, 27, 36, 0.4)']],
};
export const METRIC_COLORS = {
    cpu: '#3584e4', memory: '#9141ac', battery: '#2ec27e', power: '#f6d32d',
    thermal: '#ff7800', gpu: '#33d17a', network: '#e01b24',
};

// The whole window takes the panel's CPU card look: navy surfaces with a thin
// blue border in dark, pale blue in light.
function palette(dark) {
    return dark
        ? {
            window: '#141b26', header: '#18212f', card: '#1f2937', hover: '#26354a', popover: '#1f2937',
            fg: '#ffffff', dim: '#a0a0b8', border: 'rgba(53, 132, 228, 0.4)', divider: 'rgba(53, 132, 228, 0.18)',
            accentText: '#78aeed', track: 'rgba(255, 255, 255, 0.08)', button: 'rgba(53, 132, 228, 0.18)',
            buttonHover: 'rgba(53, 132, 228, 0.30)', selected: 'rgba(53, 132, 228, 0.32)',
        }
        : {
            window: '#f3f7fd', header: '#e4eefb', card: '#eaf2fd', hover: '#dbe8fa', popover: '#f3f7fd',
            fg: '#241f31', dim: '#5e5c64', border: 'rgba(53, 132, 228, 0.45)', divider: 'rgba(53, 132, 228, 0.2)',
            accentText: '#1c71d8', track: 'rgba(0, 0, 0, 0.08)', button: 'rgba(53, 132, 228, 0.12)',
            buttonHover: 'rgba(53, 132, 228, 0.22)', selected: 'rgba(53, 132, 228, 0.2)',
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
        return `window.rp-window .rp-tint-${key} { background-color: ${bg}; border-color: ${border}; }
window.rp-window .rp-c-${key} { color: ${METRIC_COLORS[key]}; }
window.rp-window levelbar.rp-bar-${key} block.filled { background-color: ${METRIC_COLORS[key]}; }`;
    }).join('\n');

    return `${colours}
window.rp-window { background-color: ${p.window}; color: ${p.fg}; }
window.rp-window headerbar {
    background-color: ${p.header};
    box-shadow: inset 0 -1px ${p.divider};
}
window.rp-window viewswitcher button:checked,
window.rp-window viewswitcher button:checked:hover {
    background-color: ${p.selected};
    color: ${dark ? '#ffffff' : '#1c71d8'};
}
window.rp-window .boxed-list,
window.rp-window .card {
    background-color: ${p.card};
    border: 1px solid ${p.border};
    border-radius: 12px;
    box-shadow: none;
}
window.rp-window .boxed-list > row:not(:last-child),
window.rp-window .boxed-list row.expander list > row { border-bottom-color: ${p.divider}; }
window.rp-window .boxed-list > row.activatable:hover,
window.rp-window .boxed-list row.expander list > row.activatable:hover { background-color: ${p.hover}; }
window.rp-window .boxed-list row.expander list { background-color: transparent; }
window.rp-window button:not(.flat):not(.suggested-action):not(.destructive-action):not(.circular):not(.image-button):not(.toggle),
window.rp-window .boxed-list button.image-button:not(.flat) {
    background-color: ${p.button};
}
window.rp-window button:not(.flat):not(.suggested-action):not(.destructive-action):hover {
    background-color: ${p.buttonHover};
}
window.rp-window popover > contents,
window.rp-window popover > arrow {
    background-color: ${p.popover};
    border: 1px solid ${p.border};
}
window.rp-window popover listview > row:selected,
window.rp-window popover listview > row:hover { background-color: ${p.selected}; }
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
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    const darkId = manager.connect('notify::dark', load);
    window.connect('close-request', () => {
        manager.disconnect(darkId);
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false;
    });
    return { dark: () => manager.dark, css: () => css, variables };
}
