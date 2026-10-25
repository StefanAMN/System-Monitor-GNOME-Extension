// The Diagnostics page's second section: hand the findings to a coding agent.
// Writes report.md (agentreport.js) into a folder of its own and opens the
// agent the user picked in a terminal there, with a prompt to fix what the
// report lists. GTK side (preferences process).
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { AGENTS, findAgents, findTerminals, agentArgv, terminalArgv, promptText, LaunchError } from '../../lib/common/agentlaunch.js';
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
 * @param {function(string): ?string} [opts.which] program lookup, for tests
 * @param {function(string[], string): Gio.Subprocess} [opts.spawn] for tests
 * @param {function(string, Gtk.Widget): Promise<string>} [opts.confirm] asks before the first
 *   hand-off to an agent; resolves to 'open', 'preview' or 'cancel'
 */
export function buildAgentGroup(settings, {
    makeReport,
    dir = agentDir(),
    which = GLib.find_program_in_path,
    spawn = (argv, cwd) => {
        const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.NONE });
        launcher.set_cwd(cwd);
        return launcher.spawnv(argv);
    },
    confirm = confirmDialog,
} = {}) {
    const group = new Adw.PreferencesGroup({
        title: _('Fix with an agent'),
        description: _('A coding agent reads the findings from report.md and offers fixes.'),
    });

    // Agent: the presets found on PATH, then a command of the user's own.
    const agents = [...findAgents(which), { id: 'custom', name: _('Custom command') }];
    const agentRow = new Adw.ComboRow({ title: _('Agent'), model: Gtk.StringList.new(agents.map(a => a.name)) });
    if (agents.length === 1) agentRow.subtitle = fill(_('{agents} not found'), { agents: AGENTS.map(a => a.name).join(', ') });
    group.add(agentRow);
    const commandRow = new Adw.EntryRow({ title: _('Command ({prompt} = the prompt)') });
    settings.bind('agent-command', commandRow, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(commandRow);

    const terminals = [{ id: 'auto', name: _('Default terminal') }, ...findTerminals(which).map(t => ({ id: t.id, name: _(t.name) }))];
    const terminalRow = new Adw.ComboRow({ title: _('Terminal'), model: Gtk.StringList.new(terminals.map(t => t.name)) });
    group.add(terminalRow);

    const promptRow = new Adw.ExpanderRow({ title: _('Prompt') });
    const promptView = new Gtk.TextView({
        wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 8, bottom_margin: 8, left_margin: 10, right_margin: 10,
        css_classes: ['rp-prompt'],
    });
    promptView.update_property([Gtk.AccessibleProperty.LABEL], [_('Prompt')]);
    promptView.buffer.text = promptText(settings.get_string('agent-prompt'));
    const promptBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12 });
    promptBox.append(new Gtk.Frame({ child: promptView }));
    const reset = new Gtk.Button({ label: _('Use the built-in prompt'), halign: Gtk.Align.END });
    promptBox.append(reset);
    promptRow.add_row(promptBox);
    group.add(promptRow);

    const buttons = new Gtk.Box({ spacing: 8, halign: Gtk.Align.START, margin_top: 12 });
    const preview = new Gtk.Button({ label: _('Preview report') });
    const copyPrompt = new Gtk.Button({ label: _('Copy prompt'), tooltip_text: _('Write report.md and copy the prompt, to run the agent yourself') });
    const open = new Gtk.Button({ css_classes: ['suggested-action'] });
    buttons.append(preview);
    buttons.append(copyPrompt);
    buttons.append(open);
    group.add(buttons);
    const status = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_top: 8, css_classes: ['dim-label'] });
    group.add(status);

    const selectedAgent = () => agents[agentRow.selected] ?? agents[0];
    const selectedTerminal = () => terminals[terminalRow.selected] ?? terminals[0];
    const say = (text, error = false) => {
        status.label = text;
        status.visible = !!text;
        if (error) status.add_css_class('error');
        else status.remove_css_class('error');
    };
    const syncRows = () => {
        const agent = selectedAgent();
        commandRow.visible = agent.id === 'custom';
        open.label = agent.id === 'custom' ? _('Open agent') : fill(_('Open {agent}'), { agent: agent.name });
    };

    // Settings <-> rows. An agent or terminal that is no longer installed reads as the first one.
    const fromSettings = () => {
        const agentIndex = agents.findIndex(a => a.id === settings.get_string('agent'));
        agentRow.selected = Math.max(0, agentIndex);
        const terminalIndex = terminals.findIndex(t => t.id === settings.get_string('agent-terminal'));
        terminalRow.selected = Math.max(0, terminalIndex);
        syncRows();
    };
    fromSettings();
    const handlers = [
        settings.connect('changed::agent', fromSettings),
        settings.connect('changed::agent-terminal', fromSettings),
    ];
    agentRow.connect('notify::selected', () => {
        if (settings.get_string('agent') !== selectedAgent().id) settings.set_string('agent', selectedAgent().id);
        syncRows();
    });
    terminalRow.connect('notify::selected', () => {
        if (settings.get_string('agent-terminal') !== selectedTerminal().id) settings.set_string('agent-terminal', selectedTerminal().id);
    });
    // The built-in prompt is not stored: it follows the user's language.
    promptView.buffer.connect('changed', () => {
        const text = promptView.buffer.text;
        settings.set_string('agent-prompt', text === promptText('') ? '' : text);
    });
    reset.connect('clicked', () => {
        promptView.buffer.text = promptText('');
    });

    const prompt = () => promptText(promptView.buffer.text);
    const state = { launched: null, running: false, preview: null };

    preview.connect('clicked', async () => {
        try {
            state.preview = showPreview(group, await makeReport());
        } catch (e) {
            say(fill(_('The report could not be made: {error}'), { error: e.message }), true);
        }
    });

    copyPrompt.connect('clicked', async () => {
        try {
            const path = writeReport(dir, await makeReport());
            copyText(copyPrompt, `${prompt()}\n\n${fill(_('report.md is {path}'), { path })}`);
            say(fill(_('Prompt copied. The report is in {dir}; start your agent there.'), { dir }));
        } catch (e) {
            say(fill(_('The report could not be written: {error}'), { error: e.message }), true);
        }
    });

    open.connect('clicked', async () => {
        if (state.running) return;
        state.running = true;
        open.sensitive = false;
        try {
            const agent = selectedAgent();
            const consent = settings.get_strv('agent-consent');
            if (!consent.includes(agent.id)) {
                const answer = await confirm(agent.id === 'custom' ? _('your agent') : agent.name, group);
                if (answer === 'preview') state.preview = showPreview(group, await makeReport());
                if (answer !== 'open') return;
                settings.set_strv('agent-consent', [...consent, agent.id]);
            }
            const cmd = agentArgv({ agent: agent.id, command: settings.get_string('agent-command'), prompt: prompt(), reportPath: REPORT_NAME });
            if (!which(cmd[0]) && !GLib.path_is_absolute(cmd[0])) throw new LaunchError(fill(_('"{program}" was not found.'), { program: cmd[0] }));
            writeReport(dir, await makeReport());
            const argv = terminalArgv(selectedTerminal().id, dir, cmd, which);
            const proc = spawn(argv, dir);
            state.launched = { argv, dir };
            say(fill(_('Started in a terminal, in {dir}.'), { dir }));
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
        } catch (e) {
            say(e instanceof LaunchError ? e.message : fill(_('Could not start it: {error}'), { error: e.message }), true);
        } finally {
            state.running = false;
            open.sensitive = true;
        }
    });

    const dispose = () => {
        for (const id of handlers) settings.disconnect(id);
        handlers.length = 0;
    };
    return { group, agentRow, terminalRow, commandRow, promptRow, promptView, preview, copyPrompt, open, status, state, dispose };
}

/** Before the first hand-off to an agent: what goes where. */
function confirmDialog(agentName, parent) {
    const dialog = new Adw.AlertDialog({
        heading: fill(_('Send the report to {agent}?'), { agent: agentName }),
        body: _('The agent reads report.md and sends it to its service to work on it. The report holds app names, processor, memory and network figures, and the computer\'s model and system version; no files, user name or host name. The agent runs in a terminal and asks before it changes anything.'),
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
