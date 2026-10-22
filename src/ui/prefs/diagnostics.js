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
import { NetUsage, netUsagePath } from '../../lib/engine/netusage.js';
import { appInfo } from '../../lib/common/appnames.js';
import { readSystemState, setPowerProfile } from '../../lib/collectors/systemstate.js';
import { _, fill, N_ } from '../../lib/common/i18n.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const AREA_TITLES = {
    cpu: N_('Processor'),
    memory: N_('Memory'),
    battery: N_('Battery'),
    network: N_('Network'),
    data: N_('About these readings'),
};
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
 * @param {function(): Promise<object>} [opts.readState] for tests
 * @param {function(string): Promise} [opts.switchProfile] for tests
 * @param {function(Array<string>)} [opts.launch] for tests
 */
export function buildDiagnosticsPage(history, {
    readState = () => readSystemState(),
    switchProfile = value => setPowerProfile(value),
    launch = argv => Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE),
    netDays = () => readNetDays(),
} = {}) {
    const page = new Adw.PreferencesPage({ title: _('Diagnostics'), name: 'diagnostics', icon_name: 'dialog-information-symbolic' });
    const intro = new Adw.PreferencesGroup({
        description: _('Based on the last 7 days of usage tracking and on how the machine is set up now. Advice about apps and memory needs tracking to be on.'),
    });
    page.add(intro);
    const buttons = new Gtk.Box({ spacing: 8, halign: Gtk.Align.START });
    const again = new Gtk.Button({ label: _('Check again') });
    const copy = new Gtk.Button({ label: _('Copy report'), tooltip_text: _('Copy the findings and the machine\'s state as text') });
    buttons.append(again);
    buttons.append(copy);
    intro.add(buttons);

    const found = new Adw.PreferencesGroup({
        title: _('Found by Resource Pulse'),
        description: _('Worked out on this computer from the tracked figures. Nothing is sent anywhere.'),
    });
    page.add(found);
    const nothing = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'] });
    const nothingRow = new Adw.ActionRow({ title: _('Checking…') });
    nothing.append(nothingRow);
    found.add(nothing);
    const groups = {};
    const lists = {};
    for (const area of AREAS) {
        groups[area] = new Adw.PreferencesGroup({ title: _(AREA_TITLES[area]) });
        lists[area] = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'] });
        lists[area].update_property([Gtk.AccessibleProperty.LABEL], [fill(_('Findings: {area}'), { area: _(AREA_TITLES[area]) })]);
        groups[area].add(lists[area]);
        page.add(groups[area]);
    }
    const state = { findings: [], system: null, running: false, gen: 0 };

    const row = finding => {
        const lines = [finding.detail, finding.evidence, estimateText(finding.estimate)].filter(Boolean);
        const r = new Adw.ActionRow({ title: finding.title, subtitle: lines.join('\n'), subtitle_lines: 0 });
        r.findingId = finding.id;
        r.add_prefix(new Gtk.Image({
            icon_name: SEVERITY_ICONS[finding.severity], valign: Gtk.Align.START, margin_top: 12,
            css_classes: [`rp-finding-${finding.severity}`],
        }));
        if (finding.action) r.add_css_class('rp-finding-actionable');
        if (finding.action) {
            const button = new Gtk.Button({ label: finding.action.label, valign: Gtk.Align.CENTER });
            button.connect('clicked', async () => {
                button.sensitive = false;
                try {
                    if (finding.action.kind === 'power-profile') await switchProfile(finding.action.value);
                    else if (finding.action.kind === 'open-power-settings') launch(['gnome-control-center', 'power']);
                } catch (e) {
                    r.subtitle = `${r.subtitle}\n${fill(_('Could not do it: {error}'), { error: e.message })}`;
                }
                await refresh();
            });
            r.add_suffix(button);
            r.actionButton = button;
        }
        return r;
    };

    const render = () => {
        for (const area of AREAS) {
            const list = lists[area];
            list.remove_all();
            const mine = state.findings.filter(f => f.area === area);
            for (const finding of mine) list.append(row(finding));
            groups[area].visible = mine.length > 0;
        }
        // Only facts about the readings themselves: still nothing to improve.
        const advice = state.findings.some(f => f.area !== 'data' && f.severity !== 'info');
        nothing.visible = !advice;
        nothingRow.title = state.system ? _('Nothing to improve was found') : _('Checking…');
        nothingRow.subtitle = history.ledger.buckets.length === 0 ? _('Start tracking on the Tracking page for advice about apps and memory.') : '';
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
        copy.label = _('Copied');
        if (copiedId) GLib.source_remove(copiedId);
        copiedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            copiedId = 0;
            copy.label = _('Copy report');
            return GLib.SOURCE_REMOVE;
        });
    });
    const unsubscribe = history.subscribe(() => refresh());
    render();
    refresh();

    const dispose = () => {
        unsubscribe();
        if (copiedId) GLib.source_remove(copiedId);
        copiedId = 0;
    };
    return { page, lists, groups, nothing, state, refresh, copy, dispose };
}
