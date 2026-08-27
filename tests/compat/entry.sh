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
    exec "$@"' compat "$@"
