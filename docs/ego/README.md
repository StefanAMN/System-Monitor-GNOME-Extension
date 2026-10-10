# Publishing Resource Pulse on extensions.gnome.org

Everything for the submission, prepared 2026-10-24. The upload goes through the owner's account; nothing here is sent anywhere.

## Files

| File | What it is |
|---|---|
| `resource-pulse@stefanamn.github.io.shell-extension.zip` (repository root) | The extension to upload. Rebuild it from `master` with `./scripts/dev.sh pack`; `./scripts/dev.sh test-zip` installs that zip into an isolated shell and checks it runs with a clean log. Not in git (`*.zip` is ignored). |
| `docs/ego/screenshot.png` | The listing's screenshot, 1600 × 900: the top bar and the Overview, CPU and Thermal pages as the extension draws them on this machine (real readings), on a plain background (the test shell's wallpaper is distribution artwork, so it is left out). |

What the zip holds: the code (`extension.js`, `prefs.js`, `lib/`, `ui/`), `stylesheet.css`, three bundled icons, the settings schema as XML only (GNOME 44 and later compile it on install), `metadata.json`, `LICENSE`, and an empty `locale/` (no translations yet). No build scripts, tests, `.po`/`.pot` files or binaries.

## Steps

1. Build the zip from an up-to-date `master`: `./scripts/dev.sh pack`, then `./scripts/dev.sh test-zip`.
2. Sign in at https://extensions.gnome.org/accounts/login/ (or create the account there).
3. Open https://extensions.gnome.org/upload/, choose the zip, confirm the licence statement (the extension is MIT, which is compatible with GPL-2.0-or-later as the site requires), and upload.
4. The extension now has a page on the site, waiting for review. On that page, while signed in, add `docs/ego/screenshot.png` as the screenshot. The name, description and homepage come from `metadata.json`; to change them, change the file and upload a new version.
5. Wait for the review. Reviewers write on the extension's review page; the answers below cover the questions they usually ask.
6. Once it is approved, Extension Manager's "See details" shows the description, the screenshot and the links (Extension Manager 0.6.5 shows "No extension details available" until then).

## Listing text

Name: **Resource Pulse**. Homepage: https://github.com/StefanAMN/System-Monitor-GNOME-Extension. GNOME Shell 46, 47, 48, 49, 50.

Description (from `metadata.json`, 763 characters):

> Your computer's vital signs, one glance away: CPU, memory, battery, disk, network, temperature, power and GPU, live in the top bar and in a dropdown dashboard with charts, per-core and per-sensor readings, the busiest processes and alerts.
>
> * Usage tracking: which apps used the processor, memory, disk, graphics and battery, hour by hour, for 14 days
> * Diagnostics: what runs in the background, holds memory or drains the battery, with the evidence
> * Fix with an agent: hand the findings to a coding agent you choose; it runs in a terminal and asks before changing anything
> * Under 1 % of one core with the panel closed; everything stays on this computer
>
> Clipboard: the preferences window copies text only when you ask (Copy report, Copy prompt, Copy commands).

The site sets the version number itself (`version` is not in `metadata.json`). A `version-name` (a label such as "1.0") is optional and not set.

## Answers for the reviewers

