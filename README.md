# Resource Pulse GNOME Shell Extension

Resource Pulse is a modern system resource monitoring extension for GNOME Shell 46 to 50 (ESM-based, Wayland-only; developed on 50.1). It displays a compact, customizable summary of pinned metrics in the top bar, and reveals a detailed dashboard panel with live Cairo-based charts (history graphs and progress bars) when clicked.

## Features

- **Pinnable Top Bar Icons**: CPU %, Memory %, Battery %, Power Draw (W), Disk %, Network speed, Temperature, and GPU %.
- **Cairo-based Charts**: Live sparklines backed by fixed 60-sample ring buffers, with real time-span and unit labels, plus progress bars for utilization.
- **Top Processes Card**: Current per-process CPU (delta of `/proc/[pid]/stat` ticks, 100% = one core) and resident memory, sampled only while the CPU or Memory tab is open.
- **Light and Dark**: The dashboard follows the shell's style variant; all colours live in `stylesheet.css` (`.rp-light` overrides).
- **Honest Readouts**: Metrics the machine cannot provide read `n/a` with the reason in the tooltip; "Disk %" always means space used on `/`.
- **Settings in One Window**: All settings live in the preferences window (⋮ on the overview or on any detail page opens it): pinned metrics and their order, compact mode, tooltips, battery and network format, update interval (1–10 s), temperature and memory units, warning thresholds, and resetting the panel's size. The rows come from one list, `lib/settingsmodel.js`.
- **Battery Use per App (opt-in)**: Switched on in the details window's Tracking tab. Every 30 s the extension reads each app's CPU time from the session's cgroups (no privileges; short-lived processes included) and shares the CPU package energy above an idle baseline among the apps by that time; on Intel the integrated-graphics part goes to the apps by their GPU busy time (DRM fdinfo). The report shows battery used, average drain, how long a full charge would last, the apps ranked with their time in the background, and what cannot be attributed (idle and platform; display, radios and the rest; time while locked). 14 days of hourly totals, kept only in `~/.local/share/resource-pulse/battery-history.json`.
- **Diagnostics**: Advice for longer runtime per charge and longer battery life, each with its evidence and, where it can be worked out, the minutes per charge it would save: apps working in the background, performance power mode on battery (one-click switch to Balanced), high screen brightness, a processor running hot on battery, battery wear, and a charge limit the battery supports but has off.
- **Details Window in the Extension's Look**: The preferences window has Settings, Tracking and Diagnostics tabs and is styled like the panel and kept calm for reading: charcoal (or near-white in light mode) surfaces with faint borders and off-white text, the extension's blue on switches, tabs and highlights, the metric tints and icons, panel-style stat tiles and a battery-use chart. It keeps this look under third-party GTK themes such as Orchis. Opened from ⋮ or from the battery page's "top app today" line it has all three tabs; opened from the Extensions app it shows the settings only.
- **Alerts**: A metric that stays above its limit for 30 s (CPU, memory, temperature, GPU, disk space, and time spent waiting for memory) puts a red ⚠ at the start of the indicator, turns its pinned value red and sends a notification naming the cause, such as the process using the CPU (at most one per metric every 10 minutes; can be switched off). Clicking the notification opens that metric's page. Unpinned metrics are watched too.
- **System Load**: How much of the time programs were waiting for the CPU, memory or the disk (the kernel's pressure figures), on those pages.
- **End a Process**: An ✕ on the top-process rows asks first, then asks the process (or the whole group, e.g. all of a browser's processes) to quit, and offers Force quit if it does not. Only your own processes; never the shell or other parts of the session.
- **1 h / 24 h Charts**: Every detail chart switches between the recent samples, the last hour (per minute) and the last day (per quarter hour), with the average and the peak; times nothing was read show as gaps.
- **Disk Users**: The Disk page lists the processes reading and writing right now.
- **Data per Day and Month**: The Network page shows today's and this month's traffic on physical interfaces, kept in `~/.local/share/resource-pulse/network-usage.json` (62 days).
- **Copy Report**: Diagnostics can copy its findings and the machine's state as text.
- **Smooth Changes**: In the open panel, values and bars glide to each new reading over one update interval instead of jumping (charts still step once per reading); CPU, GPU, network and disk speeds are lightly averaged, also in the top bar, which changes once per reading to stay within the 1 % idle budget. Alerts and history use the raw readings. A switch in Settings turns it off.
- **Keyboard**: Down or Tab from the top-bar button enters the panel; Tab moves between cards and buttons, Return or Space opens a card or a process row, Left / Right move between detail pages, Backspace goes back to the overview, Escape closes the panel.
- **Screen Readers**: Every value and control has an accessible name in words a screen reader says well ("Network download 1.2 MB per second", "CPU 7%, opens CPU details", "End firefox, 3 processes"), with button, toggle and list roles. Names change once per reading, not on every frame of a glide. Checked over AT-SPI on GNOME 46–50; not yet tried with Orca itself.
- **Hardware-Friendly Fallback**: Automatically degrades and hides battery, RAPL power draw, thermal zone, or GPU details if the hardware is not present.

## File Structure

```
├── src/                      # The extension itself: what is installed and packed
│   ├── extension.js          # enable() / disable(); installs the panel's method groups
│   ├── prefs.js              # Preferences entry point (window built in ui/prefs/window.js)
│   ├── metadata.json  stylesheet.css
│   ├── schemas/              # GSettings schema
│   ├── icons/                # Bundled symbolic icons (thermal, CPU fallback)
│   ├── lib/
│   │   ├── collectors/       # Read the system; raw numbers, no UI (HAL layer)
│   │   │   ├── cpu.js  memory.js  battery.js  power.js  disk.js  network.js  thermal.js  gpu.js
│   │   │   ├── process.js     # Per-process CPU / memory / disk I/O; ending processes
│   │   │   ├── pressure.js    # Time spent waiting for CPU, memory, disk (PSI)
│   │   │   ├── appusage.js    # CPU time per app from the session's cgroups
│   │   │   ├── gpuusage.js    # GPU busy time per app from DRM fdinfo
│   │   │   └── systemstate.js # Battery health, charge limit, power mode, backlight
│   │   ├── engine/           # Turn readings into results over time (aggregator layer)
│   │   │   ├── alerts.js      # Sustained-threshold alerts
│   │   │   ├── longhistory.js # 1 h / 24 h bucketed history (average and peak)
│   │   │   ├── smoothing.js   # Display-only averaging and gliding between readings
│   │   │   ├── ringbuffer.js  stats.js
│   │   │   ├── netusage.js    # Network data per day, kept on disk
│   │   │   ├── batteryledger.js  batterytracker.js   # Energy per app, every 30 s
│   │   │   └── diagnostics.js # Rules for the Diagnostics tab
│   │   └── common/           # Shared helpers
│   │       ├── settingsmodel.js  # The user-facing settings, described once
│   │       ├── present.js     # Pure presentation decisions (n/a, icons, scales, hover)
│   │       ├── format.js  utils.js  appnames.js
│   │       └── raplfix.js     # The single privileged (pkexec) action
│   └── ui/
│       ├── panel/            # Shell side: the top bar and the panel (methods of the extension)
│       │   ├── polling.js     # The poll loop: collectors, history, glide, network totals, tracking
│       │   ├── topbar.js      # Pinned metrics, fitting them, their values
│       │   ├── alerts.js      # ⚠, red values, notifications
│       │   ├── overview.js    # Overview cards and drag-to-reorder
│       │   ├── details.js     # Detail-page frame, range switch, tab switching
│       │   ├── pages/         # One file per detail page (cpu, memory, battery, power, disk, network, thermal, gpu)
│       │   ├── dashboard.js   # Applying a reading to the panel
│       │   ├── processes.js   # Top-process lists, End / Force quit
│       │   ├── sizing.js      # Panel size and corner resize handles
│       │   ├── shared.js      # Settings getters, tooltip, icons, detail rows
│       │   ├── constants.js  mixins.js
│       │   └── widgets.js     # Cairo widgets: Sparkline, ProgressBar, ResizeHandle
│       └── prefs/            # GTK side: the preferences window (never loaded by the shell)
│           ├── window.js      # Settings only from the Extensions app, all tabs from the panel
│           ├── rows.js  tracking.js  diagnostics.js
│           └── style.js       # The window's stylesheet
├── tests/
│   ├── unit/                 # scripts/dev.sh test-unit (plain gjs)
│   ├── ui-driver/            # scripts/dev.sh test-ui (isolated headless shell; hostile-gtk.css stands in for a third-party theme)
│   ├── overhead-driver/      # scripts/dev.sh test-overhead
│   ├── compat/               # scripts/dev.sh test-compat (GNOME 46-50 in containers)
│   ├── i18n/                 # scripts/dev.sh test-i18n (literal text shown without gettext)
│   └── bench/                # scripts/dev.sh benchmark
├── po/                       # resource-pulse.pot: the strings to translate (scripts/dev.sh pot)
├── scripts/dev.sh            # Install, test, lint, pack
└── docs/                     # spec.md (original spec), PLAN.md (milestones and verification)
```

The installed extension is a symlink to `src/` (`scripts/dev.sh` creates it).

## Testing

```bash
# Shell and session logs go to files; add --show-logs (anywhere on the line) to stream them here:
#   ./scripts/dev.sh test --show-logs
npm ci && ./scripts/dev.sh lint   # ESLint (development dependency only; the extension has no npm dependencies)
./scripts/dev.sh test-unit   # parsers, deltas, ring buffer, process-churn run
./scripts/dev.sh test-ui     # real clicks on every tab, light/dark switch, disable/enable cycle in an isolated headless shell; fails on any JS error in the log
./scripts/dev.sh test-i18n   # every string on screen goes through gettext: a source scan, the template is current, and the panel and window in a pseudo-language (⟦…⟧)
./scripts/dev.sh pot         # rewrite po/resource-pulse.pot after changing text (test-i18n fails until it is current)
RP_KEEP=1 ./scripts/dev.sh test-ui   # same, and keeps the sandbox with screenshots of every tab
./scripts/dev.sh test-headless 10    # enable for 10 s in an isolated shell and scan its log
./scripts/dev.sh test-overhead       # the extension's own CPU cost inside the shell (off / on / open / CPU tab), menu churn, 20 min leak soak
./scripts/dev.sh test-soak           # only the soak: live JavaScript objects counted by kind (a leak grows in both halves), RSS, fds, actors
RP_SOAK_LEAK=1 ./scripts/dev.sh test-soak   # the same with a planted leak (one object kept per reading), which must fail
./scripts/dev.sh test-compat         # unit, headless, UI and translation tests on GNOME Shell 46-49 in Fedora containers (needs docker; ./scripts/dev.sh test-compat 46 for one, 50 also works)
./scripts/dev.sh benchmark all       # accuracy against synthetic load: CPU, memory, disk write/read, process list, step response,
                             # power/thermal response, battery vs upower (works from any directory)
```

GitHub Actions (`.github/workflows/ci.yml`):
- every push runs the lint and the unit tests;
- pushes to `master`, pull requests and `v*` tags also run `test-compat` on GNOME Shell 46, 47, 48, 49 and 50, one job each. A failing job names the failing check on the run's page and keeps its logs and screenshots as an artifact;
- pushes to `master` also run the 20-minute memory soak (`test-soak`) on GNOME 50;
- Actions › CI › Run workflow runs all of it on any branch;
- a `v*` tag that passes is packed (`scripts/dev.sh pack`) and published as a GitHub release with the `.zip` (tags with a `-`, such as `v1.2-rc1`, as pre-releases).

## Known limits

- **One battery, one GPU**: the first battery and the first GPU found are shown.
- **GPU**: Intel, AMD and NVIDIA are supported, but only the Intel path has been run on real hardware. Integrated GPUs report no dedicated memory, fan or power draw (and often no temperature or clock); the GPU page leaves those fields out.
- **Power draw**: on AC it comes from RAPL (CPU package only, not the whole machine) and needs read access to `energy_uj`, which most kernels restrict to root; while that is the case the preferences window (Settings › Troubleshooting) offers a one-time fix. On battery it is the battery's discharge rate.
- **Temperature**: the top bar shows the CPU package sensor, else the first core, else the hottest sensor.
- **Process CPU**: 100% means one full core, as in `top`. The list needs two samples, so it stays dimmed for about half a second after the tab opens.
- **Units**: rates are decimal (1 MB/s = 1 000 000 bytes/s). Memory follows the GB / GiB setting.
- **Session figures** (network totals, power average and peak) start over when the extension is disabled, which GNOME does on every screen lock.
- **Top bar room**: when the pinned metrics do not fit beside the clock, the last-pinned ones show only their icon (the value is in the hover tooltip) until there is room again. Pin the metrics you most want to read first.
- **Battery use per app** is an estimate: CPU package energy shared by CPU time. Display, Wi-Fi and the rest of the machine cannot be measured per app on Linux and are shown as one line. Without readable RAPL counters apps are ranked by CPU time only. GPU time needs a driver that publishes DRM fdinfo (i915, xe, amdgpu; not the NVIDIA driver), and only Intel has an uncore energy counter to share by it; elsewhere graphics energy stays with the CPU share. GNOME disables extensions while the screen is locked, so the battery used then is shown but not attributed. A scope that ends between two samples loses up to 30 s of its CPU time. Apps started from a terminal count towards the terminal.
- **Language**: English only so far. Every string goes through gettext and `po/resource-pulse.pot` lists them (about 400), so a translation needs no code: copy it to `po/<language>.po` (for example `po/de.po`), translate the `msgstr` lines (keep `{placeholders}` and units as they are), and run `./scripts/dev.sh reload` (development copy) or `./scripts/dev.sh pack` (zip).
- **GNOME Shell versions**: developed and used on 50. Versions 46 to 49 are covered by the automated tests in containers (software rendering, Fedora builds), not by daily use. On 45 the menu does not render, so it is not listed.

## Installation & Deployment

### 1. Compile Schemas
After checking out or modifying GSettings, compile the schemas:
```bash
glib-compile-schemas src/schemas/
```

### 2. Dev Symlink
Symlink the extension folder (`src/`) into your local GNOME Shell extensions directory; the directory name must be the UUID from `metadata.json`. `./scripts/dev.sh` does this for you:
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -sfn "$(pwd)/src" ~/.local/share/gnome-shell/extensions/resource-pulse@stefanamn.github.io
```

### 3. Reload GNOME Shell
- **On a Nested Shell (Wayland/X11)**: Press `Alt+F2`, type `r` and hit `Enter` to reload the session.
- **On a standard Wayland Session**: You must log out and log back in, as GNOME Shell on Wayland does not support in-place reloads.

### 4. Enable Extension
Enable the extension via CLI:
```bash
gnome-extensions enable resource-pulse@stefanamn.github.io
```

## Pack for Distribution

To bundle the extension for upload or sharing:
```bash
./scripts/dev.sh pack
```
This generates `resource-pulse@stefanamn.github.io.shell-extension.zip` in the repository root. Each GitHub release has the same zip attached; install one with:
```bash
gnome-extensions install --force resource-pulse@stefanamn.github.io.shell-extension.zip
```
then log out and back in, and enable it.

## License

MIT, see [LICENSE](LICENSE).
