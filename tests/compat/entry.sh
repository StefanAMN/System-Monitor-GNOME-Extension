#!/bin/bash
# Container entry point for ./dev.sh test-compat: start a system bus (the
# shell's own startup expects one), then run the tests as an ordinary user on
# a private copy of the read-only checkout mounted at /src.
set -e
mkdir -p /run/dbus
dbus-daemon --system --fork
exec runuser -u tester -- bash -c '
    cp -r /src "$HOME/work" && cd "$HOME/work" || exit 1
    rm -rf node_modules schemas/gschemas.compiled
    # The question asked here is "does it work on this shell", whether or not
    # metadata.json lists it yet: list this shell in the private copy (and
    # in the test drivers, which are extensions too).
    major="$(gnome-shell --version | sed -E "s/[^0-9]*([0-9]+).*/\\1/")"
    for meta in metadata.json tests/*/metadata.json; do
        node -e "
            const fs = require(\"fs\");
            const m = JSON.parse(fs.readFileSync(process.argv[1]));
            m[\"shell-version\"] = [process.argv[2]];
            fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2));
        " "$meta" "$major"
    done
    exec "$@"' compat "$@"
