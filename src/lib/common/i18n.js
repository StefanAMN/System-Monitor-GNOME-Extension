// Translations for every module, including those the unit tests load outside
// the shell (which cannot import the shell's resources). The extension and
// the preferences window install their gettext here once their domain is
// bound (ExtensionBase does that from metadata's gettext-domain); until then,
// and in the unit tests, strings pass through in English.
//
// Strings with values use named placeholders, so a translation can put them
// in any order: fill(_('{app} used {share} %'), { app, share }).
// Units (%, W, °C, MB/s) stay symbols and are not translated.

let translate = str => str;
let translatePlural = (str, plural, n) => (n === 1 ? str : plural);

/**
 * @param {(str: string) => string} singular  the extension's gettext
 * @param {(str: string, plural: string, n: number) => string} plural  its ngettext
 */
export function setTranslations(singular, plural) {
    translate = singular;
    translatePlural = plural;
}

/** The translation of `str`. */
export function _(str) {
    return translate(str);
}

/** The translation of `str` or `plural`, as `n` asks. */
export function ngettext(str, plural, n) {
    return translatePlural(str, plural, n);
}

/** Marks `str` for translation where it is read, not here (module-level tables). */
export function N_(str) {
    return str;
}

/** `template` with each {name} replaced by values[name]; unknown names are left. */
export function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

// One proxy per table, so reading a nested table allocates nothing.
const proxies = new WeakMap();

/**
 * A table whose strings (marked with N_()) are translated each time they are
 * read, so a table built when the module loads, before the domain is bound,
 * still reads in the current language. Nested tables are wrapped too.
 * @template T
 * @param {T} table
 * @returns {T}
 */
export function translated(table) {
    let proxy = proxies.get(table);
    if (!proxy) {
        proxy = new Proxy(table, {
            get(target, key) {
                const value = target[key];
                if (typeof value === 'string') return translate(value);
                if (value && typeof value === 'object') return translated(value);
                return value;
            },
        });
        proxies.set(table, proxy);
    }
    return proxy;
}
