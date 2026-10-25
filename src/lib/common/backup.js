// The settings as a file to keep or move to another machine, and checking
// such a file before anything is applied. Pure: the preferences window reads
// and writes the file and the settings; this decides what may be restored.
import { _, fill } from './i18n.js';

export const BACKUP_FORMAT = 'resource-pulse-settings';
export const BACKUP_VERSION = 1;

// Keys that are signals between the window and the panel, not settings.
// The consent to send an agent the report is this machine's: a settings file
// from elsewhere must not give it.
export const NOT_BACKED_UP = new Set(['prefs-page', 'action-open-menu', 'action-flush-history', 'action-clear-history', 'agent-consent']);

/** A file's text could not be read as a settings backup at all. */
export class BackupError extends Error {}

/**
 * The file for `values` (key -> plain value: boolean, number, string, array of strings).
 * @param {Object<string, *>} values
 * @param {Date} [now]
 */
export function backupText(values, now = new Date()) {
    const settings = {};
    for (const key of Object.keys(values).sort()) {
        if (!NOT_BACKED_UP.has(key)) settings[key] = values[key];
    }
    return `${JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, saved: now.toISOString(), settings }, null, 2)}\n`;
}

const TYPE_OF = { b: 'boolean', i: 'number', s: 'string', as: 'array' };

function fits(value, key) {
    if (key.type === 'as') return Array.isArray(value) && value.every(v => typeof v === 'string');
    if (key.type === 'i') return Number.isInteger(value);
    return typeof value === TYPE_OF[key.type];
}

/**
 * What of a backup may be applied.
 * @param {string} text the file's contents
 * @param {Object<string, {type: string, min?: number, max?: number, choices?: string[]}>} schema
 *   the settings schema's keys: GVariant type ('b', 'i', 's', 'as'), range or choices
 * @returns {{apply: Object<string, *>, rejected: {key: string, reason: string}[]}}
 * @throws {BackupError} when the text is not a settings backup at all
 */
export function checkBackup(text, schema) {
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        throw new BackupError(_('This is not a settings file (it is not JSON).'));
    }
    if (doc?.format !== BACKUP_FORMAT || typeof doc.settings !== 'object' || doc.settings === null || Array.isArray(doc.settings))
        throw new BackupError(_('This is not a Resource Pulse settings file.'));
    if (doc.version !== BACKUP_VERSION)
        throw new BackupError(fill(_('This settings file has version {version}, which this version of the extension cannot read.'), { version: doc.version }));

    const apply = {};
    const rejected = [];
    for (const [name, value] of Object.entries(doc.settings)) {
        const key = schema[name];
        let reason = null;
        if (!key || NOT_BACKED_UP.has(name)) reason = _('not a setting of this version');
        else if (!fits(value, key)) reason = _('wrong kind of value');
        else if (key.min !== undefined && (value < key.min || value > key.max)) reason = fill(_('outside {min}–{max}'), { min: key.min, max: key.max });
        else if (key.choices && !key.choices.includes(value)) reason = _('not one of the choices');
        if (reason) rejected.push({ key: name, reason });
        else apply[name] = value;
    }
    return { apply, rejected };
}
