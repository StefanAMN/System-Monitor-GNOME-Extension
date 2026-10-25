// The Diagnostics page's second section: one button that hands the findings to
// a coding agent. The user picks an installed agent, an app or a terminal
// program; the report (agentreport.js) is written to a folder of its own and
// the agent opened there with the prompt. GTK side (preferences process).
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { TYPED, CLIPBOARD, findProgram, findTargets, agentArgv, terminalArgv, promptText, LaunchError } from '../../lib/common/agentlaunch.js';
import { _, fill } from '../../lib/common/i18n.js';

export const REPORT_NAME = 'report.md';

export function agentDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'resource-pulse', 'agent']);
}

/** Write the report where the agent will run: a private folder, the file replaced whole. */
export function writeReport(dir, text) {
    GLib.mkdir_with_parents(dir, 0o700);
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, REPORT_NAME]));
    file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return file.get_path();
}

function copyText(widget, text) {
    // set_text() is not introspectable; a bytes provider is the same thing.
    const bytes = new GLib.Bytes(new TextEncoder().encode(text));
    widget.get_clipboard().set_content(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes));
}

/**
 * @param {Gio.Settings} settings
 * @param {object} opts
 * @param {function(): Promise<string>} opts.makeReport the report as Markdown
 * @param {string} [opts.dir] where report.md goes and the agent runs
 * @param {function(string): ?string} [opts.which] terminal lookup, for tests
 * @param {function(string): ?string} [opts.find] agent program lookup, for tests
 * @param {function(string): ?object} [opts.findApp] desktop app lookup, for tests
 * @param {function(string[], string): Gio.Subprocess} [opts.spawn] for tests
 * @param {function(object, ?string): void} [opts.openApp] for tests
 * @param {function(string, Gtk.Widget): Promise<string>} [opts.confirm] asks before the first
 *   hand-off to an agent; resolves to 'open', 'preview' or 'cancel'
 */
