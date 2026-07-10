# AGENTS.md

Instructions for any AI coding agent (Claude Code, Cursor, Codex CLI, etc.) working in this repository.

## Project

**Resource Pulse** — a GNOME Shell 50 extension (Ubuntu 26.04, Wayland-only) that monitors CPU, memory, battery, power, disk, network, and thermal stats. It shows a user-configurable subset in the top bar and a full dashboard in a dropdown panel. Full functional spec lives in `docs/spec.md` (paste the original design prompt there if it isn't already).

## Environment

- GNOME Shell 50.1, ESM-based extensions only (no legacy `imports.*`).
- `shell-version` in `metadata.json` must stay `["50"]` unless explicitly asked to broaden compatibility.
- Wayland only — do not add X11-only code paths or assume a nested X11 test session works.

## Repo layout

```
extension.js              Entry point (Extension subclass)
prefs.js                  Preferences window (ExtensionPreferences subclass)
metadata.json
stylesheet.css
schemas/                  GSettings schema (.gschema.xml + compiled .gschemas.compiled)
lib/                      One module per metric domain: cpu.js, memory.js, battery.js,
                           power.js, disk.js, network.js, thermal.js, gpu.js
icons/                    Symbolic SVG icons
docs/                     Spec, design notes, test checklist
```

## Build / test / run

- Compile schemas after any change under `schemas/`:
  `glib-compile-schemas schemas/`
- Package for install: `gnome-extensions pack --extra-source=lib --extra-source=icons`
- Dev install (symlink into place, then reload):
  `ln -sfn "$(pwd)" ~/.local/share/gnome-shell/extensions/resource-pulse@yourdomain.example`
  then `Alt+F2 → r` in a nested Wayland test session, or fully log out/in for a real test.
- Lint JS with ESLint if a config is present (`.eslintrc*`); run it before committing and fix warnings rather than suppressing them.
- There is no headless unit-test harness for GNOME Shell UI code — validate logic-only modules (e.g. `/proc` parsers in `lib/*.js`) with plain `gjs` test scripts where feasible, and note any manual verification steps you couldn't automate in the commit message or PR description.

## Coding conventions

- ES Modules throughout; match the style already in `extension.js` (class-based `Extension`/`ExtensionPreferences` subclasses).
- All `GLib.timeout_add*`, `Gio.DBusProxy`, and signal connections created in `enable()` must be torn down in `disable()`. Treat any leak here as a bug, not a style nit.
- No synchronous file or subprocess I/O on the main loop — use the async `Gio.File` APIs and `Gio.Subprocess` for anything touching `/proc`, `/sys`, or external binaries (`upower`, `nvidia-smi`, etc.).
- Any metric that depends on hardware that may not exist (RAPL, GPU, hwmon sensors) must fail soft: hide the metric, never throw out of `enable()`.
- Keep metric-collection modules (`lib/*.js`) free of UI code; keep `extension.js`/`prefs.js` free of `/proc`/`/sys` parsing. Don't blur that boundary for convenience.

## Git workflow — commit discipline is a priority

This is the part to take seriously, not an afterthought:

- **Commit early and often.** Treat each logically complete, working change as commit-worthy — a new metric module, a UI section, a bug fix, a refactor. Don't batch unrelated work or let uncommitted changes pile up across many files.
- **Never leave the working tree dirty at the end of a turn.** Before finishing a response, run `git status`; if there are changes that resulted from your work, commit them (or explicitly explain to the user why they're intentionally left uncommitted, e.g. a half-finished experiment they asked you to leave for review).
- **One concern per commit.** Don't mix e.g. a battery-module fix with an unrelated CSS tweak. If a task naturally produces multiple unrelated changes, split them into separate commits.
- **Write real commit messages**, not `wip` or `fix stuff`:
  - Imperative mood, ~50-char summary line: `Add UPower-backed battery module`
  - Body (when the change isn't self-explanatory) explaining *why*, not just *what* — especially for anything working around hardware quirks (e.g. "RAPL unavailable on AMD, so power draw hides itself when energy_uj is absent").
- **Never commit generated/compiled artifacts** that belong in `.gitignore` — e.g. `schemas/gschemas.compiled`, packaged `.zip` output from `gnome-extensions pack`, editor/IDE files. Check `.gitignore` exists and covers these; create/update it if not.
- **Never commit secrets or machine-specific paths** (e.g. a hardcoded `/home/username/...` symlink target).
- **Don't rewrite shared history.** No `git commit --amend` or force-push on commits that may already be pushed/shared, unless the user explicitly asks for a history rewrite.
- **Before starting new work, check repo state** (`git status`, `git log -1`) so you're not building on top of an unexpected uncommitted change someone else left.
- If working across a multi-step feature, prefer several small commits over one large one at the end — it keeps `git bisect` useful if a GNOME Shell reload later breaks.

## Definition of done for any task

1. Code follows the conventions above.
2. `glib-compile-schemas` run if schemas changed.
3. Manually reloaded/verified in a test session where feasible; noted where it wasn't.
4. `git status` is clean — everything relevant is committed with a clear message.
5. Any newly-discovered hardware limitation or deferred TODO is written into `docs/` or a code comment, not just left in your own memory of the conversation.
