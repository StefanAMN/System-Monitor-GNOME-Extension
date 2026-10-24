// The preferences window's About page: what Resource Pulse is, in a banner
// with a live pulse line, four figures, the eight metrics in their colours,
// what else is inside, links and the credits. GTK side (preferences process).
//
// Extension Manager's "details" shows the extension's page on
// extensions.gnome.org; until it is published there, this page (behind the
// settings button of Extension Manager and the Extensions app, and at the
// foot of the panel) is where the extension tells about itself.
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { metricIcon } from './rows.js';
import { METRIC_COLORS } from './style.js';
import { readMachineInfo } from '../../lib/collectors/systemstate.js';
import { _, fill } from '../../lib/common/i18n.js';

export const AUTHOR = 'Stefan Stancu';
const YEAR = 2026;
// The eight metrics, in the panel's order, each in its own colour.
const METRIC_KEYS = ['cpu', 'memory', 'battery', 'disk', 'network', 'thermal', 'power', 'gpu'];
// Frames of the pulse line per second; the banner is all that moves.
const PULSE_FPS = 30;
// How far the line travels per second, in pixels.
const PULSE_SPEED = 70;

function rgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

/**
 * The pulse line's height at x: a flat line with a beat every `period`
 * pixels (a small bump, a sharp spike, a dip), like a heart monitor.
 * @returns {number} -1..1, upwards positive
 */
export function pulseAt(x, period = 180) {
    const u = ((x % period) + period) % period / period;
    const bump = (c, w, h) => h * Math.exp(-(((u - c) / w) ** 2));
    return bump(0.18, 0.035, 0.18) + bump(0.32, 0.012, -0.22) + bump(0.36, 0.014, 1) + bump(0.41, 0.016, -0.42) + bump(0.62, 0.05, 0.26);
}

/** The banner's background, glow and pulse line, `phase` pixels along. */
function drawHero(area, cr, width, height, phase) {
    // A deep blue field, lighter towards the upper right.
    const field = new Cairo.LinearGradient(0, height, width, 0);
    field.addColorStopRGB(0, 0.035, 0.06, 0.15);
    field.addColorStopRGB(0.55, 0.07, 0.16, 0.38);
    field.addColorStopRGB(1, 0.12, 0.33, 0.72);
    const r = 18;
    cr.newPath();
    cr.arc(width - r, r, r, -Math.PI / 2, 0);
    cr.arc(width - r, height - r, r, 0, Math.PI / 2);
    cr.arc(r, height - r, r, Math.PI / 2, Math.PI);
    cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
    cr.setSource(field);
    cr.fillPreserve();
    cr.clip();

    // Soft light in the metric colours behind the text.
    const glow = (x, y, radius, hex, alpha) => {
        const [red, green, blue] = rgb(hex);
        const g = new Cairo.RadialGradient(x, y, 0, x, y, radius);
        g.addColorStopRGBA(0, red, green, blue, alpha);
        g.addColorStopRGBA(1, red, green, blue, 0);
        cr.setSource(g);
        cr.rectangle(0, 0, width, height);
        cr.fill();
    };
    glow(width * 0.85, height * 0.15, height * 1.1, METRIC_COLORS.cpu, 0.55);
    glow(width * 0.62, height * 1.05, height * 0.9, METRIC_COLORS.memory, 0.35);
    glow(width * 0.08, height * 0.05, height * 0.7, METRIC_COLORS.gpu, 0.12);

    // A faint dot grid, like a monitor's.
    cr.setSourceRGBA(1, 1, 1, 0.06);
    for (let y = 14; y < height; y += 22) {
        for (let x = 14; x < width; x += 22) {
            cr.rectangle(x, y, 1.5, 1.5);
        }
    }
    cr.fill();

    // The pulse line, its colour running through the eight metrics.
    const base = height * 0.74;
    const amp = height * 0.17;
    const line = new Cairo.LinearGradient(0, 0, width, 0);
    METRIC_KEYS.forEach((key, i) => {
        const [red, green, blue] = rgb(METRIC_COLORS[key]);
        line.addColorStopRGB(i / (METRIC_KEYS.length - 1), red, green, blue);
    });
    const trace = () => {
        cr.newPath();
        for (let x = 0; x <= width; x += 2) {
            const y = base - amp * pulseAt(x + phase);
            if (x === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
    };
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    for (const [lineWidth, alpha] of [[10, 0.12], [5, 0.25], [2.2, 1]]) {
        trace();
        cr.setSource(line);
        cr.setLineWidth(lineWidth);
        cr.pushGroup();
        cr.strokePreserve();
        cr.newPath();
        cr.popGroupToSource();
        cr.paintWithAlpha(alpha);
    }
    cr.$dispose();
}

/** A chip on the banner: a short fact on a translucent pill. */
function chip(text) {
    return new Gtk.Label({ label: text, css_classes: ['rp-hero-chip'] });
}

/** One of the four figures. */
function figure(value, label, tint) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, css_classes: ['rp-figure', `rp-tint-${tint}`] });
    box.append(new Gtk.Label({ label: value, xalign: 0, css_classes: ['rp-figure-value', `rp-c-${tint}`] }));
    box.append(new Gtk.Label({ label, xalign: 0, wrap: true, css_classes: ['rp-tile-detail'] }));
    box.value = value;
    return box;
}

