// Top-process lists (CPU, Memory, Disk), and from them pausing, lowering the
// priority of and ending processes.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';

import { ensureActorVisibleInScrollView } from 'resource:///org/gnome/shell/misc/animationUtils.js';

import { canEnd, liveMembers, signalProcesses, groupState, reniceProcesses, LOWER_NICE } from '../../lib/collectors/process.js';
import { ProgressBar } from './widgets.js';
import { formatBytes, formatSpeed } from '../../lib/common/format.js';
import { PROCESS_ROWS } from './constants.js';
import { spokenValue } from '../../lib/common/present.js';
import { _, fill, ngettext, N_, translated } from '../../lib/common/i18n.js';
import { VERTICAL } from './compat.js';

// How a row's value is read out, by list: "firefox, 12% CPU".
const SPOKEN_MODE = translated({ cpu: N_('{process}, {value} CPU'), memory: N_('{process}, {value} memory'), disk: N_('{process}, {value} disk') });

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
            // Another list: an open action line belonged to the old one.
            const bar = this._actionBar(mode);
            if (bar?.box.visible) this._hideEndBar(bar);
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
        // Closing the panel closes the action lines too.
        for (const mode of ['cpu', 'memory', 'disk']) {
            const bar = this._actionBar(mode);
            if (bar?.box.visible) this._hideEndBar(bar);
        }
    }

    _actionBar(mode) {
        return { cpu: this._procEnd, memory: this._memProcEnd, disk: this._dskProcEnd }[mode];
    }

    /**
     * The action line of a process list, placed under the row it is for: what
     * to do with the process, then the confirmation to end it. Added to the
     * list itself (_placeEndBar moves it).
     */
    _buildEndBar() {
        // A message on its own (wrapping) line, the buttons under it.
        const box = new St.BoxLayout({ visible: false, ...VERTICAL, style_class: 'rp-proc-bar' });
        const label = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.85em;', x_expand: true });
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const buttons = new St.BoxLayout({ style: 'spacing: 8px;', x_align: Clutter.ActorAlign.END });
        const pause = new St.Button({ style_class: 'rp-chip-bg rp-proc-action', label: _('Pause'), can_focus: true, visible: false });
        const lower = new St.Button({ style_class: 'rp-chip-bg rp-proc-action', label: _('Lower priority'), can_focus: true, visible: false });
        const confirm = new St.Button({ style_class: 'rp-end-confirm', label: _('End'), can_focus: true });
        const cancel = new St.Button({ style_class: 'rp-chip-bg rp-end-cancel', label: _('Cancel'), can_focus: true });
        for (const b of [pause, lower, confirm, cancel]) buttons.add_child(b);
        box.add_child(label);
        box.add_child(buttons);
        const bar = { box, label, pause, lower, confirm, cancel, target: null, step: 'idle', run: 0 };
        confirm.connect('clicked', () => {
            if (bar.step === 'menu') this._askEnd(bar, bar.target);
            else if (bar.step === 'confirm') this._endGroup(bar, 'TERM');
            else if (bar.step === 'force') this._endGroup(bar, 'KILL');
        });
        pause.connect('clicked', () => {
            if (bar.step === 'menu') this._pauseGroup(bar, !bar.paused);
        });
        lower.connect('clicked', () => {
            if (bar.step === 'menu') this._lowerGroup(bar);
        });
        cancel.connect('clicked', () => {
            // Not ending it after all: back to what can be done with it.
            if (bar.step === 'confirm' || bar.step === 'force') this._showMenu(bar);
            else this._hideEndBar(bar);
        });
        for (const b of [pause, lower, confirm, cancel]) this._addClickAnimations(b);
        return bar;
    }

    _hideEndBar(bar) {
        bar.run++;
        bar.step = 'idle';
        bar.target = null;
        bar.frozen = null;
        bar.box.visible = false;
        // The list goes back to its order now, not at the next tick.
        if (this._menuOpen) this._poll();
    }

    _showEndBar(bar, text, { confirm = null, cancel = null, pause = null, lower = null } = {}) {
        bar.label.text = text;
        bar.label.visible = !!text;
        bar.pause.visible = !!pause;
        if (pause) bar.pause.label = pause;
        bar.lower.visible = !!lower;
        if (lower) bar.lower.label = lower;
        bar.confirm.visible = !!confirm;
        if (confirm) bar.confirm.label = confirm;
        bar.cancel.visible = !!cancel;
        if (cancel) bar.cancel.label = cancel;
        bar.box.visible = true;
    }

    /**
     * The row's button: opens the line under that row; pressed again it
     * closes it, on another row it moves there. While the line is open the
     * rows keep their order (their values still update), or the buttons
     * would move under the pointer with every reading. The group is copied,
     * so later re-sorting cannot change the target.
     */
    _toggleActions(bar, group, widgetsKey, container) {
        if (bar.box.visible && bar.target?.comm === group.comm) {
            this._hideEndBar(bar);
            return;
        }
        bar.run++;
        bar.widgetsKey = widgetsKey;
        bar.list = container;
        bar.frozen = this[widgetsKey].filter(w => w.item.visible && w.group).map(w => w.group);
        bar.target = { comm: group.comm, count: group.count, members: group.members.map(m => ({ ...m })) };
        this._showMenu(bar);
        this._placeEndBar(bar);
        this._revealEndBar(bar);
    }

    /** A row at the panel's bottom edge would open its line out of sight. */
    async _revealEndBar(bar) {
        const run = bar.run;
        // Laid out first: until then the line has no place to scroll to.
        if (!(await this._wait(50)) || run !== bar.run || !bar.box.visible || !this._scrollView) return;
        ensureActorVisibleInScrollView(this._scrollView, bar.box);
    }

    /** The line right under its process's row. */
    _placeEndBar(bar) {
        const row = this[bar.widgetsKey]?.find(w => w.item.visible && w.group?.comm === bar.target?.comm);
        if (row) bar.list.set_child_above_sibling(bar.box, row.item);
    }

    /** What can be done with the process; `note` when the last try failed. */
    _showMenu(bar, note = '') {
        const { mine, paused, nice } = groupState(bar.target.members, this._uid);
        if (mine.length === 0) {
            this._noneLeft(bar);
            return;
        }
        bar.step = 'menu';
        bar.paused = paused;
        this._showEndBar(bar, note, {
            pause: paused ? _('Resume') : _('Pause'),
            // Lowered already: an unprivileged user cannot raise it back.
            lower: nice < LOWER_NICE ? _('Lower priority') : null,
            confirm: _('End…'),
        });
    }

    /** The row shows a change now, not at the next reading. */
    _markPaused(bar, paused) {
        for (const w of this[bar.widgetsKey] ?? []) {
            if (w.group?.comm !== bar.target?.comm) continue;
            w.group.paused = paused;
            w.icon.icon_name = paused ? 'media-playback-pause-symbolic' : 'application-x-executable-symbolic';
        }
    }

    /** No process of the group is left that is ours to act on. */
    _noneLeft(bar) {
        const { comm } = bar.target;
        const { others } = liveMembers(bar.target.members, this._uid);
        bar.step = 'done';
        this._showEndBar(bar, others > 0
            ? fill(_('{process} belongs to another user and cannot be ended from here.'), { process: comm })
            : fill(_('{process} has already exited.'), { process: comm }), { cancel: _('Close') });
    }

    /** Stop (SIGSTOP) or continue (SIGCONT) the group's own processes; the line stays open. */
    async _pauseGroup(bar, pause) {
        const run = ++bar.run;
        const { comm } = bar.target;
        const { mine } = groupState(bar.target.members, this._uid);
        if (mine.length === 0) {
            this._noneLeft(bar);
            return;
        }
        bar.step = 'waiting';
        const sent = await signalProcesses(mine, pause ? 'STOP' : 'CONT');
        // The kernel stops a running process at its next chance.
        if (!(await this._wait(100)) || run !== bar.run) return;
        const now = groupState(bar.target.members, this._uid);
        this._markPaused(bar, now.paused);
        this._showMenu(bar, now.paused === pause ? '' : fill(_('{process} could not be changed{error}'), { process: comm, error: sent.error ? ` (${sent.error})` : '' }));
    }

    /** Lower the priority of the group's own processes (niceness LOWER_NICE); the line stays open. */
    async _lowerGroup(bar) {
        const run = ++bar.run;
        const { comm } = bar.target;
        const { mine } = groupState(bar.target.members, this._uid);
        if (mine.length === 0) {
            this._noneLeft(bar);
            return;
        }
        bar.step = 'waiting';
        const sent = await reniceProcesses(mine);
        if (run !== bar.run) return;
        this._showMenu(bar, sent.ok ? '' : fill(_('{process} could not be changed{error}'), { process: comm, error: sent.error ? ` (${sent.error})` : '' }));
    }

    /** Ending: ask first. */
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
        const { mine } = liveMembers(bar.target.members, this._uid);
        if (mine.length === 0) {
            this._noneLeft(bar);
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

        // An open action line holds the rows in their order, with fresh values
        // where the reading has them.
        const bar = this._actionBar(mode);
        if (bar?.frozen) {
            const fresh = new Map(processes.map(p => [p.comm, p]));
            processes = bar.frozen.map(old => fresh.get(old.comm) ?? (mode === 'disk' ? { ...old, ioRate: 0 } : old));
            bar.frozen = processes;
        }

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
                    accessible_role: Atk.Role.LIST_ITEM
                });

                const iconBox = new St.BoxLayout({ style_class: 'rp-chip-bg', style: 'width: 24px; height: 24px; border-radius: 6px;', y_align: Clutter.ActorAlign.CENTER });
                const icon = new St.Icon({ icon_name: 'application-x-executable-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 14px;' });
                iconBox.add_child(icon);
                item.add_child(iconBox);

                const detailsCol = new St.BoxLayout({ ...VERTICAL, x_expand: true });
                const nameLbl = new St.Label({ style_class: 'rp-fg', style: 'font-size: 0.85em; font-weight: 500;', text: '' });
                detailsCol.add_child(nameLbl);

                const color = isMemory ? [0.569, 0.255, 0.675] : mode === 'disk' ? [0.96, 0.83, 0.18] : [0.208, 0.518, 0.894];
                const pbar = new ProgressBar(4, color[0], color[1], color[2]);
                detailsCol.add_child(pbar);

                item.add_child(detailsCol);

                const statLbl = new St.Label({ style_class: 'rp-fg-dim', style: 'font-size: 0.85em; font-weight: 600; text-align: right;', width: mode === 'cpu' ? 52 : 76 });
                statLbl.x_align = Clutter.ActorAlign.END;
                item.add_child(statLbl);

                // Pause, lower priority or end: the line under the list.
                const endBtn = new St.Button({
                    style_class: 'rp-end-button',
                    can_focus: true,
                    accessible_name: _('Process actions'),
                    y_align: Clutter.ActorAlign.CENTER,
                    child: new St.Icon({ icon_name: 'view-more-symbolic', style_class: 'rp-fg-dim', style: 'icon-size: 12px;' }),
                });
                const widgets = { nameLbl, statLbl, pbar, endBtn, icon, group: null };
                endBtn.connect('clicked', () => {
                    if (widgets.group) this._toggleActions(this._actionBar(mode), widgets.group, targetWidgetsKey, container);
                });

                item.add_child(endBtn);

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
            // A paused group: the pause icon in place of the program's.
            w.icon.icon_name = proc.paused ? 'media-playback-pause-symbolic' : 'application-x-executable-symbolic';
            // Process lists change with samples, not glide frames.
            const named = proc.count > 1 ? fill(ngettext('{process}, {n} process', '{process}, {n} processes', proc.count), { process: proc.comm, n: proc.count }) : proc.comm;
            const who = proc.paused ? fill(_('{process}, paused'), { process: named }) : named;
            w.item.accessible_name = fill(SPOKEN_MODE[mode], { process: who, value: spokenValue(w.statLbl.text) });
            // Hidden but still taking its room, so the values stay aligned.
            const endable = canEnd(proc, this._selfPid);
            w.endBtn.opacity = endable ? 255 : 0;
            w.endBtn.reactive = endable;
            w.endBtn.can_focus = endable;
            w.endBtn.accessible_name = endable ? fill(_('Actions for {process}'), { process: who }) : '';
        });
        if (bar?.box.visible) this._placeEndBar(bar);
    }
}
