// The preferences window's Diagnostics page: what Resource Pulse finds on its
// own about unnecessary use of the processor, memory, battery and network,
// from the tracked history and the machine's current state. GTK side
// (preferences process).
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { diagnose, AREAS } from '../../lib/engine/diagnostics.js';
import { agentReport, codeSpan } from '../../lib/engine/agentreport.js';
import { buildAgentGroup } from './agent.js';
import { NetUsage, netUsagePath } from '../../lib/engine/netusage.js';
import { appInfo } from '../../lib/common/appnames.js';
import { readSystemState, setPowerProfile, readMachineInfo } from '../../lib/collectors/systemstate.js';
import { _, fill, ngettext, N_ } from '../../lib/common/i18n.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const AREA_TITLES = {
    cpu: N_('Processor'),
    memory: N_('Memory'),
    battery: N_('Battery'),
    network: N_('Network'),
    data: N_('About these readings'),
};
// The areas with a tile in the strip; 'data' (facts about the readings) has none.
const TILE_AREAS = ['cpu', 'memory', 'battery', 'network'];
const SEVERITY_ORDER = ['warning', 'suggestion', 'info'];
const SEVERITY_NAMES = { warning: N_('warning'), suggestion: N_('suggestion'), info: N_('note') };
const SEVERITY_ICONS = {
    warning: 'dialog-warning-symbolic',
    suggestion: 'power-profile-power-saver-symbolic',
    info: 'dialog-information-symbolic',
};

/** "Saves about 0.6 W, about 24 min more per full charge." */
export function estimateText(estimate) {
    if (!estimate) return '';
    const watts = estimate.watts < 0.1 ? estimate.watts.toFixed(2) : estimate.watts.toFixed(1);
    return estimate.minutes !== null
        ? fill(_('Saves about {watts} W, about {minutes} min more per full charge.'), { watts, minutes: Math.round(estimate.minutes) })
        : fill(_('Saves about {watts} W.'), { watts });
}

/** The same, short, for a finding's subtitle: "≈0.6 W · +24 min per charge". */
export function estimateShort(estimate) {
    if (!estimate) return '';
    const watts = estimate.watts < 0.1 ? estimate.watts.toFixed(2) : estimate.watts.toFixed(1);
    return estimate.minutes !== null
        ? fill(_('≈{watts} W · +{minutes} min per charge'), { watts, minutes: Math.round(estimate.minutes) })
        : fill(_('≈{watts} W'), { watts });
}

/**
 * The findings and the machine's state as plain text, for pasting into a
 * bug report or a question.
 * @param {object[]} findings from diagnose()
 * @param {?object} system from readSystemState()
 * @param {Date} [now]
 */
export function reportText(findings, system, now = new Date()) {
    const lines = [fill(_('Resource Pulse diagnostics, {time} UTC'), { time: now.toISOString().slice(0, 16).replace('T', ' ') })];
    if (system) {
        const b = system.battery;
        const parts = [
            system.onBattery === null || system.onBattery === undefined ? null : system.onBattery ? _('on battery') : _('on AC'),
            system.powerProfile ? fill(_('power profile {profile}'), { profile: system.powerProfile }) : null,
            Number.isFinite(system.backlight) ? fill(_('backlight {percent} %'), { percent: Math.round(system.backlight * 100) }) : null,
            b && Number.isFinite(b.healthPct)
                ? fill(Number.isFinite(b.cycles)
                    ? _('battery holds {percent} % of its design capacity after {cycles} cycles')
                    : _('battery holds {percent} % of its design capacity'), { percent: Math.round(b.healthPct), cycles: b.cycles })
                : null,
            b?.chargeLimit ? fill(_('charge limit {limit}'), { limit: b.chargeLimit }) : null,
            system.energyReadable === false ? _('processor energy not readable') : null,
        ].filter(Boolean);
        lines.push(fill(_('System: {state}'), { state: parts.join(', ') || _('unknown') }));
    } else {
        lines.push(_('System: not read yet'));
    }
    for (const area of AREAS) {
        const mine = findings.filter(f => f.area === area);
        if (mine.length === 0) continue;
        lines.push('', _(AREA_TITLES[area]));
        for (const f of mine) {
            const rest = [f.detail, f.evidence, estimateText(f.estimate)].filter(Boolean).join(' ');
            lines.push(`- [${f.severity}] ${f.title}${rest ? `: ${rest}` : ''}`);
        }
    }
    if (findings.length === 0) lines.push('', _('No findings.'));
    return lines.join('\n');
}

