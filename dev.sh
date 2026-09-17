#!/usr/bin/env bash
# ==============================================================================
# Resource Pulse - GNOME Shell 50 Extension Development & Testing Tool
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UUID="resource-pulse@stefanamn.github.io"
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
    if [ ! -d "$SCRIPT_DIR/schemas" ]; then
        log_error "Directory $SCRIPT_DIR/schemas not found!"
        exit 1
    fi
    glib-compile-schemas "$SCRIPT_DIR/schemas"
    log_success "Schemas compiled successfully."
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
    for f in "$SCRIPT_DIR"/*.js "$SCRIPT_DIR"/lib/*.js "$SCRIPT_DIR"/ui/*.js \
             "$SCRIPT_DIR"/tests/*.js "$SCRIPT_DIR"/tests/ui-driver/*.js; do
        [ -f "$f" ] || continue
        if ! node --input-type=module --check < "$f" 2> >(sed "s|^\[stdin\]|${f#"$SCRIPT_DIR"/}|" >&2); then
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
        if [ "$CURRENT_TARGET" != "$SCRIPT_DIR" ]; then
            log_info "Updating symlink $TARGET_DIR -> $SCRIPT_DIR"
            ln -sfn "$SCRIPT_DIR" "$TARGET_DIR"
        fi
    elif [ -d "$TARGET_DIR" ]; then
        # A real directory may be an installed release or local edits: keep it.
        local BACKUP
        # Outside extensions/, or the shell would try to load the backup too.
        BACKUP="$(dirname "$EXTENSIONS_BASE")/$UUID.backup-$(date +%Y%m%d-%H%M%S)"
        log_warn "Moving existing copy at $TARGET_DIR to $BACKUP"
        mv "$TARGET_DIR" "$BACKUP"
        ln -sfn "$SCRIPT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $SCRIPT_DIR"
    else
        log_info "Creating extension symlink $TARGET_DIR -> $SCRIPT_DIR..."
        ln -sfn "$SCRIPT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $SCRIPT_DIR"
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
    ln -s "$SCRIPT_DIR" "$SANDBOX/data/gnome-shell/extensions/$UUID"
    LOG="$SANDBOX/shell.log"
}

# Lines in a shell log that mean this extension misbehaved.
BAD_LOG_PATTERN="RP-UITEST FAIL|JS ERROR|Clutter-ERROR|ResourcePulse poll error|Error in .* sample|already disposed|was not found when attempting to remove"

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
    echo -e "  • To test JS updates immediately without logging out: ${GREEN}./dev.sh test${RESET} (opens isolated window)"
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
    if grep -q "State: ACTIVE" "$SANDBOX/info.txt" 2>/dev/null && [ -z "$BAD" ]; then
        log_success "Extension ACTIVE for ${DURATION}s in an isolated shell with a clean log."
        finish_sandbox
    else
        log_error "Headless verification failed (sandbox kept: $SANDBOX)"
        cat "$SANDBOX/info.txt" 2>/dev/null | sed 's/^/  /'
        echo "$BAD" | head -n 40
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Drive the real UI in an isolated headless shell and scan its log
# ------------------------------------------------------------------------------
# Run the extension plus a test driver extension in an isolated headless
# shell until the driver logs RP-UITEST DONE/FAIL or TIMEOUT seconds pass.
run_driver() {
    local DRIVER_DIR="$1" DRIVER_UUID="$2" TIMEOUT="$3"
    make_sandbox
    ln -s "$SCRIPT_DIR/tests/$DRIVER_DIR" "$SANDBOX/data/gnome-shell/extensions/$DRIVER_UUID"

    start_log_stream "$LOG" "$SANDBOX/session.log"
    XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_RUNTIME_DIR="$SANDBOX/run" RP_UITEST_SHOTS="$SANDBOX/shots" \
    dbus-run-session -- bash -c '
        gnome-shell --headless --virtual-monitor 1280x720 >> "'"$LOG"'" 2>&1 &
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
    grep -q "RP-UITEST" "$LOG" || echo "  (driver never finished: timed out)"
}

cmd_test_ui() {
    log_title "Running Headless UI Test (tabs, re-enable cycle, log scan)"

    check_syntax
    compile_schemas

    local SANDBOX LOG BAD
    run_driver ui-driver rp-ui-driver@resource-pulse.test 150

    if driver_passed; then
        log_success "UI test passed${RP_KEEP:+ (screenshots: $SANDBOX/shots)}"
        finish_sandbox
    else
        log_error "UI test failed (log and screenshots kept: $SANDBOX)"
        driver_failure_details
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Overhead and soak test (the extension's own cost inside the shell)
# ------------------------------------------------------------------------------
cmd_test_overhead() {
    local SOAK="${1:-600}"
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
        driver_failure_details
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Unit tests (pure parsers, ring buffer, presentation helpers, churn)
# ------------------------------------------------------------------------------
cmd_test_unit() {
    check_syntax
    compile_schemas
    log_info "Running parser / engine unit tests (gjs, no shell needed)..."
    if gjs -m "$SCRIPT_DIR/tests/unit.js"; then
        log_success "Unit tests passed"
    else
        log_error "Unit tests failed"
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# Command: Lint (ESLint, a development dependency: run 'npm ci' once)
# ------------------------------------------------------------------------------
cmd_lint() {
    log_title "Linting JavaScript (ESLint)"
    if [ ! -x "$SCRIPT_DIR/node_modules/.bin/eslint" ]; then
        log_error "ESLint is not installed. Run 'npm ci' in $SCRIPT_DIR first."
        exit 1
    fi
    if (cd "$SCRIPT_DIR" && node_modules/.bin/eslint .); then
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

    gjs -m "$SCRIPT_DIR/tests/benchmark_runner.js" "$SUITE" "$ARG2"
}

# ------------------------------------------------------------------------------
# Command: Package extension (.zip)
# ------------------------------------------------------------------------------
cmd_pack() {
    log_title "Packaging Extension"
    check_syntax
    compile_schemas
    (cd "$SCRIPT_DIR" && gnome-extensions pack --extra-source=lib --extra-source=ui --extra-source=icons --extra-source=LICENSE --force)
    log_success "Extension packaged: $SCRIPT_DIR/$UUID.shell-extension.zip"
}

# ------------------------------------------------------------------------------
# Help message
# ------------------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}Resource Pulse - Developer Automation Script${RESET}"
    echo -e "Usage: ${BOLD}./dev.sh [command] [--show-logs]${RESET}\n"
    echo -e "Commands:"
    echo -e "  ${GREEN}reload, reenable${RESET}   (Default) Compile schemas, verify symlink, and re-enable in current session"
    echo -e "  ${GREEN}test, window${RESET}       Launch a dedicated windowed GNOME Shell 50 test session (opens a Wayland window)"
    echo -e "  ${GREEN}test-headless [sec]${RESET} Enable in an isolated headless shell for [sec] (default 5) and scan its log"
    echo -e "  ${GREEN}test-unit${RESET}          Run parser / ring buffer / delta unit tests plus a process-churn test under gjs"
    echo -e "  ${GREEN}lint${RESET}               Run ESLint (needs 'npm ci' once)"
    echo -e "  ${GREEN}test-ui${RESET}            Drive every tab with real clicks, light/dark, re-enable cycle; scan the shell log (RP_KEEP=1 keeps screenshots)"
    echo -e "  ${GREEN}test-overhead [sec]${RESET} Shell CPU with the extension off/on/open, menu churn, then a [sec] soak (default 600) for leaks"
    echo -e "  ${GREEN}benchmark [suite]${RESET}  Run synthetic hardware load benchmark (all, static, dynamic, cpu, mem, disk, read, proc, power, battery)"
    echo -e "  ${GREEN}status${RESET}             Show extension status and recent journal logs"
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
    lint)
        cmd_lint
        ;;
    test-ui|ui)
        cmd_test_ui
        ;;
    test-overhead|overhead|soak)
        cmd_test_overhead "${2:-600}"
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
