#!/usr/bin/env bash
# ==============================================================================
# Resource Pulse - GNOME Shell 50 Extension Development & Testing Tool
# ==============================================================================

set -eo pipefail

# The repository (tests, tooling) and the extension itself (src/, the
# directory GNOME installs and packs).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
EXT_DIR="$REPO_DIR/src"
UUID="resource-pulse@stefanamn.github.io"
GETTEXT_DOMAIN="resource-pulse"
EXTENSIONS_BASE="$HOME/.local/share/gnome-shell/extensions"
TARGET_DIR="$EXTENSIONS_BASE/$UUID"

# Colors for terminal output
BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

log_info()    { echo -e "${BLUE}${BOLD}[INFO]${RESET} $1"; }
log_success() { echo -e "${GREEN}${BOLD}[SUCCESS]${RESET} $1"; }
log_warn()    { echo -e "${YELLOW}${BOLD}[WARNING]${RESET} $1"; }
log_error()   { echo -e "${RED}${BOLD}[ERROR]${RESET} $1"; }
log_title()   { echo -e "\n${BOLD}${CYAN}=== $1 ===${RESET}"; }

# ------------------------------------------------------------------------------
# Helper: Validate and compile GSettings schemas
# ------------------------------------------------------------------------------
compile_schemas() {
    log_info "Compiling GSettings schemas..."
    if [ ! -d "$EXT_DIR/schemas" ]; then
        log_error "Directory $EXT_DIR/schemas not found!"
        exit 1
    fi
    glib-compile-schemas "$EXT_DIR/schemas"
    log_success "Schemas compiled successfully."
    compile_translations
}

# ------------------------------------------------------------------------------
# Helper: translations. po/<lang>.po are compiled into src/locale (ignored by
# git) for the installed copy and the tests; pack builds its own from po/.
# ------------------------------------------------------------------------------
compile_translations() {
    local po lang
    for po in "$REPO_DIR"/po/*.po; do
        [ -f "$po" ] || continue
        if ! command -v msgfmt >/dev/null 2>&1; then
            log_warn "msgfmt not found: translations NOT compiled."
            return 0
        fi
        lang="$(basename "$po" .po)"
        mkdir -p "$EXT_DIR/locale/$lang/LC_MESSAGES"
        msgfmt -c -o "$EXT_DIR/locale/$lang/LC_MESSAGES/$GETTEXT_DOMAIN.mo" "$po"
    done
}

# The translatable strings of the sources, as a template, written to $1.
extract_pot() {
    local files
    files="$(cd "$REPO_DIR" && find src -name '*.js' | sort)"
    # shellcheck disable=SC2086
    (cd "$REPO_DIR" && xgettext --from-code=UTF-8 --language=JavaScript \
        --keyword=_ --keyword=N_ --keyword=ngettext:1,2 --add-comments=Translators: \
        --package-name="Resource Pulse" \
        --msgid-bugs-address="https://github.com/StefanAMN/System-Monitor-GNOME-Extension/issues" \
        --sort-by-file -o "$1" $files)
}

# A pseudo-language "xx" in src/locale: every string of the sources wrapped
# in ⟦ ⟧, so a test can tell a translated string from one that is not.
pseudo_translation() {
    local tmp
    tmp="$(mktemp -d)"
    extract_pot "$tmp/all.pot"
    msginit --no-translator --locale=xx -i "$tmp/all.pot" -o - 2>/dev/null \
        | sed 's|"Plural-Forms: nplurals=INTEGER; plural=EXPRESSION;\\n"|"Plural-Forms: nplurals=2; plural=(n != 1);\\n"|' \
        | msgen - | msgfilter --keep-header -o "$tmp/xx.po" sed -e 's/^/⟦/' -e 's/$/⟧/'
    mkdir -p "$EXT_DIR/locale/xx/LC_MESSAGES"
    msgfmt -c -o "$EXT_DIR/locale/xx/LC_MESSAGES/$GETTEXT_DOMAIN.mo" "$tmp/xx.po"
    rm -rf "$tmp"
}

# ------------------------------------------------------------------------------
# Helper: Syntax check JS files
# ------------------------------------------------------------------------------
check_syntax() {
    log_info "Verifying JavaScript syntax..."
    if ! command -v node >/dev/null 2>&1; then
        # gjs cannot parse a module without also loading its gi:// and
        # resource:// imports, so there is no honest fallback.
        log_warn "node not found: JavaScript syntax NOT checked."
        return 0
    fi
    local f failed=0
    # Every file here is an ES module. 'node --check file.js' parses .js as
    # CommonJS first and, on import/export syntax, exits 0 without checking
    # anything; reading from stdin as a module is a real parse.
    for f in "$EXT_DIR"/*.js "$EXT_DIR"/lib/*/*.js "$EXT_DIR"/ui/*/*.js "$EXT_DIR"/ui/*/*/*.js \
             "$REPO_DIR"/tests/*/*.js; do
        [ -f "$f" ] || continue
        if ! node --input-type=module --check < "$f" 2> >(sed "s|^\[stdin\]|${f#"$REPO_DIR"/}|" >&2); then
            failed=1
        fi
    done
    if [ "$failed" -ne 0 ]; then
        log_error "JavaScript syntax errors found."
        exit 1
    fi
    log_success "JavaScript syntax verified."
}