/** A metric's tile: its icon in its colour, its name, what is shown of it. */
function metricTile(key, title, line, path) {
    const box = new Gtk.Box({ spacing: 12, css_classes: ['rp-metric-tile', `rp-tint-${key}`] });
    const icon = new Gtk.Image({ gicon: metricIcon(key, path), pixel_size: 22, valign: Gtk.Align.START, css_classes: [`rp-c-${key}`, 'rp-metric-icon'] });
    box.append(icon);
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
    text.append(new Gtk.Label({ label: title, xalign: 0, css_classes: ['rp-metric-title'] }));
    text.append(new Gtk.Label({ label: line, xalign: 0, wrap: true, css_classes: ['rp-tile-detail'] }));
    box.append(text);
    box.metric = key;
    return box;
}

function flow(children, perLine) {
    const box = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: Math.min(2, perLine), max_children_per_line: perLine,
        column_spacing: 10, row_spacing: 10,
    });
    for (const child of children) {
        box.append(child);
        child.get_parent().can_focus = false;
    }
    return box;
}

/**
 * What the extension and the machine are, as text for a bug report.
 * @param {object} metadata the extension's metadata.json
 * @param {?object} machine from readMachineInfo()
 * @param {?string} shell GNOME Shell's version
 */
export function detailsText(metadata, machine, shell) {
    const version = metadata['version-name'] ?? metadata.version ?? _('development build');
    return [
        fill(_('Resource Pulse {version} ({uuid})'), { version, uuid: metadata.uuid }),
        shell ? fill(_('GNOME Shell {version}'), { version: shell }) : null,
        machine?.os ? fill(_('System: {os}'), { os: machine.os }) : null,
        machine?.kernel ? fill(_('Kernel: {kernel}'), { kernel: machine.kernel }) : null,
        machine?.cpu ? fill(_('Processor: {cpu}, {threads} threads'), { cpu: machine.cpu, threads: machine.threads }) : null,
        fill(_('Session: {type}'), { type: GLib.getenv('XDG_SESSION_TYPE') ?? '?' }),
    ].filter(Boolean).join('\n');
}

async function shellVersion() {
    try {
        // Only inside the Extensions service; a plain gjs (the tests) has no such resource.
        const Config = await import('resource:///org/gnome/Shell/Extensions/js/misc/config.js');
        return Config.PACKAGE_VERSION;
    } catch {
        return null;
    }
}

