// Text put on screen without passing through gettext: a literal string (or
// the literal part of a template) in a property or call that shows text,
// not wrapped in _() or N_(). Run by ./scripts/dev.sh test-i18n under node.
// Symbols and units, product names and the CPU and GPU badges are not words
// to translate; a line can also say why it is exempt with a comment
// containing "not translated".
// Usage: node tests/i18n/untranslated.mjs <src dir>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? 'src';

// Where text reaches the screen (or a screen reader).
const SHOWN = [
    /\b(?:text|label|title|subtitle|description|heading|body|tooltip_text|accessible_name|placeholder_text)\s*:\s*(['`])/g,
    /\.(?:text|label|title|subtitle|description|accessible_name|tooltip_text)\s*=\s*(['`])/g,
    /\b(?:_detailRow|addGroup|_showEndBar|show)\(\s*(['`])/g,
    /\badd_response\(\s*'[^']*'\s*,\s*(['`])/g,
];

// Not words: symbols, units, numbers, placeholders, and names that are the
// same in every language.
const NOT_WORDS = /\b(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB|W|Wh|mWh|GHz|MHz|RPM|°C|°F|s|min|ms|n\/a|GNOME|Resource Pulse|NVIDIA|GEFORCE|RTX|AMD|RADEON|RYZEN|intel|CORE|GRAPHICS|CPU|Sans|i5)\b/g;

function* sources(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* sources(path);
        else if (name.endsWith('.js')) yield path;
    }
}

/** The literal starting at `start` (quote included), or null. */
function literalAt(line, start) {
    const quote = line[start];
    let out = '';
    for (let i = start + 1; i < line.length; i++) {
        const c = line[i];
        if (c === '\\') {
            out += line[i + 1] ?? '';
            i++;
        } else if (c === quote) {
            return out;
        } else if (quote === '`' && c === '$' && line[i + 1] === '{') {
            // Skip the expression; only the template's own text is checked.
            let depth = 0;
            for (i += 1; i < line.length; i++) {
                if (line[i] === '{') depth++;
                else if (line[i] === '}' && --depth === 0) break;
            }
            out += ' ';
        } else {
            out += c;
        }
    }
    return null;
}

const found = [];
for (const path of sources(root)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*(\*|\/\/|\/\*)/.test(line) || /not translated/.test(line)) return;
        for (const pattern of SHOWN) {
            for (const match of code.matchAll(pattern)) {
                const start = match.index + match[0].length - 1;
                const text = literalAt(code, start);
                if (text === null) continue;
                const words = text.replace(NOT_WORDS, ' ').replace(/\{\w+\}/g, ' ');
                if (/[A-Za-z]{2,}/.test(words))
                    found.push(`${relative('.', path)}:${index + 1}: ${text.slice(0, 80)}`);
            }
        }
    });
}
if (found.length) {
    console.log(`Text shown without gettext (${found.length}):`);
    for (const line of found) console.log(`  ${line}`);
    process.exit(1);
}
console.log('No literal text shown without gettext.');