# ------------------------------------------------------------------------------
# Helper: Ensure symlink in local GNOME extensions directory
# ------------------------------------------------------------------------------
ensure_installed() {
    mkdir -p "$EXTENSIONS_BASE"
    if [ -L "$TARGET_DIR" ]; then
        CURRENT_TARGET="$(readlink -f "$TARGET_DIR")"
        if [ "$CURRENT_TARGET" != "$EXT_DIR" ]; then
            log_info "Updating symlink $TARGET_DIR -> $EXT_DIR"
            ln -sfn "$EXT_DIR" "$TARGET_DIR"
        fi
    elif [ -d "$TARGET_DIR" ]; then
        # A real directory may be an installed release or local edits: keep it.
        local BACKUP
        # Outside extensions/, or the shell would try to load the backup too.
        BACKUP="$(dirname "$EXTENSIONS_BASE")/$UUID.backup-$(date +%Y%m%d-%H%M%S)"
        log_warn "Moving existing copy at $TARGET_DIR to $BACKUP"
        mv "$TARGET_DIR" "$BACKUP"
        ln -sfn "$EXT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $EXT_DIR"
    else
        log_info "Creating extension symlink $TARGET_DIR -> $EXT_DIR..."
        ln -sfn "$EXT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $EXT_DIR"
    fi
}

# ------------------------------------------------------------------------------
# Helper: isolated headless shell sandbox
#   Private XDG data/config dirs: only this extension (and the test driver)
#   is installed, nothing is written to the user's real dconf.
# ------------------------------------------------------------------------------
make_sandbox() {
    SANDBOX="$(mktemp -d /tmp/rp-ui-test.XXXXXX)"
    mkdir -p "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/config" "$SANDBOX/shots" "$SANDBOX/run"
    # Own runtime dir too: concurrent sandboxes otherwise race on shell
    # files in /run/user/<uid> (seen as a shell-internal JS ERROR).
    chmod 700 "$SANDBOX/run"
    ln -s "$EXT_DIR" "$SANDBOX/data/gnome-shell/extensions/$UUID"
    LOG="$SANDBOX/shell.log"
}

# Lines in a shell log that mean this extension misbehaved.
BAD_LOG_PATTERN="RP-UITEST FAIL|Extension resource-pulse@[^ ]*: |JS ERROR|Clutter-ERROR|ResourcePulse poll error|Error in .* sample|already disposed|was not found when attempting to remove"

# Shell / session output goes to log files unless --show-logs was given;
# with it, the same files are streamed to the terminal while the test runs.
SHOW_LOGS=0
LOG_STREAM_PID=""

start_log_stream() {
    [ "$SHOW_LOGS" = "1" ] || return 0
    touch "$@"
    tail -n +1 -F "$@" 2>/dev/null &
    LOG_STREAM_PID=$!
}

stop_log_stream() {
    [ -n "$LOG_STREAM_PID" ] || return 0
    sleep 0.3
    kill "$LOG_STREAM_PID" 2>/dev/null || true
    wait "$LOG_STREAM_PID" 2>/dev/null || true
    LOG_STREAM_PID=""
}