Checked against the review guidelines as published on 2026-10-24 (https://gjs.guide/extensions/review-guidelines/review-guidelines.html). The item-by-item audit is in `docs/PLAN.md`, area 4; what changed since:

- **Lifecycle.** Nothing is created, connected or scheduled before `enable()`; `disable()` destroys every widget, disconnects every signal and removes every main-loop source, including the idle batches that read per-process disk counters (cancelled when tracking stops). The UI test's disable / enable cycles and the 20-minute soak (actors, file descriptors and the JS heap flat) check it.
- **Subprocesses.** Always argument lists, never a shell string, never privileged. In the shell: `getconf` and `lspci` once, `nvidia-smi` with a timeout (cancelled on disable), `kill` when the user ends a process from the panel, GNOME System Monitor launched as an app from the process lists. In the preferences window, only on a click: GNOME Settings › Power, and the agent hand-off, which opens a terminal (`xdg-terminal-exec` or one the user picks) running the coding agent the user chose (Claude Code, Codex, Gemini CLI when installed, or the user's own command) in a private folder. The first hand-off to each agent asks for confirmation and offers a preview of what is sent; the agent runs in its normal interactive mode with its own permission prompts.
- **Synchronous reads in the shell.** Only `/proc` files, which never touch a disk: per-process `stat` and `io`, read in batches of 32 per idle callback while the process pages are open, and every 30 s while usage tracking is on. Asynchronous reads of a few hundred such files cost the shell about 20 ms of CPU per round, the batches 1.5 ms.
- **Data leaving the machine.** None, and no telemetry. The only path out is the agent hand-off, started by the user, confirmed once per agent, with the report shown before it is sent. The report holds app names and figures, never paths, the user name or the host name.
- **Clipboard.** Declared in the description; written only on a button press (Copy report, Copy prompt, Copy commands); no shortcuts.
- **Files written.** Under `~/.local/share/resource-pulse/`: the usage history (only once the user switches tracking on), the daily network totals, and the agent's `report.md` (on a hand-off).
- **Licence.** MIT, compatible with GPL-2.0-or-later. No code from other extensions.

## For the owner to decide before uploading

- **AI-assisted code.** The guidelines allow AI as a development tool but reject submissions that show signs of unreviewed AI output, and expect the developer to explain any part of the code. This code was written with an AI assistant; read through it, or be ready to answer questions about it.
- **Brand names.** The overview's processor badge shows the vendor's name in vendor-like colours ("intel CORE", also AMD and NVIDIA badges on such machines), and the screenshot shows the Intel one. The agent hand-off names Claude Code, Codex and Gemini CLI as text. The guidelines ask for permission for brand names and logos; reviewers may ask for the badge to become neutral.
- **GNOME 51.** Released in September 2026; not claimed in `shell-version` because no test runs on it yet.

## shexli (static analyser for extension reviews)

Installed 2026-10-24: `pipx install shexli==0.2.1` (PyPI; AGPL-3.0; no author or source link on PyPI, so its wheel was read before installing: tree-sitter parsing and rule modules, no network, no subprocesses, zips unpacked into a temporary folder with path and size checks). Two things to know:
- With tree-sitter 0.26.0 (what pip picks) it crashes with a segmentation fault inside tree-sitter on Python 3.14; with 0.25.2 it runs: `pipx runpip shexli install "tree-sitter==0.25.2"`.
- A folder must be given as an absolute path (a relative one fails in `relative_to`).

Run: `shexli "$PWD/resource-pulse@stefanamn.github.io.shell-extension.zip"` (or `"$PWD/src"`, same findings).

Result on 2026-10-24 after `fix(shell)` (the three signal disconnects written out, the boot id and `/proc/self/stat` read asynchronously at enable): 0 errors, 2 warnings, both kept on purpose:

| Rule | Where | Why it stays |
|---|---|---|
| EGO-X-004 synchronous file IO in shell code | `appio.js` 65, `process.js` 186, 199, 352: per-process `/proc/<pid>/stat` and `io` in batches of 32 per idle callback | All `/proc`, in memory, never a disk. The batches replaced asynchronous reads that cost about 20 ms of shell CPU per round with 1.5 ms. Not a rule of the published guidelines. |
| EGO-L-002 objects assigned in `enable()` without `.destroy()` | `extension.js`: `_indicatorBox`, `_menuSection`, `_popupStack`, `_scrollView`, `_menuContainer`, `_menuViewport` | Children of `_indicator`; `disable()` destroys `_indicator` (and with it its children and menu), then nulls each reference. |

Before that change (master 0f78091) it also reported EGO-L-003 for the three settings signals disconnected in a loop, and EGO-X-004 for the two one-off reads at enable.
