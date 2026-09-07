// The preferences window's Diagnostics page: advice for a longer runtime per
// charge and a longer battery life, from the tracked history and the
// machine's current state. GTK side (preferences process).
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { diagnose } from '../lib/diagnostics.js';
import { appInfo } from '../lib/appnames.js';
import { readSystemState, setPowerProfile } from '../lib/systemstate.js';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const GOALS = [
    ['runtime', 'Longer runtime per charge'],
    ['lifespan', 'Longer battery life'],
    ['data', 'About these readings'],
];
const SEVERITY_ICONS = {
    warning: 'dialog-warning-symbolic',
    suggestion: 'power-profile-power-saver-symbolic',
    info: 'dialog-information-symbolic',
};

/** "Saves about 0.6 W, about 24 min more per full charge." */
export function estimateText(estimate) {
    if (!estimate) return '';
    const watts = estimate.watts < 0.1 ? estimate.watts.toFixed(2) : estimate.watts.toFixed(1);
    const minutes = estimate.minutes !== null ? `, about ${Math.round(estimate.minutes)} min more per full charge` : '';
    return `Saves about ${watts} W${minutes}.`;
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
} = {}) {
    const page = new Adw.PreferencesPage({ title: 'Diagnostics', name: 'diagnostics', icon_name: 'dialog-information-symbolic' });
    const intro = new Adw.PreferencesGroup({
        description: 'Based on the last 7 days of battery tracking and on how the machine is set up now. ' +
            'Advice about apps needs tracking to be on.',
    });
    page.add(intro);
    const again = new Gtk.Button({ label: 'Check again', halign: Gtk.Align.START });
    intro.add(again);

    const groups = {};
    const lists = {};
    for (const [goal, title] of GOALS) {
        groups[goal] = new Adw.PreferencesGroup({ title });
        lists[goal] = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list'] });
        groups[goal].add(lists[goal]);
        page.add(groups[goal]);
    }
    const state = { findings: [], system: null, running: false, gen: 0 };

    const row = finding => {
        const lines = [finding.detail, finding.evidence, estimateText(finding.estimate)].filter(Boolean);
        const r = new Adw.ActionRow({ title: finding.title, subtitle: lines.join('\n'), subtitle_lines: 0 });
        r.findingId = finding.id;
        r.add_prefix(new Gtk.Image({ icon_name: SEVERITY_ICONS[finding.severity], valign: Gtk.Align.START, margin_top: 12 }));
        if (finding.action) {
            const button = new Gtk.Button({ label: finding.action.label, valign: Gtk.Align.CENTER });
            button.connect('clicked', async () => {
                button.sensitive = false;
                try {
                    if (finding.action.kind === 'power-profile') await switchProfile(finding.action.value);
                    else if (finding.action.kind === 'open-power-settings') launch(['gnome-control-center', 'power']);
                } catch (e) {
                    r.subtitle = `${r.subtitle}\nCould not do it: ${e.message}`;
                }
                await refresh();
            });
            r.add_suffix(button);
            r.actionButton = button;
        }
        return r;
    };

    const render = () => {
        for (const [goal] of GOALS) {
            const list = lists[goal];
            list.remove_all();
            const mine = state.findings.filter(f => f.goal === goal);
            for (const finding of mine) list.append(row(finding));
            groups[goal].visible = mine.length > 0 || goal === 'runtime';
            if (goal === 'runtime' && mine.length === 0) {
                list.append(new Adw.ActionRow({
                    title: state.system ? 'Nothing to improve was found' : 'Checking…',
                    subtitle: history.ledger.buckets.length === 0 ? 'Start tracking on the Tracking page for advice about apps.' : '',
                }));
            }
        }
    };

    const refresh = async () => {
        const gen = ++state.gen;
        state.running = true;
        try {
            const system = await readState();
            if (gen !== state.gen) return;
            const from = Date.now() - WEEK_MS;
            state.system = system;
            state.findings = diagnose({
                battery: history.ledger.summarize({ from, batteryOnly: true }),
                all: history.ledger.summarize({ from }),
                state: system,
                appName: id => appInfo(id).name,
            });
        } catch (e) {
            console.error(`ResourcePulse: diagnostics failed: ${e.message}`);
            state.findings = [{ id: 'error', goal: 'data', severity: 'warning', title: 'The check failed', detail: e.message, evidence: '', estimate: null, action: null }];
        } finally {
            if (gen === state.gen) state.running = false;
        }
        render();
    };

    again.connect('clicked', () => {
        history.requestFlush();
        refresh();
    });
    const unsubscribe = history.subscribe(() => refresh());
    render();
    refresh();

    return { page, lists, groups, state, refresh, dispose: () => unsubscribe() };
}