/**
 * The daily network totals the extension keeps, read only: a damaged or
 * half-written file is the extension's to deal with, so it is reported here
 * and never moved.
 * @returns {{days: Array<{day: string, rx: number, tx: number}>, problem: ?string}}
 */
export function readNetDays(path = netUsagePath()) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return { days: NetUsage.fromJSON(new TextDecoder().decode(bytes)).days, problem: null };
    } catch (e) {
        if (e.matches?.(GLib.FileError, GLib.FileError.NOENT)) return { days: [], problem: null };
        return { days: [], problem: e.message };
    }
}

/**
 * @param {HistorySource} history
 * @param {object} [opts]
 * @param {Gio.Settings} [opts.settings] the extension's settings: with them the page has the agent section
 * @param {object} [opts.agent] options for buildAgentGroup, for tests
 * @param {function(): Promise<object>} [opts.readMachine] for tests
 * @param {function(): Promise<object>} [opts.readState] for tests
 * @param {function(string): Promise} [opts.switchProfile] for tests
 * @param {function(Array<string>)} [opts.launch] for tests
 * @param {?function(string): Gio.Icon} [opts.iconFor] an area's icon (the Settings page's metric icons)
 */
export function buildDiagnosticsPage(history, {
    readState = () => readSystemState(),
    switchProfile = value => setPowerProfile(value),
    launch = argv => Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE),
    netDays = () => readNetDays(),
    settings = null,
    agent: agentOpts = {},
    readMachine = () => readMachineInfo(),
    iconFor = null,
} = {}) {
    const page = new Adw.PreferencesPage({ title: _('Diagnostics'), name: 'diagnostics', icon_name: 'dialog-information-symbolic' });

    // The area strip: a tile per area with its count of findings, which
    // filters the list; Check again and Copy report at its end. Where the
    // findings come from is the strip's tooltip.
    const overview = new Adw.PreferencesGroup();
    page.add(overview);
    const strip = new Gtk.Box({ spacing: 4, css_classes: ['rp-tabs', 'rp-diag-strip'] });
    const basis = _('From the last 7 days of usage tracking and how the machine is set up now, worked out on this computer. Advice about apps and memory needs tracking to be on.');
    strip.tooltip_text = basis;
    strip.update_property([Gtk.AccessibleProperty.DESCRIPTION], [basis]);
    overview.add(strip);
    const tiles = {};
    const state = { findings: [], system: null, running: false, gen: 0, filter: null };
    let filtering = false;
    for (const area of TILE_AREAS) {
        const name = _(AREA_TITLES[area]);
        const tile = new Gtk.ToggleButton({ css_classes: ['rp-tab'], hexpand: true });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.CENTER });
        const gicon = iconFor?.(area);
        if (gicon) box.append(new Gtk.Image({ gicon, pixel_size: 18, css_classes: [`rp-c-${area}`] }));
        box.append(new Gtk.Label({ label: name, css_classes: ['rp-tab-label'] }));
        tile.count = new Gtk.Label({ css_classes: ['rp-diag-count', 'numeric'] });
        box.append(tile.count);
        tile.set_child(box);
        tile.area = area;
        tile.name = name;
        // Pressed: only this area; pressed again: all of them.
        tile.connect('toggled', () => {
            if (filtering) return;
            filtering = true;
            try {
                state.filter = tile.active ? area : null;
                for (const other of Object.values(tiles)) {
                    if (other !== tile) other.active = false;
                    other.update_state([Gtk.AccessibleState.PRESSED], [other.active ? Gtk.AccessibleTristate.TRUE : Gtk.AccessibleTristate.FALSE]);
                    if (other.active) other.add_css_class(`rp-tint-${other.area}`);
                    else other.remove_css_class(`rp-tint-${other.area}`);
                }
            } finally {
                filtering = false;
            }
            applyFilter();
        });
        strip.append(tile);
        tiles[area] = tile;
    }
    const actions = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, valign: Gtk.Align.CENTER, margin_start: 4 });
    const icon = (name, tooltip) => {
        const button = new Gtk.Button({ icon_name: name, tooltip_text: tooltip, css_classes: ['flat'] });
        button.update_property([Gtk.AccessibleProperty.LABEL], [tooltip]);
        actions.append(button);
        return button;
    };
    const again = icon('view-refresh-symbolic', _('Check again'));
    const copy = icon('edit-copy-symbolic', _('Copy report'));
    strip.append(actions);

    // One list, warnings first; a row's area is its icon, its severity its edge.
    const listGroup = new Adw.PreferencesGroup();
    page.add(listGroup);
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'] });
    list.update_property([Gtk.AccessibleProperty.LABEL], [_('Findings')]);
    listGroup.add(list);
    const nothing = new Adw.ActionRow({ title: _('Checking…') });
    nothing.add_prefix(new Gtk.Image({ icon_name: 'object-select-symbolic', css_classes: ['rp-finding-ok'] }));
    const rows = [];

    // The report for an agent, from the same figures. Finding titles name
    // apps: there the names are code spans, like everywhere in the report.
    const makeReport = async () => {
        const from = Date.now() - WEEK_MS;
        const net = netDays();
        const inputs = {
            battery: history.ledger.summarize({ from, batteryOnly: true }),
            all: history.ledger.summarize({ from }),
            hours: history.ledger.hours({ from }),
            netDays: net.days,
        };
        const system = state.system ?? await readState();
        const findings = diagnose({ ...inputs, state: system, appName: id => codeSpan(appInfo(id).name), isApp: id => appInfo(id).desktop });
        return agentReport({ ...inputs, findings, system, machine: await readMachine(), appName: id => appInfo(id).name });
    };
    const agent = settings ? buildAgentGroup(settings, { makeReport, ...agentOpts }) : null;
    if (agent) page.add(agent.group);

    // A finding: its title and the saving; what it means and the figures
    // behind it open beneath.
    const row = finding => {
        const r = new Adw.ExpanderRow({ title: finding.title, subtitle: estimateShort(finding.estimate) });
        // Added, not set: css_classes would drop the row's own 'expander',
        // and themes then paint its header as a plain list (Orchis: white).
        r.add_css_class('rp-finding-row');
        r.add_css_class(`rp-edge-${finding.severity}`);
        r.findingId = finding.id;
        r.area = finding.area;
        r.severity = finding.severity;
        // The area's own icon and colour; facts about the readings, and an
        // area without an icon, show the severity's.
        const gicon = TILE_AREAS.includes(finding.area) ? iconFor?.(finding.area) : null;
        r.add_prefix(gicon
            ? new Gtk.Image({ gicon, css_classes: [`rp-c-${finding.area}`] })
            : new Gtk.Image({ icon_name: SEVERITY_ICONS[finding.severity], css_classes: [`rp-finding-${finding.severity}`] }));
        r.update_property([Gtk.AccessibleProperty.DESCRIPTION], [fill(_('{area}, {severity}'), { area: _(AREA_TITLES[finding.area]), severity: _(SEVERITY_NAMES[finding.severity]) })]);
        r.detailLabel = new Gtk.Label({
            label: [finding.detail, finding.evidence].filter(Boolean).join('\n'),
            xalign: 0, wrap: true, selectable: true, css_classes: ['dim-label'],
            margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 12,
        });
        r.add_row(r.detailLabel);
        if (finding.action) r.add_css_class('rp-finding-actionable');
        if (finding.action) {
            const button = new Gtk.Button({ label: finding.action.label, valign: Gtk.Align.CENTER });
            button.connect('clicked', async () => {
                button.sensitive = false;
                try {
                    if (finding.action.kind === 'power-profile') await switchProfile(finding.action.value);
                    else if (finding.action.kind === 'open-power-settings') launch(['gnome-control-center', 'power']);
                } catch (e) {
                    r.subtitle = fill(_('Could not do it: {error}'), { error: e.message });
                }
                await refresh();
            });
            r.add_suffix(button);
            r.actionButton = button;
        }
        return r;
    };

    // Shown or hidden by the area pressed in the strip; the nothing row
    // only with no advice at all, whatever the filter.
    const applyFilter = () => {
        for (const r of rows) r.visible = state.filter === null || r.area === state.filter;
    };

    const render = () => {
        list.remove_all();
        rows.length = 0;
        const sorted = [...state.findings].sort((a, b) =>
            SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || AREAS.indexOf(a.area) - AREAS.indexOf(b.area));
        for (const finding of sorted) {
            const r = row(finding);
            list.append(r);
            rows.push(r);
        }
        // Only facts about the readings themselves: still nothing to improve.
        const advice = state.findings.some(f => f.area !== 'data' && f.severity !== 'info');
        nothing.title = state.system ? _('Nothing to improve') : _('Checking…');
        if (!advice) list.prepend(nothing);
        for (const tile of Object.values(tiles)) {
            const mine = state.findings.filter(f => f.area === tile.area && f.severity !== 'info');
            const warn = mine.some(f => f.severity === 'warning');
            tile.count.label = mine.length ? String(mine.length) : '✓';
            tile.count.set_css_classes(['rp-diag-count', 'numeric', mine.length ? (warn ? 'rp-finding-warning' : 'rp-finding-suggestion') : 'rp-finding-ok']);
            tile.findings = mine.length;
            const said = mine.length ? fill(ngettext('{area}: {n} finding', '{area}: {n} findings', mine.length), { area: tile.name, n: mine.length }) : fill(_('{area}: nothing found'), { area: tile.name });
            tile.update_property([Gtk.AccessibleProperty.LABEL], [said]);
        }
        applyFilter();
    };

    const refresh = async () => {
        const gen = ++state.gen;
        state.running = true;
        try {
            const system = await readState();
            if (gen !== state.gen) return;
            const from = Date.now() - WEEK_MS;
            const net = netDays();
            if (net.problem) console.warn(`ResourcePulse: diagnostics cannot read the network totals: ${net.problem}`);
            state.system = system;
            state.findings = diagnose({
                battery: history.ledger.summarize({ from, batteryOnly: true }),
                all: history.ledger.summarize({ from }),
                hours: history.ledger.hours({ from }),
                netDays: net.days,
                state: system,
                appName: id => appInfo(id).name,
                isApp: id => appInfo(id).desktop,
            });
        } catch (e) {
            console.error(`ResourcePulse: diagnostics failed: ${e.message}`);
            state.findings = [{ id: 'error', area: 'data', severity: 'warning', title: _('The check failed'), detail: e.message, evidence: '', estimate: null, action: null }];
        } finally {
            if (gen === state.gen) state.running = false;
        }
        render();
    };

    again.connect('clicked', () => {
        history.requestFlush();
        refresh();
    });
    let copiedId = 0;
    copy.connect('clicked', () => {
        // set_text() is not introspectable; a bytes provider is the same thing.
        const bytes = new GLib.Bytes(new TextEncoder().encode(reportText(state.findings, state.system)));
        copy.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
        copy.icon_name = 'object-select-symbolic';
        copy.tooltip_text = _('Copied');
        if (copiedId) GLib.source_remove(copiedId);
        copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            copiedId = 0;
            copy.icon_name = 'edit-copy-symbolic';
            copy.tooltip_text = _('Copy report');
            return GLib.SOURCE_REMOVE;
        });
    });
    const unsubscribe = history.subscribe(() => refresh());
    render();
    refresh();

    const dispose = () => {
        agent?.dispose();
        unsubscribe();
        if (copiedId) GLib.source_remove(copiedId);
        copiedId = 0;
    };
    return { page, rows, tiles, list, nothing, agent, makeReport, state, refresh, copy, dispose };
}
