// Top-process lists (CPU, Memory, Disk) and ending processes from them.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';

import { canEnd, liveMembers, signalProcesses } from '../../lib/collectors/process.js';
import { ProgressBar } from './widgets.js';
import { formatBytes, formatSpeed } from '../../lib/common/format.js';
import { PROCESS_ROWS } from './constants.js';
import { spokenValue } from '../../lib/common/present.js';
import { _, fill, ngettext, N_, translated } from '../../lib/common/i18n.js';

// How a row's value is read out, by list: "firefox, 12% CPU".
const SPOKEN_MODE = translated({ cpu: N_('{process}, {value} CPU, opens System Monitor'), memory: N_('{process}, {value} memory, opens System Monitor'), disk: N_('{process}, {value} disk, opens System Monitor') });

export class ProcessesMethods {
    /** A timer that disable() ends early (resolving false), so no flow outlives the session. */
    _wait(ms) {
        return new Promise(resolve => {
            if (!this._waits) {
                resolve(false);
                return;
            }
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._waits?.delete(id);
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
            this._waits.set(id, resolve);
        });
    }

    /**
     * A page's process search: names containing the text, instead of the
     * busiest five; and the line said when nothing matches.
     * @param {'cpu'|'memory'|'disk'} mode
     */
    _buildProcFilter(mode) {
        this._procFilters ??= { cpu: '', memory: '', disk: '' };
        const entry = new St.Entry({
            style_class: 'rp-proc-filter', hint_text: _('Filter by name'), can_focus: true, x_expand: true,
            accessible_name: _('Filter the processes by name'),
        });
        const noMatch = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.85em;', visible: false });
        noMatch.clutter_text.line_wrap = true;
        entry.clutter_text.connect('text-changed', () => {
            this._procFilters[mode] = entry.text;
            // The matches now, not at the next tick (not when the menu
            // closing empties the field).
            if (this._menuOpen) this._poll();
        });
        // Backspace edits the text here instead of leaving the page. Escape
        // never arrives: the shell's menu takes it and closes the menu,
        // which ends the search (_clearProcSearch).
        (this._procSearch ??= {})[mode] = { entry, noMatch };
        return { entry, noMatch };
    }

    /** A search lasts while the menu is open: closing it empties the fields. */
    _clearProcSearch() {
        for (const { entry, noMatch } of Object.values(this._procSearch ?? {})) {
            entry.text = '';
            noMatch.visible = false;
        }
    }

    /** The confirmation line under a process list. */
    _buildEndBar() {
        // The message on its own (wrapping) line, the buttons under it.
        const box = new St.BoxLayout({ visible: false, vertical: true, style: 'spacing: 6px; padding-top: 8px;' });
        const label = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.85em;', x_expand: true });
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const buttons = new St.BoxLayout({ style: 'spacing: 8px;', x_align: Clutter.ActorAlign.END });
        const confirm = new St.Button({ style_class: 'rp-end-confirm', label: _('End'), can_focus: true });
        const cancel = new St.Button({ style_class: 'rp-chip-bg rp-end-cancel', label: _('Cancel'), can_focus: true });
        buttons.add_child(confirm);
        buttons.add_child(cancel);
        box.add_child(label);
        box.add_child(buttons);
        const bar = { box, label, confirm, cancel, target: null, step: 'idle', run: 0 };
        confirm.connect('clicked', () => {
            if (bar.step === 'confirm') this._endGroup(bar, 'TERM');
            else if (bar.step === 'force') this._endGroup(bar, 'KILL');
        });
        cancel.connect('clicked', () => this._hideEndBar(bar));
        this._addClickAnimations(confirm);
        this._addClickAnimations(cancel);
        return bar;
    }

    _hideEndBar(bar) {
        bar.run++;
        bar.step = 'idle';
        bar.target = null;
        bar.box.visible = false;
    }

    _showEndBar(bar, text, { confirm = null, cancel = null } = {}) {
        bar.label.text = text;
        bar.confirm.visible = !!confirm;
        if (confirm) bar.confirm.label = confirm;
        bar.cancel.visible = !!cancel;
        if (cancel) bar.cancel.label = cancel;
        bar.box.visible = true;
    }

