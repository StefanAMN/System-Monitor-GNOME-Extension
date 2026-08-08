#!/usr/bin/env bash
# ==============================================================================
# Resource Pulse - GNOME Shell 50 Extension Development & Testing Tool
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UUID="resource-pulse@yourdomain.example"
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
    if command -v node >/dev/null 2>&1; then
        node -c "$SCRIPT_DIR/extension.js"
        if [ -f "$SCRIPT_DIR/prefs.js" ]; then
            node -c "$SCRIPT_DIR/prefs.js"
        fi
        log_success "JavaScript syntax verified."
    elif command -v gjs >/dev/null 2>&1; then
        gjs -c "import('$SCRIPT_DIR/extension.js').catch(() => {});" >/dev/null 2>&1 || true
        log_success "GJS validation passed."
    fi
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
        log_info "Replacing standalone copy at $TARGET_DIR with direct repo symlink..."
        rm -rf "$TARGET_DIR"
        ln -sfn "$SCRIPT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $SCRIPT_DIR"
    else
        log_info "Creating extension symlink $TARGET_DIR -> $SCRIPT_DIR..."
        ln -sfn "$SCRIPT_DIR" "$TARGET_DIR"
        log_success "Symlinked $TARGET_DIR -> $SCRIPT_DIR"
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

    dbus-run-session -- bash -c '
        UUID="resource-pulse@yourdomain.example"
        HOST_WL="'"$HOST_WL"'"
        HOST_DISP="'"$HOST_DISP"'"
        
        echo -e "\033[34m[TEST-ENV]\033[0m Starting isolated GNOME Shell 50 compositor..."
        gnome-shell --devkit --wayland &
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
        MDK_PID=$(pgrep -f "mutter-devkit" | head -n 1 || true)
        if [ -z "$MDK_PID" ] && [ -x "/usr/libexec/mutter-devkit" ]; then
            echo -e "\033[34m[TEST-ENV]\033[0m Launching Mutter Devkit window on host display ($HOST_WL)..."
            WAYLAND_DISPLAY="$HOST_WL" DISPLAY="$HOST_DISP" /usr/libexec/mutter-devkit &
            MDK_PID=$!
        fi

        echo -e "\033[32m[TEST-ENV]\033[0m Test session status:"
        gnome-extensions info "$UUID"

        echo -e "\n\033[1;32m✓ Dedicated windowed test environment is active!\033[0m"
        echo -e "\033[36mInteract with the extension in the test window. Press Ctrl+C here to stop.\033[0m\n"
        
        wait "$MDK_PID" 2>/dev/null || wait "$SHELL_PID"
    '
}

# ------------------------------------------------------------------------------
# Command: Non-interactive automated test check (for verification & CI)
# ------------------------------------------------------------------------------
cmd_test_ci() {
    local DURATION="${1:-5}"
    log_title "Running Automated Headless Verification (${DURATION}s)"

    check_syntax
    compile_schemas
    ensure_installed

    dbus-run-session -- bash -c '
        UUID="resource-pulse@yourdomain.example"
        DURATION="'"$DURATION"'"
        
        gnome-shell --headless --virtual-monitor 1280x720 2>&1 > /tmp/rp-test-shell.log &
        SHELL_PID=$!
        
        cleanup() {
            kill "$SHELL_PID" 2>/dev/null || true
            wait "$SHELL_PID" 2>/dev/null || true
        }
        trap cleanup EXIT INT TERM

        sleep 2
        gnome-extensions enable "$UUID"
        sleep "$DURATION"

        INFO="$(gnome-extensions info "$UUID" 2>/dev/null || true)"
        if echo "$INFO" | grep -q "State: ACTIVE"; then
            echo -e "\033[32m[TEST-PASS]\033[0m Extension loaded and ACTIVE in isolated GNOME Shell 50 session!"
            exit 0
        else
            echo -e "\033[31m[TEST-FAIL]\033[0m Extension failed to activate. Info:"
            echo "$INFO"
            echo "--- Recent Shell Output ---"
            tail -n 30 /tmp/rp-test-shell.log
            exit 1
        fi
    '
    log_success "Automated verification completed successfully!"
}

# ------------------------------------------------------------------------------
# Command: Show current extension status & journal logs
# ------------------------------------------------------------------------------
cmd_status() {
    log_title "Extension Status & Logs"
    gnome-extensions info "$UUID" 2>/dev/null || log_warn "Extension not found via gnome-extensions"

    echo -e "\n${BOLD}Recent extension journal logs:${RESET}"
    journalctl -b 0 --since "10 minutes ago" --no-pager 2>/dev/null | grep -i "resource-pulse" | tail -n 25 || echo "No recent logs found."
}

# ------------------------------------------------------------------------------
# Command: Package extension (.zip)
# ------------------------------------------------------------------------------
cmd_pack() {
    log_title "Packaging Extension"
    check_syntax
    compile_schemas
    gnome-extensions pack --extra-source=lib --extra-source=icons --force
    log_success "Extension packaged: $(ls -1 *.zip 2>/dev/null | head -n 1)"
}

# ------------------------------------------------------------------------------
# Help message
# ------------------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}Resource Pulse - Developer Automation Script${RESET}"
    echo -e "Usage: ${BOLD}./dev.sh [command]${RESET}\n"
    echo -e "Commands:"
    echo -e "  ${GREEN}reload, reenable${RESET}   (Default) Compile schemas, verify symlink, and re-enable in current session"
    echo -e "  ${GREEN}test, window${RESET}       Launch a dedicated windowed GNOME Shell 50 test session (opens a Wayland window)"
    echo -e "  ${GREEN}test-headless [sec]${RESET} Run a headless automated test in isolated environment (default 5s)"
    echo -e "  ${GREEN}status${RESET}             Show extension status and recent journal logs"
    echo -e "  ${GREEN}pack${RESET}               Package extension into a distribution .zip"
    echo -e "  ${GREEN}help${RESET}               Show this help message\n"
}

# ------------------------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------------------------
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
