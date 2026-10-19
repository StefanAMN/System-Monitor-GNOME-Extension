// The pseudo-language check shared by the UI driver (the panel) and
// prefs-check (the window): under LANGUAGE=xx every string the extension
// translates reads ⟦…⟧ (./scripts/dev.sh test-i18n builds that catalogue),
// so words outside the markers were never translated.

// Not words to translate: symbols, units, and names that are the same in
// every language (badges, the extension's own name).
const NOT_WORDS = /\b(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB|B|W|Wh|mWh|GHz|MHz|RPM|°C|°F|s|ms|min|GNOME|Resource Pulse|NVIDIA|GEFORCE|RTX|AMD|RADEON|RYZEN|intel|CORE|GRAPHICS|CPU|i\d)\b/g;

/**
 * Every string in a reading (collector output: process, sensor, interface,
 * CPU and GPU names...), to leave out of the check as data.
 * @param {*} value
 * @param {Set<string>} [out]
 */
export function dataStrings(value, out = new Set(), depth = 0) {
    if (depth > 6 || value === null || value === undefined) return out;
    if (typeof value === 'string') {
        if (value.length >= 2 && !value.includes('⟦')) out.add(value);
    } else if (value instanceof Map) {
        for (const [k, v] of value) {
            dataStrings(k, out, depth + 1);
            dataStrings(v, out, depth + 1);
        }
    } else if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            // Keys of an object of records (interfaces by name) are data too.
            if (v && typeof v === 'object' && !Array.isArray(v)) out.add(k);
            dataStrings(v, out, depth + 1);
        }
    }
    return out;
}

/**
 * What of `text` is words outside the markers, data and units; '' if none.
 * @param {string} text
 * @param {Iterable<string>} data
 */
export function untranslated(text, data = []) {
    if (typeof text !== 'string' || !text) return '';
    let rest = text;
    // Innermost first: translated strings are put into translated strings.
    for (let before = null; before !== rest;) {
        before = rest;
        rest = rest.replace(/⟦[^⟦⟧]*⟧/g, ' ');
    }
    // Longest first, so a name is removed before a shorter one inside it.
    for (const d of [...data].sort((a, b) => b.length - a.length)) rest = rest.split(d).join(' ');
    rest = rest.replace(NOT_WORDS, ' ');
    return /\p{L}{2,}/u.test(rest) ? rest.replace(/\s+/g, ' ').trim() : '';
}