    /** First step: ask. The group is copied, so later re-sorting cannot change the target. */
    _askEnd(bar, group) {
        bar.run++;
        bar.target = { comm: group.comm, count: group.count, members: group.members.map(m => ({ ...m })) };
        bar.step = 'confirm';
        const text = group.count > 1
            ? fill(_('End all {n} {process} processes? Unsaved work in them may be lost.'), { n: group.count, process: group.comm })
            : fill(_('End {process}? Unsaved work in it may be lost.'), { process: group.comm });
        this._showEndBar(bar, text, { confirm: _('End'), cancel: _('Cancel') });
        bar.confirm.grab_key_focus();
    }

    /** Ask the processes to quit (TERM), or force them (KILL), then report what is left. */
    async _endGroup(bar, signal) {
        const run = ++bar.run;
        const gen = this._gen;
        const { comm } = bar.target;
        const { mine, others } = liveMembers(bar.target.members, this._uid);
        if (mine.length === 0) {
            bar.step = 'done';
            this._showEndBar(bar, others > 0
                ? fill(_('{process} belongs to another user and cannot be ended from here.'), { process: comm })
                : fill(_('{process} has already exited.'), { process: comm }), { cancel: _('Close') });
            return;
        }
        bar.step = 'waiting';
        this._showEndBar(bar, fill(signal === 'TERM' ? _('Asking {process} to quit…') : _('Forcing {process} to quit…'), { process: comm }));
        const sent = await signalProcesses(mine, signal);
        // Quitting cleanly can take a moment (saving, closing files).
        if (!(await this._wait(signal === 'TERM' ? 5000 : 1000)) || gen !== this._gen || run !== bar.run) return;
        const left = liveMembers(bar.target.members, this._uid).mine;
        const note = !sent.ok && sent.error ? ` (${sent.error})` : '';
        if (left.length === 0) {
            bar.step = 'done';
            this._showEndBar(bar, fill(_('{process} ended.'), { process: comm }));
            if (await this._wait(3000) && gen === this._gen && run === bar.run) this._hideEndBar(bar);
        } else if (signal === 'TERM') {
            bar.step = 'force';
            this._showEndBar(bar, fill(_('{left} of {all} {process} did not quit{error}. Force quit loses unsaved work.'),
                { left: left.length, all: mine.length, process: comm, error: note }),
            { confirm: _('Force quit'), cancel: _('Cancel') });
            bar.confirm.grab_key_focus();
        } else {
            bar.step = 'done';
            this._showEndBar(bar, fill(_('{left} {process} could not be ended{error}.'), { left: left.length, process: comm, error: note }), { cancel: _('Close') });
        }
    }

