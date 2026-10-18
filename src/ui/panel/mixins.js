// The extension class is assembled from method groups (one class per file in
// ui/panel/): each group's methods are copied onto the extension's prototype,
// so `this` in them is the extension and they call each other freely.

/**
 * @param {Function} target the class to install on
 * @param {Function[]} groups classes whose methods are copied
 */
export function installMethods(target, groups) {
    for (const group of groups) {
        for (const name of Object.getOwnPropertyNames(group.prototype)) {
            if (name === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(target.prototype, name))
                throw new Error(`${group.name}.${name} is defined twice`);
            Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(group.prototype, name));
        }
    }
}