/**
 * @param {object} opts
 * @param {string} opts.path the extension's directory
 * @param {object} opts.metadata metadata.json
 * @param {function(string, Gtk.Widget)} [opts.openUri] for tests
 * @param {function(): Promise<object>} [opts.readMachine] for tests
 */
export function buildAboutPage({
    path, metadata,
    openUri = (uri, widget) => new Gtk.UriLauncher({ uri }).launch(widget.get_root(), null, null),
    readMachine = () => readMachineInfo(),
}) {
    const page = new Adw.PreferencesPage({ title: _('About'), name: 'about', icon_name: 'help-about-symbolic' });

    // The banner.
    const heroGroup = new Adw.PreferencesGroup();
    page.add(heroGroup);
    const hero = new Gtk.Overlay({ css_classes: ['rp-hero'], height_request: 236 });
    const art = new Gtk.DrawingArea({ hexpand: true, vexpand: true });
    art.update_property([Gtk.AccessibleProperty.LABEL], [_('A pulse line running through the colours of the eight metrics')]);
    const state = { phase: 0, last: 0, tickId: 0, frames: 0 };
    art.set_draw_func((area, cr, width, height) => drawHero(area, cr, width, height, state.phase));
    hero.set_child(art);

    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_start: 28, margin_end: 28, margin_top: 26, valign: Gtk.Align.START });
    const mark = new Gtk.Box({ spacing: 12 });
    mark.append(new Gtk.Image({ gicon: Gio.icon_new_for_string(`${path}/icons/rp-cpu-symbolic.svg`), pixel_size: 40, css_classes: ['rp-hero-mark'] }));
    const titleBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
    const name = new Gtk.Label({ label: 'Resource Pulse', xalign: 0, css_classes: ['rp-hero-title'] });
    titleBox.append(name);
    titleBox.append(new Gtk.Label({ label: _('Your computer\'s vital signs, one glance away.'), xalign: 0, wrap: true, css_classes: ['rp-hero-tagline'] }));
    mark.append(titleBox);
    text.append(mark);
    const chips = new Gtk.Box({ spacing: 8, margin_top: 10 });
    const versions = metadata['shell-version'] ?? [];
    const version = metadata['version-name'] ?? metadata.version;
    chips.append(chip(version ? fill(_('Version {version}'), { version }) : _('Development build')));
    if (versions.length > 0) chips.append(chip(fill(_('GNOME {from}–{to}'), { from: versions[0], to: versions[versions.length - 1] })));
    chips.append(chip(_('MIT licence')));
    text.append(chips);
    hero.add_overlay(text);
    heroGroup.add(hero);

    // The line moves only while the page is on screen, and not at all when
    // the desktop asks for less motion.
    const animate = () => Gtk.Settings.get_default()?.gtk_enable_animations !== false;
    const startPulse = () => {
        if (state.tickId || !animate()) return;
        state.last = 0;
        state.tickId = art.add_tick_callback((widget, clock) => {
            const now = clock.get_frame_time();
            if (state.last && now - state.last < 1e6 / PULSE_FPS) return GLib.SOURCE_CONTINUE;
            if (state.last) state.phase += PULSE_SPEED * (now - state.last) / 1e6;
            state.last = now;
            state.frames++;
            widget.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    };
    const stopPulse = () => {
        if (state.tickId) art.remove_tick_callback(state.tickId);
        state.tickId = 0;
    };
    art.connect('map', startPulse);
    art.connect('unmap', stopPulse);

    // Four figures.
    const figures = new Adw.PreferencesGroup();
    page.add(figures);
    const figureBoxes = [
        figure('8', _('metrics, live in the top bar and the panel'), 'cpu'),
        figure('< 1 %', _('of one core with the panel closed'), 'gpu'),
        figure(_('14 days'), _('of usage history, kept on this computer'), 'memory'),
        figure('0', _('bytes sent anywhere, unless you ask an agent'), 'thermal'),
    ];
    figures.add(flow(figureBoxes, 4));

    // The metrics.
    const metricsGroup = new Adw.PreferencesGroup({ title: _('Eight metrics, one glance'), description: _('Each in its own colour, everywhere it appears.') });
    page.add(metricsGroup);
    const metricLines = {
        cpu: [_('Processor'), _('Load per core, frequency, the busiest processes')],
        memory: [_('Memory'), _('In use, cached, swap, the largest apps')],
        battery: [_('Battery'), _('Charge, time left, health, every battery')],
        disk: [_('Disk'), _('Space on each drive, read and write speed')],
        network: [_('Network'), _('Speed per interface, today and this month')],
        thermal: [_('Temperature'), _('Every sensor, fans, alerts when it runs hot')],
        power: [_('Power'), _('What the machine draws, from the battery or the processor')],
        gpu: [_('Graphics'), _('Load, memory and clock of every GPU')],
    };
    const tiles = METRIC_KEYS.map(key => metricTile(key, metricLines[key][0], metricLines[key][1], path));
    metricsGroup.add(flow(tiles, 2));

    // What else.
    const more = new Adw.PreferencesGroup({ title: _('Beyond the numbers') });
    page.add(more);
    for (const [icon, title, subtitle] of [
        ['document-open-recent-symbolic', _('Usage tracking'), _('Which apps used the processor, memory, disk and battery, hour by hour, for 14 days')],
        ['dialog-information-symbolic', _('Diagnostics'), _('What runs in the background, holds memory or drains the battery, with the evidence')],
        ['utilities-terminal-symbolic', _('Fix with an agent'), _('Hand the findings to a coding agent of your choice, which asks before it changes anything')],
        ['dialog-warning-symbolic', _('Alerts'), _('A sign in the top bar when the processor, memory or temperature stays too high')],
        ['preferences-desktop-accessibility-symbolic', _('For screen readers'), _('Every card, value and button has a name')],
        ['preferences-desktop-locale-symbolic', _('Ready for translation'), _('Every word on screen comes from the translation template')],
    ]) {
        const row = new Adw.ActionRow({ title, subtitle });
        row.add_prefix(new Gtk.Image({ icon_name: icon, css_classes: ['rp-feature-icon'] }));
        more.add(row);
    }

    // Links.
    const links = new Adw.PreferencesGroup({ title: _('Links') });
    page.add(links);
    const url = metadata.url ?? '';
    const linkRow = (title, subtitle, target, icon) => {
        const row = new Adw.ActionRow({ title, subtitle, activatable: true });
        row.add_suffix(new Gtk.Image({ icon_name: icon }));
        row.connect('activated', () => target());
        links.add(row);
        return row;
    };
    const rows = {};
    if (url) {
        rows.source = linkRow(_('Source code'), url.replace(/^https?:\/\//, ''), () => openUri(url, rows.source), 'adw-external-link-symbolic');
        rows.issues = linkRow(_('Report a problem'), _('Opens the issue tracker'), () => openUri(`${url}/issues`, rows.issues), 'adw-external-link-symbolic');
    }
    rows.copy = linkRow(_('Copy details'), _('The extension\'s and the system\'s versions, for a bug report'), async () => {
        const textOut = detailsText(metadata, await readMachine().catch(() => null), await shellVersion());
        const bytes = new GLib.Bytes(new TextEncoder().encode(textOut));
        rows.copy.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
        rows.copy.subtitle = _('Copied');
        rows.copied = textOut;
    }, 'edit-copy-symbolic');

    // Credits.
    const credits = new Adw.PreferencesGroup();
    page.add(credits);
    credits.add(new Gtk.Label({
        label: fill(_('Made by {author} · © {year} · MIT licence'), { author: AUTHOR, year: YEAR }),
        css_classes: ['dim-label', 'rp-credits'], margin_top: 6,
    }));

    return { page, hero, art, name, chips, figures: figureBoxes, tiles, rows, state, stopPulse };
}