export function buildAgentGroup(settings, {
    makeReport,
    dir = agentDir(),
    which = GLib.find_program_in_path,
    find = findProgram,
    findApp = id => Gio.DesktopAppInfo.new(id),
    spawn = (argv, cwd) => {
        const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
        launcher.set_cwd(cwd);
        return launcher.spawnv(argv);
    },
    openApp = (app, uri) => {
        if (uri) app.launch_uris([uri], null);
        else app.launch([], null);
    },
    confirm = confirmDialog,
} = {}) {
    // What is sent, and where, is said in the first-use confirmation.
    const group = new Adw.PreferencesGroup();

    const menu = new Gtk.MenuButton({ label: _('Fix with an agent'), halign: Gtk.Align.START, always_show_arrow: true });
    menu.add_css_class('suggested-action');
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
    const popover = new Gtk.Popover({ child: list });
    popover.add_css_class('rp-agent-menu');
    menu.popover = popover;
    group.add(menu);
    const status = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_top: 8, css_classes: ['dim-label'] });
    group.add(status);

    const say = (text, error = false) => {
        status.label = text;
        status.visible = !!text;
        if (error) status.add_css_class('error');
        else status.remove_css_class('error');
    };
    const state = { launched: null, opened: null, running: false, preview: null, entries: new Map() };

    /** Start the agent the report was written for, and tell the user what is left to do. */
    const launch = (agent, prompt) => {
        if (agent.path) {
            const argv = terminalArgv(dir, agentArgv(agent, prompt), which);
            const proc = spawn(argv, dir);
            state.launched = { argv, dir };
            proc?.wait_async?.(null, (p, res) => {
                try {
                    p.wait_finish(res);
                } catch (e) {
                    say(e.message, true);
                    return;
                }
                if (p.get_if_exited() && p.get_exit_status() !== 0)
                    say(fill(_('The terminal ended with an error (exit {code}).'), { code: p.get_exit_status() }), true);
            });
        } else {
            const uri = agent.uri?.(prompt, dir) ?? null;
            openApp(agent.app, uri);
            state.opened = { id: agent.id, uri };
        }
    };

    const pick = async agent => {
        if (state.running) return;
        state.running = true;
        menu.sensitive = false;
        popover.popdown();
        try {
            const consent = settings.get_strv('agent-consent');
            if (!consent.includes(agent.id)) {
                const answer = await confirm(agent.name, group);
                if (answer === 'preview') state.preview = showPreview(group, await makeReport());
                if (answer !== 'open') return;
                settings.set_strv('agent-consent', [...consent, agent.id]);
            }
            const path = writeReport(dir, await makeReport());
            // Nothing tells a pasted prompt which folder "this folder" is.
            const prompt = agent.prompt === CLIPBOARD ? `${promptText()}\n\n${fill(_('report.md is {path}'), { path })}` : promptText();
            if (agent.prompt === CLIPBOARD) copyText(menu, prompt);
            launch(agent, prompt);
            if (agent.prompt === TYPED) say(fill(_('{agent} is open with the prompt typed. Press Enter to begin.'), { agent: agent.name }));
            else if (agent.prompt === CLIPBOARD) say(fill(_('{agent} is open and the prompt is copied. Paste it and press Enter.'), { agent: agent.name }));
            else say(fill(_('{agent} started in a terminal and is reading the report.'), { agent: agent.name }));
        } catch (e) {
            say(e instanceof LaunchError ? e.message : fill(_('Could not start it: {error}'), { error: e.message }), true);
        } finally {
            state.running = false;
            menu.sensitive = true;
        }
    };

    const addSection = (title, agents) => {
        if (agents.length === 0) return;
        const heading = new Gtk.Label({ label: title, xalign: 0, margin_start: 8, margin_top: list.get_first_child() ? 8 : 2, margin_bottom: 2 });
        heading.add_css_class('caption-heading');
        heading.add_css_class('dim-label');
        list.append(heading);
        for (const agent of agents) {
            const entry = new Gtk.Button({ child: new Gtk.Label({ label: agent.name, xalign: 0 }) });
            entry.add_css_class('flat');
            entry.connect('clicked', () => pick(agent));
            list.append(entry);
            state.entries.set(agent.id, entry);
        }
    };

    // Read each time it opens, so an agent installed meanwhile shows up.
    const fillList = () => {
        for (let child = list.get_first_child(); child; child = list.get_first_child()) list.remove(child);
        state.entries.clear();
        const { apps, terminal } = findTargets(find, findApp);
        addSection(_('Apps'), apps);
        addSection(_('Terminal'), terminal);
        if (apps.length + terminal.length === 0)
            list.append(new Gtk.Label({ label: _('No agent was found'), margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 }));
    };
    fillList();
    popover.connect('show', fillList);

    const dispose = () => {};
    return { group, menu, popover, status, state, pick, dispose };
}

/** Before the first hand-off to an agent: what goes where. */
function confirmDialog(agentName, parent) {
    const dialog = new Adw.AlertDialog({
        heading: fill(_('Send the report to {agent}?'), { agent: agentName }),
        body: _('The agent reads report.md and sends it to its service to work on it. The report holds app names, processor, memory and network figures, and the computer\'s model and system version; no files, user name or host name. The agent asks before it changes anything.'),
        close_response: 'cancel',
        default_response: 'open',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('preview', _('Preview report'));
    dialog.add_response('open', _('Open'));
    dialog.set_response_appearance('open', Adw.ResponseAppearance.SUGGESTED);
    return new Promise(resolve => {
        dialog.connect('response', (_d, response) => resolve(response));
        dialog.present(parent);
    });
}

/** The report as it will be sent, read-only, with a copy button. */
function showPreview(parent, text) {
    const view = new Gtk.TextView({
        editable: false, cursor_visible: false, monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 12, bottom_margin: 12, left_margin: 12, right_margin: 12,
    });
    view.buffer.text = text;
    view.update_property([Gtk.AccessibleProperty.LABEL], [_('Report')]);
    const copy = new Gtk.Button({ label: _('Copy report') });
    copy.connect('clicked', () => {
        copyText(copy, text);
        copy.label = _('Copied');
    });
    const header = new Adw.HeaderBar();
    header.pack_start(copy);
    const toolbar = new Adw.ToolbarView({ content: new Gtk.ScrolledWindow({ child: view, vexpand: true }) });
    toolbar.add_top_bar(header);
    const dialog = new Adw.Dialog({ title: REPORT_NAME, content_width: 720, content_height: 640, child: toolbar });
    dialog.reportView = view;
    dialog.present(parent);
    return dialog;
}
