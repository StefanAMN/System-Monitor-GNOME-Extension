// The Settings page's Backup group: the settings saved to a file, restored
// from one (checked against the schema first, see lib/common/backup.js), or
// all reset. GTK side (preferences process).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { backupText, checkBackup, BackupError, NOT_BACKED_UP } from '../../lib/common/backup.js';
import { _, fill, ngettext } from '../../lib/common/i18n.js';

/** The schema's keys as checkBackup() reads them: type, and range or choices. */
export function schemaKeys(settings) {
    const schema = settings.settings_schema;
    const keys = {};
    for (const name of schema.list_keys()) {
        const key = schema.get_key(name);
        const entry = { type: key.get_value_type().dup_string() };
        const [kind, detail] = key.get_range().recursiveUnpack();
        if (kind === 'range') [entry.min, entry.max] = detail;
        else if (kind === 'enum') entry.choices = detail;
        keys[name] = entry;
    }
    return keys;
}

/** The values a backup holds: every setting but the window's signals. */
export function settingsValues(settings) {
    const values = {};
    for (const name of settings.settings_schema.list_keys()) {
        if (!NOT_BACKED_UP.has(name)) values[name] = settings.get_value(name).recursiveUnpack();
    }
    return values;
}

/** Write the backup to `file`. */
export function exportSettings(settings, file) {
    const bytes = new GLib.Bytes(new TextEncoder().encode(backupText(settingsValues(settings))));
    return new Promise((resolve, reject) => file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (obj, res) => {
        try {
            obj.replace_contents_finish(res);
            resolve();
        } catch (e) {
            reject(e);
        }
    }));
}

/**
 * Read a backup from `file` and apply what passes the check.
 * @returns {Promise<{applied: number, rejected: {key: string, reason: string}[]}>}
 * @throws {BackupError} when the file is not a settings backup
 */
export async function importSettings(settings, file) {
    const [bytes] = await new Promise((resolve, reject) => file.load_contents_async(null, (obj, res) => {
        try {
            resolve(obj.load_contents_finish(res).slice(1));
        } catch (e) {
            reject(e);
        }
    }));
    const keys = schemaKeys(settings);
    const { apply, rejected } = checkBackup(new TextDecoder().decode(bytes), keys);
    for (const [name, value] of Object.entries(apply)) settings.set_value(name, new GLib.Variant(keys[name].type, value));
    return { applied: Object.keys(apply).length, rejected };
}

/** Every setting back to its default (the window's signals are left alone). */
export function resetSettings(settings) {
    for (const name of settings.settings_schema.list_keys()) {
        if (!NOT_BACKED_UP.has(name)) settings.reset(name);
    }
}

/** Pick a file with a file dialog; null when the dialog was dismissed. */
function pickFile(parent, save) {
    const dialog = new Gtk.FileDialog({ title: save ? _('Save the settings') : _('Restore the settings'), modal: true });
    if (save) dialog.initial_name = 'resource-pulse-settings.json';
    return new Promise((resolve, reject) => dialog[save ? 'save' : 'open'](parent, null, (obj, res) => {
        try {
            resolve(save ? obj.save_finish(res) : obj.open_finish(res));
        } catch (e) {
            // Closing the dialog is a choice, not a failure.
            if (e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) || e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED)) resolve(null);
            else reject(e);
        }
    }));
}

/**
 * The Backup group on `page`.
 * @returns {{group: Adw.PreferencesGroup, rows: Object<string, Adw.ActionRow>}}
 */
export function buildBackupGroup(page, settings) {
    const group = new Adw.PreferencesGroup({ title: _('Backup'), description: _('Keep the settings in a file, or move them to another computer.') });
    const button = (label, destructive = false) => new Gtk.Button({ label, valign: Gtk.Align.CENTER, css_classes: destructive ? ['destructive-action'] : [] });
    const rows = {
        save: new Adw.ActionRow({ title: _('Save to a file') }),
        restore: new Adw.ActionRow({ title: _('Restore from a file'), subtitle: _('Settings the file does not have keep their values.') }),
        reset: new Adw.ActionRow({ title: _('Reset all settings'), subtitle: _('Back to how they were when the extension was installed. Battery history is kept.') }),
    };
    const saveButton = button(_('Save…'));
    const restoreButton = button(_('Open…'));
    const resetButton = button(_('Reset…'), true);
    rows.save.add_suffix(saveButton);
    rows.restore.add_suffix(restoreButton);
    rows.reset.add_suffix(resetButton);
    for (const row of Object.values(rows)) group.add(row);
    page.add(group);

    const report = (row, text) => {
        row.subtitle = text;
    };
    saveButton.connect('clicked', async () => {
        try {
            const file = await pickFile(page.get_root(), true);
            if (!file) return;
            await exportSettings(settings, file);
            report(rows.save, fill(_('Saved to {path}.'), { path: file.get_parse_name() }));
        } catch (e) {
            report(rows.save, fill(_('Could not save: {error}'), { error: e.message }));
        }
    });
    restoreButton.connect('clicked', async () => {
        try {
            const file = await pickFile(page.get_root(), false);
            if (!file) return;
            const { applied, rejected } = await importSettings(settings, file);
            const left = rejected.map(r => fill(_('{key} ({reason})'), { key: r.key, reason: r.reason })).join(', ');
            report(rows.restore, fill(ngettext('Restored {n} setting.', 'Restored {n} settings.', applied), { n: applied }) +
                (left ? ` ${fill(_('Left out: {settings}.'), { settings: left })}` : ''));
        } catch (e) {
            report(rows.restore, e instanceof BackupError ? e.message : fill(_('Could not restore: {error}'), { error: e.message }));
        }
    });
    resetButton.connect('clicked', () => {
        const dialog = new Adw.AlertDialog({
            heading: _('Reset all settings?'),
            body: _('Every setting goes back to its default: pinned metrics, units, alerts, the panel\'s size. Battery history is kept.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', _('Reset'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response !== 'reset') return;
            resetSettings(settings);
            report(rows.reset, _('All settings were reset.'));
        });
        dialog.present(page.get_root());
    });
    return { group, rows, buttons: { save: saveButton, restore: restoreButton, reset: resetButton } };
}