# After a failure, copy the kept sandbox's logs and screenshots to
# RP_ARTIFACTS when it is set: test-compat sets it, because the sandbox lives
# inside a container that is removed when the test ends.
export_sandbox() {
    [ -n "${RP_ARTIFACTS:-}" ] || return 0
    mkdir -p "$RP_ARTIFACTS"
    local f
    for f in "$SANDBOX"/*.log "$SANDBOX"/*.txt "$SANDBOX/shots"; do
        if [ -e "$f" ]; then cp -r "$f" "$RP_ARTIFACTS/"; fi
    done
}

# Remove a sandbox after a pass unless RP_KEEP=1; failures are always kept.
finish_sandbox() {
    if [ "${RP_KEEP:-0}" = "1" ]; then
        log_info "Sandbox kept: $SANDBOX"
    else
        # The document portal FUSE-mounts run/doc inside the private runtime
        # dir and may still hold it while the session winds down.
        local _
        for _ in 1 2 3 4 5; do
            mountpoint -q "$SANDBOX/run/doc" 2>/dev/null && fusermount3 -uz "$SANDBOX/run/doc" 2>/dev/null
            rm -rf "$SANDBOX" 2>/dev/null && return 0
            sleep 1
        done
        log_warn "Could not fully remove $SANDBOX"
    fi
}

# ------------------------------------------------------------------------------
# Command: Reload / Re-enable in active session
# ------------------------------------------------------------------------------
cmd_reload() {
    log_title "Re-enabling Resource Pulse in Current Session"

    check_syntax
    compile_schemas
    ensure_installed

    log_info "Disabling extension $UUID..."
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true

    # Brief delay allowing GNOME Shell to run disable() cleanup
    sleep 0.5

    log_info "Enabling extension $UUID..."
    gnome-extensions enable "$UUID"

    sleep 0.5
    local state
    state="$(gnome-extensions info "$UUID" 2>/dev/null | grep "State:" || echo "State: UNKNOWN")"
    log_success "Extension re-enabled! ($state)"

    echo -e "\n${BOLD}Current status:${RESET}"
    gnome-extensions info "$UUID" | sed 's/^/  /'

    echo -e "\n${YELLOW}${BOLD}Note on GNOME Shell (Wayland) ESM caching:${RESET}"
    echo -e "  • CSS stylesheets and GSettings changes reload immediately."
    echo -e "  • JavaScript files (${BOLD}*.js${RESET}) are cached by the GJS/SpiderMonkey runtime for the lifetime of the shell process."
    echo -e "  • To test JS updates immediately without logging out: ${GREEN}./scripts/dev.sh test${RESET} (opens isolated window)"
    echo -e "  • To apply JS updates to your main desktop session: log out and log back in."
}

# ------------------------------------------------------------------------------
# Command: Dedicated windowed test environment (opens a separate window)
# ------------------------------------------------------------------------------
cmd_test_dedicated() {
    log_title "Launching Dedicated Windowed Test Environment"

    check_syntax
    compile_schemas
    ensure_installed

    if ! command -v dbus-run-session >/dev/null 2>&1; then
        log_error "dbus-run-session is required to run a dedicated test environment."
        exit 1
    fi

    local HOST_WL="${WAYLAND_DISPLAY:-wayland-0}"
    local HOST_DISP="${DISPLAY:-:0}"

    echo -e "${YELLOW}Notice:${RESET} Opening an ${BOLD}isolated GNOME Shell 50 test window${RESET} on your desktop."
    echo -e "This runs in a ${BOLD}dedicated Wayland window${RESET} (Mutter Devkit) completely isolated from your host session."
    echo -e "You can interact with the top bar, click the extension icon, and test resizing safely."
    echo -e "Press ${BOLD}Ctrl+C${RESET} in this terminal or close the window to exit.\n"

    # Overwritten each run, so it never piles up.
    local LOG="${XDG_RUNTIME_DIR:-/tmp}/resource-pulse-test-window.log"
    : > "$LOG"
    if [ "$SHOW_LOGS" = "1" ]; then
        log_info "Streaming shell logs here (also saved to $LOG)"
    else
        log_info "Shell logs: $LOG  (add --show-logs to stream them here)"
    fi
    start_log_stream "$LOG"

    # Ctrl+C is how this session ends: let it stop the session but not this
    # script, so the error summary below still runs.
    trap 'true' INT
    dbus-run-session -- bash -c '
        # This script talks to the terminal (fd 3); session services started
        # by the bus inherit the log file as stdout/stderr instead.
        exec 1>&3 3>&-
        UUID="resource-pulse@stefanamn.github.io"
        HOST_WL="'"$HOST_WL"'"
        HOST_DISP="'"$HOST_DISP"'"
        LOG="'"$LOG"'"
        
        echo -e "\033[34m[TEST-ENV]\033[0m Starting isolated GNOME Shell 50 compositor..."
        gnome-shell --devkit --wayland >> "$LOG" 2>&1 &
        SHELL_PID=$!
        
        cleanup() {
            echo -e "\n\033[33mStopping dedicated test session...\033[0m"
            kill "$MDK_PID" "$SHELL_PID" 2>/dev/null || true
            wait "$SHELL_PID" 2>/dev/null || true
            exit 0
        }
        trap cleanup SIGINT SIGTERM EXIT

        sleep 2.5

        echo -e "\033[34m[TEST-ENV]\033[0m Enabling $UUID in test session..."
        gnome-extensions enable "$UUID" 2>/dev/null || true
        sleep 0.5

        # Check if mutter-devkit was auto-spawned; if not, launch it on the host display
        # Only a devkit spawned by this shell; another session may have one too.
        MDK_PID=$(pgrep -n -P "$SHELL_PID" -f "mutter-devkit" || true)
        if [ -z "$MDK_PID" ] && [ -x "/usr/libexec/mutter-devkit" ]; then
            echo -e "\033[34m[TEST-ENV]\033[0m Launching Mutter Devkit window on host display ($HOST_WL)..."
            WAYLAND_DISPLAY="$HOST_WL" DISPLAY="$HOST_DISP" /usr/libexec/mutter-devkit >> "$LOG" 2>&1 &
            MDK_PID=$!
        fi

        echo -e "\033[32m[TEST-ENV]\033[0m Test session status:"
        gnome-extensions info "$UUID"

        echo -e "\n\033[1;32m✓ Dedicated windowed test environment is active!\033[0m"
        echo -e "\033[36mInteract with the extension in the test window. Press Ctrl+C here to stop.\033[0m\n"
        
        wait "$MDK_PID" 2>/dev/null || wait "$SHELL_PID"
    ' 3>&1 >> "$LOG" 2>&1 || true
    trap - INT
    stop_log_stream

    # Surface this extension's problems even when the log was not shown.
    # This session also runs the user's other extensions, so a JS ERROR only
    # counts when its stack trace (next lines) mentions this extension.
    local BAD
    BAD="$(awk -v uuid="$UUID" '
        /JS ERROR/ { if (pending && hit) print pending; pending = FNR ": " $0; hit = 0; left = 8; next }
        left > 0 { left--; if (index($0, uuid)) hit = 1; if (left == 0 && pending) { if (hit) print pending; pending = "" } }
        /ResourcePulse|Error in .* sample|already disposed|was not found when attempting to remove/ { print FNR ": " $0 }
        END { if (pending && hit) print pending }
    ' "$LOG" || true)"
    if [ -n "$BAD" ]; then
        log_warn "Errors from the test session (full log: $LOG):"
        echo "$BAD" | head -n 20
    else
        log_info "No extension errors in the session log ($LOG)."
    fi
}

# ------------------------------------------------------------------------------
# Command: Non-interactive automated test check (for verification & CI)
# ------------------------------------------------------------------------------
cmd_test_ci() {
    local DURATION="${1:-5}"
    log_title "Running Automated Headless Verification (${DURATION}s)"

    check_syntax
    compile_schemas

    local SANDBOX LOG
    make_sandbox
    if [ "${RP_FROM_ZIP:-0}" = "1" ]; then
        # The packed zip as a user installs it, instead of the source tree.
        rm "$SANDBOX/data/gnome-shell/extensions/$UUID"
        # Unpacked and moved within the sandbox: a move across filesystems
        # fails for a directory ("Can't recursively copy directory").
        mkdir -p "$SANDBOX/cache"
        TMPDIR="$SANDBOX" XDG_CACHE_HOME="$SANDBOX/cache" XDG_DATA_HOME="$SANDBOX/data" \
            gnome-extensions install --force "$REPO_DIR/$UUID.shell-extension.zip"
        log_info "Installed from the zip: $(find "$SANDBOX/data/gnome-shell/extensions/$UUID" -type f | wc -l) files"
    fi

    start_log_stream "$LOG" "$SANDBOX/session.log"
    XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_RUNTIME_DIR="$SANDBOX/run" \
    dbus-run-session -- bash -c '
        gnome-shell --headless --virtual-monitor 1280x720 >> "'"$LOG"'" 2>&1 &
        SHELL_PID=$!
        trap "kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null" EXIT INT TERM
        sleep 3
        gnome-extensions enable "'"$UUID"'"
        sleep "'"$DURATION"'"
        gnome-extensions info "'"$UUID"'" > "'"$SANDBOX"'/info.txt" 2>&1 || true
    ' >> "$SANDBOX/session.log" 2>&1 || true
    stop_log_stream

    # ACTIVE only proves enable() did not throw; the log shows whether the
    # polling loop ran cleanly for DURATION seconds.
    local BAD
    BAD="$(grep -nE "$BAD_LOG_PATTERN" "$LOG" || true)"
    # GNOME Shell 45 reports the same state as ENABLED.
    if grep -qE "State: (ACTIVE|ENABLED)" "$SANDBOX/info.txt" 2>/dev/null && [ -z "$BAD" ]; then
        log_success "Extension ACTIVE for ${DURATION}s in an isolated shell with a clean log."
        finish_sandbox
    else
        log_error "Headless verification failed (sandbox kept: $SANDBOX)"
        export_sandbox
        cat "$SANDBOX/info.txt" 2>/dev/null | sed 's/^/  /'
        echo "$BAD" | head -n 40
        exit 1
    fi
}

# The packed zip, installed with gnome-extensions install (not the source
# tree) into an isolated shell: it must load and run with a clean log.
cmd_test_zip() {
    cmd_pack
    RP_FROM_ZIP=1 cmd_test_ci "${1:-8}"
}

# ------------------------------------------------------------------------------
# Command: Drive the real UI in an isolated headless shell and scan its log
# ------------------------------------------------------------------------------
# Run the extension plus a test driver extension in an isolated headless
# shell until the driver logs RP-UITEST DONE/FAIL or TIMEOUT seconds pass.
run_driver() {
    local DRIVER_DIR="$1" DRIVER_UUID="$2" TIMEOUT="$3"
    make_sandbox
    ln -s "$REPO_DIR/tests/$DRIVER_DIR" "$SANDBOX/data/gnome-shell/extensions/$DRIVER_UUID"
    # A third-party GTK theme as the user stylesheet, which GTK ranks above
    # every application stylesheet; the preferences window must keep its look.
    # RP_GTK_USER_CSS=<file> tries a real theme instead of the stand-in.
    mkdir -p "$SANDBOX/config/gtk-4.0"
    cp "${RP_GTK_USER_CSS:-$REPO_DIR/tests/ui-driver/hostile-gtk.css}" "$SANDBOX/config/gtk-4.0/gtk.css"

    # RP_UI_LANGUAGE=xx runs the session in that language. LANGUAGE only
    # counts under a real locale (not C, not C.UTF-8 in current glibc).
    local LANG_ENV=()
    if [ -n "${RP_UI_LANGUAGE:-}" ]; then LANG_ENV=(LANG=en_US.UTF-8 LC_ALL= LANGUAGE="$RP_UI_LANGUAGE"); fi

    # RP_SHELL_ENV="VAR=value ..." is extra environment for gnome-shell only
    # (allocator or renderer settings, to tell where the soak's RSS goes).
    start_log_stream "$LOG" "$SANDBOX/session.log"
    env "${LANG_ENV[@]}" XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_RUNTIME_DIR="$SANDBOX/run" RP_UITEST_SHOTS="$SANDBOX/shots" \
    dbus-run-session -- bash -c '
        env ${RP_SHELL_ENV:-} gnome-shell --headless --virtual-monitor 1280x720 >> "'"$LOG"'" 2>&1 &
        SHELL_PID=$!
        trap "kill $SHELL_PID 2>/dev/null; wait $SHELL_PID 2>/dev/null" EXIT INT TERM
        sleep 3
        gnome-extensions enable "'"$UUID"'"
        sleep 1
        gnome-extensions enable "'"$DRIVER_UUID"'"
        for _ in $(seq 1 "'"$TIMEOUT"'"); do
            grep -qE "RP-UITEST (DONE|FAIL)" "'"$LOG"'" && break
            sleep 1
        done
        sleep 1
    ' >> "$SANDBOX/session.log" 2>&1 || true
    stop_log_stream
}

# Verdict for a run_driver log: DONE and no bad lines.
driver_passed() {
    BAD="$(grep -nE "$BAD_LOG_PATTERN" "$LOG" || true)"
    grep -q "RP-UITEST DONE" "$LOG" && [ -z "$BAD" ]
}

driver_failure_details() {
    echo "$BAD" | head -n 40
    grep -A12 "RP-UITEST FAIL" "$LOG" | head -n 30 || true
    if ! grep -q "RP-UITEST" "$LOG"; then
        echo "  (driver never finished: timed out; end of the shell log follows)"
        grep -v "^$" "$LOG" | tail -n 25
    fi
}

# ------------------------------------------------------------------------------
# Command: Translations. pot writes the template translators start from;
# test-i18n proves every string on screen goes through gettext: a source scan
# for literal text, the template is current, then the panel and the window
# in a pseudo-language (every translated string reads ⟦…⟧).
# ------------------------------------------------------------------------------
cmd_pot() {
    log_title "Translation template"
    mkdir -p "$REPO_DIR/po"
    extract_pot "$REPO_DIR/po/$GETTEXT_DOMAIN.pot"
    local po
    for po in "$REPO_DIR"/po/*.po; do
        [ -f "$po" ] && msgmerge -q --update --backup=none "$po" "$REPO_DIR/po/$GETTEXT_DOMAIN.pot"
    done
    log_success "po/$GETTEXT_DOMAIN.pot: $(grep -c '^msgid ' "$REPO_DIR/po/$GETTEXT_DOMAIN.pot") messages"
}

cmd_test_i18n() {
    log_title "Translation coverage"
    check_syntax
    compile_schemas
    if ! node "$REPO_DIR/tests/i18n/untranslated.mjs" "$EXT_DIR"; then
        log_error "Literal text on screen without gettext (above)."
        exit 1
    fi
    # The committed template must list what the sources translate now.
    local tmp
    tmp="$(mktemp -d)"
    extract_pot "$tmp/now.pot"
    # (No diff: the test images have coreutils, not diffutils.)
    local now committed
    now="$(grep -E '^msg(id|_plural)' "$tmp/now.pot")"
    committed="$(grep -E '^msg(id|_plural)' "$REPO_DIR/po/$GETTEXT_DOMAIN.pot")"
    if [ "$now" != "$committed" ]; then
        log_error "po/$GETTEXT_DOMAIN.pot is out of date: run ./scripts/dev.sh pot (left: sources, right: template)"
        comm -3 <(sort <<< "$now") <(sort <<< "$committed") | head -n 20
        rm -rf "$tmp"
        exit 1
    fi
    rm -rf "$tmp"
    pseudo_translation

    local SANDBOX LOG BAD
    RP_UI_LANGUAGE=xx run_driver ui-driver rp-ui-driver@resource-pulse.test 300
    if driver_passed; then
        grep -o "RP-UITEST coverage: .*" "$LOG" | sed 's/^/  /' || true
        log_success "Every string on screen is translated (pseudo-language)"
        finish_sandbox
    else
        log_error "Translation coverage failed (log kept: $SANDBOX)"
        export_sandbox
        driver_failure_details
        exit 1
    fi
}

cmd_test_ui() {
    log_title "Running Headless UI Test (tabs, re-enable cycle, log scan)"

    check_syntax
    compile_schemas

    local SANDBOX LOG BAD
    # About 5 minutes on a laptop; more under software rendering on a runner.
    run_driver ui-driver rp-ui-driver@resource-pulse.test 480

    if driver_passed; then
        log_success "UI test passed${RP_KEEP:+ (screenshots: $SANDBOX/shots)}"
        finish_sandbox
    else
        log_error "UI test failed (log and screenshots kept: $SANDBOX)"
        export_sandbox
        driver_failure_details
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Overhead and soak test (the extension's own cost inside the shell)
# ------------------------------------------------------------------------------
cmd_test_overhead() {
    local SOAK="${1:-1200}"
    local WINDOW="${RP_OVERHEAD_WINDOW:-30}"
    log_title "Running Overhead & Soak Test (${WINDOW}s windows, ${SOAK}s soak)"

    check_syntax
    compile_schemas

    local SANDBOX LOG BAD
    export RP_SOAK="$SOAK" RP_OVERHEAD_WINDOW="$WINDOW"
    run_driver overhead-driver rp-overhead-driver@resource-pulse.test $(( WINDOW * 5 + SOAK + 120 ))

    grep -o "RP-OVERHEAD .*" "$LOG" | sed 's/^RP-OVERHEAD /  /' || true
    if driver_passed; then
        log_success "Overhead and soak within budget"
        finish_sandbox
    else
        log_error "Overhead / soak test failed (log kept: $SANDBOX)"
        export_sandbox
        driver_failure_details
        exit 1
    fi
}

# Only the soak's memory checks (heap census, RSS, fds, actors), which need no
# quiet machine; RP_SOAK_LEAK=1 plants a leak to prove they catch one.
cmd_test_soak() {
    export RP_SOAK_ONLY=1
    cmd_test_overhead "${1:-1200}"
}

# ------------------------------------------------------------------------------
# Command: Unit tests (pure parsers, ring buffer, presentation helpers, churn)
# ------------------------------------------------------------------------------
cmd_test_unit() {
    check_syntax
    compile_schemas
    log_info "Running parser / engine unit tests (gjs, no shell needed)..."
    if gjs -m "$REPO_DIR/tests/unit/unit.js"; then
        log_success "Unit tests passed"
    else
        log_error "Unit tests failed"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Run the tests against other GNOME Shell versions (needs docker)
#   Each version runs in a Fedora container that ships it (tests/compat).
#   Software rendering, no logind, no hardware sensors: this proves the
#   extension loads and its UI works on that shell, not its readings.
#   RP_COMPAT_OUT=<dir> keeps the logs there (CI uploads it on failure);
#   a failed test also leaves its sandbox's log and screenshots in
#   <dir>/gnome-<version>-<test>/. RP_COMPAT_NO_BATTERY=1 hides this
#   machine's batteries from the containers, as on a desktop (or on
#   GitHub's runners).
# ------------------------------------------------------------------------------
compat_fedora() {
    case "$1" in
        45) echo 39 ;; 46) echo 40 ;; 47) echo 41 ;; 48) echo 42 ;; 49) echo 43 ;; 50) echo 44 ;;
        *) return 1 ;;
    esac
}

# The line of a test's output that names what failed, without colour codes:
# the failing check if the test printed one, else the first bad log line,
# else the first error.
compat_failure() {
    local clean pat found
    clean="$(sed 's/\x1b\[[0-9;]*m//g' "$1")"
    for pat in 'RP-UITEST FAIL|PREFS-CHECK FAIL|^FAIL ' "$BAD_LOG_PATTERN" '\[ERROR\]'; do
        if found="$(grep -m1 -E "$pat" <<< "$clean")"; then
            # Without the line number and the shell's log prefix.
            sed -E 's/^[0-9]+: ?//; s/^[A-Za-z ]+-Message: [0-9:.]+: //' <<< "$found"
            return 0
        fi
    done
    echo "no failure line found; see $1"
}

cmd_test_compat() {
    local VERSIONS=("$@")
    # 45 can be asked for by name; it is known not to work (the menu body
    # stays empty there) and is not listed in metadata.json.
    [ "${#VERSIONS[@]}" -gt 0 ] || VERSIONS=(46 47 48 49)
    log_title "Compatibility tests: GNOME Shell ${VERSIONS[*]}"
    if ! command -v docker >/dev/null 2>&1; then
        log_error "docker not found: other GNOME Shell versions were NOT tested."
        exit 1
    fi
    compile_schemas >/dev/null

    local OUT v fed img t name actual line art why attempt built failed=0
    if [ -n "${RP_COMPAT_OUT:-}" ]; then
        OUT="$RP_COMPAT_OUT"
        mkdir -p "$OUT"
    else
        OUT="$(mktemp -d /tmp/rp-compat.XXXXXX)"
    fi
    local SUMMARY=() FAILS=() EXTRA=()
    # RP_COMPAT_TESTS="test-soak 1200" (comma-separated) runs other tests.
    local TESTS=("test-unit" "test-headless 8" "test-ui" "test-i18n" "test-zip")
    if [ -n "${RP_COMPAT_TESTS:-}" ]; then IFS=',' read -r -a TESTS <<< "$RP_COMPAT_TESTS"; fi
    if [ "${RP_COMPAT_NO_BATTERY:-0}" = "1" ]; then
        EXTRA=(--tmpfs /sys/class/power_supply)
    fi
    for v in "${VERSIONS[@]}"; do
        if ! fed="$(compat_fedora "$v")"; then
            log_error "No container image known for GNOME Shell $v"
            exit 1
        fi
        img="rp-compat:gnome-$v"
        log_info "GNOME Shell $v: building $img (Fedora $fed, a few minutes the first time)..."
        # A Fedora mirror sometimes fails mid-download: one more try.
        built=0
        : > "$OUT/gnome-$v-build.log"
        for attempt in 1 2; do
            if docker build -q --build-arg "FEDORA=$fed" -t "$img" "$REPO_DIR/tests/compat" >> "$OUT/gnome-$v-build.log" 2>&1; then
                built=1
                break
            fi
            if [ "$attempt" -eq 1 ]; then
                log_warn "GNOME Shell $v: image build failed, trying once more"
            fi
        done
        if [ "$built" -eq 0 ]; then
            SUMMARY+=("$v|not run|image build failed, see $OUT/gnome-$v-build.log")
            FAILS+=("GNOME Shell $v image build: $(tail -n 1 "$OUT/gnome-$v-build.log")")
            failed=1
            continue
        fi
        actual="$(docker run --rm -v "$REPO_DIR":/src:ro "$img" gnome-shell --version 2>/dev/null | awk '{print $3}')"
        line="$v|$actual"
        for t in "${TESTS[@]}"; do
            name="${t%% *}"
            # Writable by the container's own user, whatever its uid here.
            art="$OUT/gnome-$v-$name"
            mkdir -p "$art"
            chmod 777 "$art"
            # shellcheck disable=SC2086
            if docker run --rm -v "$REPO_DIR":/src:ro -v "$art":/artifacts -e RP_ARTIFACTS=/artifacts -e RP_SOAK_LEAK="${RP_SOAK_LEAK:-0}" -e RP_SOAK_VARIANT="${RP_SOAK_VARIANT:-all}" -e RP_SHELL_ENV="${RP_SHELL_ENV:-}" "${EXTRA[@]}" \
                    "$img" ./scripts/dev.sh $t > "$art.log" 2>&1; then
                line="$line|$name pass"
            else
                line="$line|$name FAIL"
                why="$(compat_failure "$art.log")"
                FAILS+=("GNOME Shell $v $name: $why")
                # Shown on the GitHub run's page.
                if [ -n "${GITHUB_ACTIONS:-}" ]; then
                    echo "::error title=GNOME Shell $v, $name::${why//%/%25}"
                fi
                failed=1
            fi
            # Figures the test reported (soak, overhead), for the CI log.
            sed 's/\x1b\[[0-9;]*m//g' "$art.log" | grep -E '^  [a-z]' | sed "s/^/  GNOME Shell $v $name: /" || true
            # Empty unless the test failed.
            if [ -z "$(ls -A "$art")" ]; then rmdir "$art"; fi
        done
        SUMMARY+=("$line")
        log_info "GNOME Shell $v: ${line#*|}"
    done

    echo
    printf '  %-8s %-10s %s\n' "target" "shell" "results"
    for line in "${SUMMARY[@]}"; do
        IFS='|' read -r v actual t <<< "$line"
        printf '  %-8s %-10s %s\n' "$v" "$actual" "${line#*|*|}"
    done | sed 's/|/, /g'
    echo
    if [ "${#FAILS[@]}" -gt 0 ]; then
        log_error "What failed:"
        printf '  %s\n' "${FAILS[@]}"
        echo
    fi
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
            echo "| GNOME Shell | installed | results |"
            echo "|---|---|---|"
            for line in "${SUMMARY[@]}"; do
                IFS='|' read -r v actual _ <<< "$line"
                t="${line#*|*|}"
                echo "| $v | $actual | ${t//|/, } |"
            done
            if [ "${#FAILS[@]}" -gt 0 ]; then
                echo
                echo "What failed:"
                echo
                echo '```'
                printf '%s\n' "${FAILS[@]}"
                echo '```'
            fi
        } >> "$GITHUB_STEP_SUMMARY"
    fi
    if [ "$failed" -eq 0 ]; then
        log_success "All listed versions passed"
        if [ -z "${RP_COMPAT_OUT:-}" ]; then rm -rf "$OUT"; fi
    else
        log_error "Some versions failed (logs: $OUT)"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Lint (ESLint, a development dependency: run 'npm ci' once)
# ------------------------------------------------------------------------------
cmd_lint() {
    log_title "Linting JavaScript (ESLint)"
    if [ ! -x "$REPO_DIR/node_modules/.bin/eslint" ]; then
        log_error "ESLint is not installed. Run 'npm ci' in $REPO_DIR first."
        exit 1
    fi
    if (cd "$REPO_DIR" && node_modules/.bin/eslint .); then
        log_success "Lint clean"
    else
        log_error "Lint errors found"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Show current extension status & journal logs
# ------------------------------------------------------------------------------
cmd_status() {
    log_title "Extension Status & Logs"
    gnome-extensions info "$UUID" 2>/dev/null || log_warn "Extension not found via gnome-extensions"

    echo -e "\n${BOLD}Recent extension journal logs:${RESET}"
    # The extension logs as 'ResourcePulse ...' / 'Error in <X> sample';
    # stack traces mention the UUID.
    journalctl -b 0 --since "10 minutes ago" --no-pager 2>/dev/null \
        | grep -E "ResourcePulse|resource-pulse@|Error in .* sample|UPower .* failed|CPU identity unavailable|Process sample failed" \
        | grep -v "dbus-daemon" | tail -n 25 || echo "No recent logs found."
}

# ------------------------------------------------------------------------------
# Command: Hardware Metric Accuracy & Dynamic Step Benchmark
# ------------------------------------------------------------------------------
cmd_benchmark() {
    local SUITE="${1:-all}"
    local ARG2="${2:-}"
    log_title "Running Hardware Accuracy & Dynamic Load Benchmark ($SUITE)"

    if ! command -v gjs >/dev/null 2>&1; then
        log_error "gjs is required to execute the benchmark harness."
        exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
        log_error "python3 is required to generate synthetic hardware loads."
        exit 1
    fi

    check_syntax

    gjs -m "$REPO_DIR/tests/bench/benchmark_runner.js" "$SUITE" "$ARG2"
}

# ------------------------------------------------------------------------------
# Command: Package extension (.zip)
# ------------------------------------------------------------------------------
cmd_pack() {
    log_title "Packaging Extension"
    check_syntax
    compile_schemas
    (cd "$EXT_DIR" && gnome-extensions pack --extra-source=lib --extra-source=ui --extra-source=icons \
        --extra-source="$REPO_DIR/LICENSE" --podir="$REPO_DIR/po" --gettext-domain="$GETTEXT_DOMAIN" \
        --out-dir="$REPO_DIR" --force)
    log_success "Extension packaged: $REPO_DIR/$UUID.shell-extension.zip"
}

# ------------------------------------------------------------------------------
# Help message
# ------------------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}Resource Pulse - Developer Automation Script${RESET}"
    echo -e "Usage: ${BOLD}./scripts/dev.sh [command] [--show-logs]${RESET}\n"
    echo -e "Commands:"
    echo -e "  ${GREEN}reload, reenable${RESET}   (Default) Compile schemas, verify symlink, and re-enable in current session"
    echo -e "  ${GREEN}test, window${RESET}       Launch a dedicated windowed GNOME Shell 50 test session (opens a Wayland window)"
    echo -e "  ${GREEN}test-headless [sec]${RESET} Enable in an isolated headless shell for [sec] (default 5) and scan its log"
    echo -e "  ${GREEN}test-unit${RESET}          Run parser / ring buffer / delta unit tests plus a process-churn test under gjs"
    echo -e "  ${GREEN}test-compat [ver..]${RESET} Run test-unit, test-headless, test-ui, test-i18n and test-zip on other GNOME Shell versions in containers (default 46-49; needs docker)"
    echo -e "  ${GREEN}lint${RESET}               Run ESLint (needs 'npm ci' once)"
    echo -e "  ${GREEN}test-ui${RESET}            Drive every tab with real clicks, light/dark, re-enable cycle; scan the shell log (RP_KEEP=1 keeps screenshots)"
    echo -e "  ${GREEN}test-overhead [sec]${RESET} Shell CPU with the extension off/on/open, menu churn, then a [sec] soak (default 1200) for leaks"
    echo -e "  ${GREEN}test-soak [sec]${RESET}    Only the soak's memory checks: heap census by kind, RSS, fds, actors (RP_SOAK_LEAK=1 plants a leak)"
    echo -e "  ${GREEN}benchmark [suite]${RESET}  Run synthetic hardware load benchmark (all, static, dynamic, cpu, mem, disk, read, proc, power, battery)"
    echo -e "  ${GREEN}status${RESET}             Show extension status and recent journal logs"
    echo -e "  ${GREEN}pot${RESET}                Write po/resource-pulse.pot (the strings to translate) and update po/*.po"
    echo -e "  ${GREEN}test-i18n${RESET}          Every string on screen goes through gettext: source scan, template current, pseudo-language run"
    echo -e "  ${GREEN}test-zip [sec]${RESET}     Pack, install the zip into an isolated shell (gnome-extensions install), enable it for [sec] (default 8) and scan its log"
    echo -e "  ${GREEN}pack${RESET}               Package extension into a distribution .zip"
    echo -e "  ${GREEN}help${RESET}               Show this help message\n"
    echo -e "Options:"
    echo -e "  ${GREEN}--show-logs${RESET}        Stream GNOME Shell / session logs to the terminal (test, test-headless,"
    echo -e "                     test-ui, test-overhead). Without it they only go to log files.\n"
}

# ------------------------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------------------------
# --show-logs may appear anywhere on the command line.
ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--show-logs" ]; then
        SHOW_LOGS=1
    else
        ARGS+=("$arg")
    fi
done
set -- "${ARGS[@]}"

case "${1:-reload}" in
    reload|reenable|enable)
        cmd_reload
        ;;
    test|dedicated|nested|window)
        cmd_test_dedicated
        ;;
    test-headless|test-ci|verify|check)
        cmd_test_ci "${2:-5}"
        ;;
    test-unit|unit)
        cmd_test_unit
        ;;
    test-compat|compat)
        shift
        cmd_test_compat "$@"
        ;;
    lint)
        cmd_lint
        ;;
    test-ui|ui)
        cmd_test_ui
        ;;
    test-soak)
        cmd_test_soak "${2:-1200}"
        ;;
    test-i18n)
        cmd_test_i18n
        ;;
    test-zip)
        cmd_test_zip "${2:-8}"
        ;;
    pot)
        cmd_pot
        ;;
    test-overhead|overhead|soak)
        cmd_test_overhead "${2:-1200}"
        ;;
    benchmark|test-benchmark|bench)
        shift
        cmd_benchmark "$@"
        ;;
    status|log|logs)
        cmd_status
        ;;
    pack|package|build)
        cmd_pack
        ;;
    help|--help|-h)
        cmd_help
        ;;
    *)
        log_error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