    /** @param {'cpu'|'memory'|'disk'} mode what the rows show and are sorted by */
    _renderProcessListUI(container, targetWidgetsKey, processes, mode = 'cpu') {
        const isMemory = mode === 'memory';
        if (!container) return;
        if (!this[targetWidgetsKey]) this[targetWidgetsKey] = [];

        // All rows are built on first use and never rebuilt: a list whose
        // length changes from poll to poll (the Disk page shows only active
        // processes) hides the spare rows, so its actor count stays fixed.
        const rowsWanted = Math.max(processes.length, PROCESS_ROWS);
        if (this[targetWidgetsKey].length < rowsWanted) {
            for (let i = this[targetWidgetsKey].length; i < rowsWanted; i++) {
                const item = new St.BoxLayout({
                    style: 'padding: 6px 8px; spacing: 8px; border-radius: 8px;',
                    style_class: 'resource-pulse-process-item',
                    y_align: Clutter.ActorAlign.CENTER,
                    reactive: true,
                    can_focus: true,
                    accessible_role: Atk.Role.LIST_ITEM
                });

                const iconBox = new St.BoxLayout({ style_class: 'rp-chip-bg', style: 'width: 24px; height: 24px; border-radius: 6px;', y_align: Clutter.ActorAlign.CENTER });
                const icon = new St.Icon({ icon_name: 'application-x-executable-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px;' });
                iconBox.add_child(icon);
                item.add_child(iconBox);

                const detailsCol = new St.BoxLayout({ vertical: true, x_expand: true });
                const nameLbl = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: 500;', text: '' });
                detailsCol.add_child(nameLbl);

                const color = isMemory ? [0.569, 0.255, 0.675] : mode === 'disk' ? [0.96, 0.83, 0.18] : [0.208, 0.518, 0.894];
                const pbar = new ProgressBar(4, color[0], color[1], color[2]);
                detailsCol.add_child(pbar);

                item.add_child(detailsCol);

                const statLbl = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.85em; font-weight: 600; text-align: right;', width: mode === 'cpu' ? 52 : 76 });
                statLbl.x_align = Clutter.ActorAlign.END;
                item.add_child(statLbl);

                const endBtn = new St.Button({
                    style_class: 'rp-end-button',
                    can_focus: true,
                    accessible_name: _('End process'),
                    y_align: Clutter.ActorAlign.CENTER,
                    child: new St.Icon({ icon_name: 'window-close-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 12px;' }),
                });
                const widgets = { nameLbl, statLbl, pbar, endBtn, group: null };
                endBtn.connect('clicked', () => {
                    if (widgets.group) this._askEnd({ cpu: this._procEnd, memory: this._memProcEnd, disk: this._dskProcEnd }[mode], widgets.group);
                });

                item.add_child(endBtn);

                // A press on the ✕ is its own: the row neither opens System
                // Monitor nor plays its press animation, which shrinks the
                // row about its centre and would move the ✕ away from under
                // the pointer before the release (losing the click).
                const onEnd = event => endBtn.contains(global.stage.get_event_actor(event));
                const open = () => {
                    this._launchSystemMonitor('processes');
                    this._indicator.menu.close();
                    return Clutter.EVENT_STOP;
                };
                item.connect('button-press-event', (actor, event) => (onEnd(event) ? Clutter.EVENT_PROPAGATE : open()));
                // From the keyboard too, as the overview cards do.
                item.connect('key-press-event', (actor, event) => {
                    const sym = event.get_key_symbol();
                    if (sym !== Clutter.KEY_Return && sym !== Clutter.KEY_KP_Enter && sym !== Clutter.KEY_space)
                        return Clutter.EVENT_PROPAGATE;
                    return open();
                });
                this._addClickAnimations(item, onEnd);

                container.add_child(item);
                widgets.item = item;
                this[targetWidgetsKey].push(widgets);
            }
        }

        const useGiB = this._settings.get_string('unit-mem') === 'GiB';
        this[targetWidgetsKey].forEach((w, i) => {
            w.item.visible = i < processes.length;
            if (i >= processes.length) w.group = null;
        });
        processes.forEach((proc, i) => {
            const w = this[targetWidgetsKey][i];
            if (!w) return;
            w.nameLbl.text = proc.count > 1 ? `${proc.comm}  ×${proc.count}` : proc.comm;
            if (mode === 'disk') {
                // Relative to the busiest row: there is no natural 100 %.
                const top = processes[0]?.ioRate || 0;
                w.statLbl.text = formatSpeed(proc.ioRate);
                w.pbar.setPercent(top > 0 ? (proc.ioRate / top) * 100 : 0);
            } else {
                const valNum = isMemory ? proc.mem : proc.cpu;
                w.statLbl.text = isMemory ? formatBytes(proc.rssBytes, useGiB) : `${valNum.toFixed(1)}%`;
                w.pbar.setPercent(Math.min(100, valNum));
            }
            w.group = proc;
            // Process lists change with samples, not glide frames.
            const who = proc.count > 1 ? fill(ngettext('{process}, {n} process', '{process}, {n} processes', proc.count), { process: proc.comm, n: proc.count }) : proc.comm;
            w.item.accessible_name = fill(SPOKEN_MODE[mode], { process: who, value: spokenValue(w.statLbl.text) });
            // Hidden but still taking its room, so the values stay aligned.
            const endable = canEnd(proc, this._selfPid);
            w.endBtn.opacity = endable ? 255 : 0;
            w.endBtn.reactive = endable;
            w.endBtn.can_focus = endable;
            w.endBtn.accessible_name = endable ? fill(_('End {process}'), { process: who }) : '';
        });
    }
}
