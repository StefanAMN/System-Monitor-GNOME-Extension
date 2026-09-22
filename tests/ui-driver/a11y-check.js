// What a screen reader is given for the extension: an AT-SPI client, run by
// the UI driver (extension.js) while the shell keeps running. For each name
// on the command line it finds the first accessible object with that name in
// the shell's tree and prints the tree below it as JSON:
//   A11Y-CHECK TREE <name> {"role", "name", "showing", "sensitive", "checked", "children"}
// then A11Y-CHECK DONE. Objects that are not showing are listed without
// their children: a screen reader skips them.
// Usage: gjs -m a11y-check.js 'Resource Pulse' 'Resource Pulse panel'
import Atspi from 'gi://Atspi';
import System from 'system';

const VISIT_LIMIT = 40000;

function fail(msg) {
    print(`A11Y-CHECK FAIL ${msg}`);
    System.exit(1);
}

function children(obj) {
    const out = [];
    const n = obj.get_child_count();
    for (let i = 0; i < n; i++) {
        const child = obj.get_child_at_index(i);
        if (child) out.push(child);
    }
    return out;
}

function describe(obj) {
    const states = obj.get_state_set();
    const node = {
        role: obj.get_role_name(),
        name: obj.get_name(),
        showing: states.contains(Atspi.StateType.SHOWING),
        sensitive: states.contains(Atspi.StateType.SENSITIVE),
        checked: states.contains(Atspi.StateType.CHECKED),
    };
    // An actor can be destroyed between listing and reading it.
    try {
        node.children = node.showing ? children(obj).map(describe) : [];
    } catch (e) {
        node.error = e.message;
        node.children = [];
    }
    return node;
}

Atspi.init();
const desktop = Atspi.get_desktop(0);
const shell = children(desktop).find(app => /gnome-shell/i.test(app.get_name()));
if (!shell) fail('no gnome-shell on the accessibility bus');

const wanted = new Set(ARGV);
const found = new Map();
const queue = [shell];
let visited = 0;
while (queue.length && found.size < wanted.size && visited < VISIT_LIMIT) {
    const obj = queue.shift();
    visited++;
    let name;
    try {
        name = obj.get_name();
    } catch {
        // Gone while the tree was being walked.
        continue;
    }
    if (wanted.has(name) && !found.has(name)) {
        found.set(name, obj);
        continue;
    }
    try {
        queue.push(...children(obj));
    } catch {
        continue;
    }
}
for (const name of wanted) {
    if (!found.has(name)) fail(`no object named '${name}' among ${visited} visited`);
    // ASCII only: under the C locale (the CI containers) print() turns
    // anything else, such as the ° of a temperature, into '?'.
    const json = JSON.stringify(describe(found.get(name))).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    print(`A11Y-CHECK TREE ${name}\t${json}`);
}
print('A11Y-CHECK DONE');
