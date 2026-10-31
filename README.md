# Resource Pulse GNOME Shell Extension

Resource Pulse is a modern system resource monitoring extension for GNOME Shell 46 to 51 (ESM-based, Wayland-only; developed on 50.1). It displays a compact, customizable summary of pinned metrics in the top bar, and reveals a detailed dashboard panel with live Cairo-based charts (history graphs and progress bars) when clicked.

## Features

- **Pinnable Top Bar Icons**: CPU %, Memory %, Battery %, Power Draw (W), Disk %, Network speed, Temperature, and GPU %.
- **Cairo-based Charts**: Live sparklines backed by fixed 60-sample ring buffers, with real time-span and unit labels, plus progress bars for utilization.
- **Top Processes Card**: Current per-process CPU (delta of `/proc/[pid]/stat` ticks, 100% = one core) and resident memory, sampled only while the CPU, Memory or Disk tab is open.
- **Light and Dark**: The dashboard follows the shell's style variant; all colours live in `stylesheet.css` (`.rp-light` overrides).
- **Honest Readouts**: Metrics the machine cannot provide read `n/a` with the reason in the tooltip; "Disk %" always means space used on `/`.
- **Settings in One Window**: All settings live in the preferences window (⋮ on the overview or on any detail page opens it): pinned metrics and their order, compact mode, tooltips, battery and network format, how often to update, temperature and memory units, warning thresholds, a keyboard shortcut, and resetting the panel's size. The rows come from one list, `lib/common/settingsmodel.js`.
- **Update Every**: A slider from 0.25 s to 30 s in steps that widen with the value (0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30 s; default 2 s), so the fast end is precise and the slow end moves quickly. Under 1 s the extension passes its 1 % budget, which the slider's tooltip says: 0.25 s measured about +4 % of one core with the panel closed. The process list and the GPU are still read about once a second at most.
- **Every GPU at Once**: On a machine with several GPUs (a hybrid laptop) the GPU tab shows a card for each, in an order that never changes: its model and driver, load, its own chart, and whichever of clock, temperature, fan, power and video memory it reports. A GPU that is powered down reads "asleep" and is not woken to read it. The top bar and the overview have room for one number, the busiest awake GPU, which stays until another is 10 points busier; the tooltip lists the others, and the alert watches the busiest. With one GPU the tab keeps its single layout.
- **Battery Use per App (opt-in)**: Switched on in the details window's Tracking tab. Every 30 s the extension reads each app's CPU time from the session's cgroups (no privileges; short-lived processes included) and shares the CPU package energy above an idle baseline among the apps by that time; on Intel the integrated-graphics part goes to the apps by their GPU busy time (DRM fdinfo). The report shows battery used, average drain, how long a full charge would last, the apps ranked with their time in the background, and what cannot be attributed (idle and platform; display, radios and the rest; time while locked). 14 days of hourly totals, kept only in `~/.local/share/resource-pulse/battery-history.json`. The Battery tab also follows battery health over time (one entry a day, two years: health, charge cycles, full capacity).
- **Diagnostics**: Advice for longer runtime per charge and longer battery life, each with its evidence and, where it can be worked out, the minutes per charge it would save: apps working in the background, performance power mode on battery (one-click switch to Balanced), high screen brightness, a processor running hot on battery, battery wear, and a charge limit the battery supports but has off. A finding about an app working in the background offers Pause / Resume and Lower priority while it runs.
- **Fix with an Agent**: One button in Diagnostics lists the coding agents installed (Claude Code, the Claude app, Codex, Gemini CLI, Antigravity), including ones in per-user folders GNOME Shell's `PATH` lacks. It writes the report to a private folder and opens the chosen agent there with the prompt: typed and waiting for you where the agent allows that, sent to the CLIs that take it as an argument, on the clipboard for Antigravity's apps. The first hand-off to each agent asks first and offers a preview of what is sent.
- **Details Window in the Extension's Look**: The preferences window has Settings, Tracking and Diagnostics tabs and is styled like the panel and kept calm for reading: charcoal (or near-white in light mode) surfaces with faint borders and off-white text, the extension's blue on switches, tabs and highlights, the metric tints and icons, panel-style stat tiles and a battery-use chart. It keeps this look under third-party GTK themes such as Orchis. Opened from ⋮ or from the battery page's "top app today" line it has all three tabs; opened from the Extensions app it shows the settings only.
- **Alerts**: A metric that stays above its limit for 30 s (CPU, memory, temperature, GPU, disk space, time spent waiting for memory, and a processor slowed down to cool), or a battery that stays below its limit while discharging (default 15 %), puts a red ⚠ at the start of the indicator, turns its pinned value red (throttling only shows the ⚠, as the temperature may be under its limit) and sends a notification naming the cause, such as the process using the CPU (at most one per metric every 10 minutes; can be switched off). Clicking the notification opens that metric's page. Unpinned metrics are watched too.
- **System Load**: How much of the time programs were waiting for the CPU, memory or the disk (the kernel's pressure figures), on those pages.
- **Pause, Lower Priority, End**: The ⋮ on a process row opens a line right under it: Pause / Resume, Lower priority (niceness 10; a user cannot raise it back, so the button then goes away) and End…, which asks first, then asks the process (or the whole group, e.g. all of a browser's processes) to quit, and offers Force quit if it does not. While the line is open the rows keep their order. Paused groups come first in the CPU list with a pause icon, so they can be found and resumed. Only your own processes; never the shell or other parts of the session.
- **1 h / 24 h Charts**: Every detail chart switches between the recent samples, the last hour (per minute) and the last day (per quarter hour), with the average and the peak; times nothing was read show as gaps.
- **Disk Users**: The Disk page lists the processes reading and writing right now.
- **Process Search**: The CPU, Memory and Disk pages each have a field that filters their process list by name: every process is searched, not only the busiest five, and up to ten matches are shown. Closing the panel ends the search.
- **Data per Day and Month**: The Network page shows today's and this month's traffic on physical interfaces, kept in `~/.local/share/resource-pulse/network-usage.json` (62 days).
- **Copy Report**: Diagnostics can copy its findings and the machine's state as text.
- **Settings Backup**: Settings › Backup saves every setting to a JSON file and restores one (checked first: unknown settings and bad values are left out and listed), or resets them all after asking.
- **Smooth Changes**: CPU, GPU, power, network and disk values show their average over the last 10 s, each reading weighted by the time it covers, also in the top bar, so a number lags a real change by up to 10 s but does not swing with every reading. In the open panel they also glide to each new value over one update interval, at most 2 s (charts and the CPU page's per-core rows still step once per reading); the top bar changes once per reading to stay within the 1 % idle budget. Power reads in whole watts in the top bar and on its card. Display only: charts, alerts, power statistics and tracking use the raw readings. A switch in Settings turns it off.
- **Keyboard**: An optional shortcut opens and closes the panel (Settings › Panel, empty by default: click the row and press the keys). Down or Tab from the top-bar button enters the panel; Tab moves between cards and buttons, Return or Space opens a card or presses a button, Left / Right move between detail pages, Backspace goes back to the overview, Escape closes the panel.
- **Screen Readers**: Every value and control has an accessible name in words a screen reader says well ("Network download 1.2 MB per second", "CPU 7%, opens CPU details", "End firefox, 3 processes"), with button, toggle and list roles. Names change once per reading, not on every frame of a glide. Checked over AT-SPI on GNOME 46–51; not yet tried with Orca itself.
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
│   │   │   ├── process.js     # Per-process CPU / memory / disk I/O; pausing, lowering, ending processes
│   │   │   ├── appio.js       # Disk I/O per app
│   │   │   ├── machineusage.js  # Whole-machine usage for the tracking history
│   │   │   ├── throttle.js    # Share of time the processor was slowed down to cool
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
│   │   │   ├── sessiontotals.js  # Session figures kept through the screen lock
│   │   │   ├── trackingview.js   # What the Tracking tab shows
│   │   │   ├── diagnostics.js # Rules for the Diagnostics tab
│   │   │   └── agentreport.js # The report handed to a coding agent
│   │   └── common/           # Shared helpers
│   │       ├── settingsmodel.js  # The user-facing settings, described once
│   │       ├── present.js     # Pure presentation decisions (n/a, icons, scales, hover)
│   │       ├── format.js  utils.js  appnames.js  i18n.js
│   │       ├── backup.js      # Settings to and from a JSON file
│   │       ├── agentlaunch.js # Which agents and terminals are installed, how to start them
│   │       └── raplfix.js     # The commands that make CPU power readable (shown, never run)
│   └── ui/
│       ├── panel/            # Shell side: the top bar and the panel (methods of the extension)
│       │   ├── polling.js     # The poll loop: collectors, history, glide, network totals, tracking
│       │   ├── topbar.js      # Pinned metrics, fitting them, their values
│       │   ├── alerts.js      # ⚠, red values, notifications
│       │   ├── overview.js    # Overview cards and drag-to-reorder
│       │   ├── details.js     # Detail-page frame, range switch, tab switching
│       │   ├── pages/         # One file per detail page (cpu, memory, battery, power, disk, network, thermal, gpu)
│       │   ├── dashboard.js   # Applying a reading to the panel
│       │   ├── processes.js   # Top-process lists, Pause / Lower priority / End
│       │   ├── sizing.js      # Panel size and corner resize handles
│       │   ├── shared.js      # Settings getters, tooltip, icons, detail rows
│       │   ├── a11y.js        # Names for screen readers
│       │   ├── constants.js  mixins.js  compat.js
│       │   └── widgets.js     # Cairo widgets: Sparkline, ProgressBar, ResizeHandle
│       └── prefs/            # GTK side: the preferences window (never loaded by the shell)
│           ├── window.js      # Settings only from the Extensions app, all tabs from the panel
│           ├── rows.js  tracking.js  diagnostics.js  backup.js
│           ├── agent.js       # The Fix with an agent button
│           └── style.js       # The window's stylesheet
├── tests/
│   ├── unit/                 # scripts/dev.sh test-unit (plain gjs)
│   ├── ui-driver/            # scripts/dev.sh test-ui (isolated headless shell; hostile-gtk.css stands in for a third-party theme)
│   ├── overhead-driver/      # scripts/dev.sh test-overhead
│   ├── compat/               # scripts/dev.sh test-compat (GNOME 46-51 in containers)
│   ├── i18n/                 # scripts/dev.sh test-i18n (literal text shown without gettext)
│   └── bench/                # scripts/dev.sh benchmark
├── po/                       # resource-pulse.pot: the strings to translate (scripts/dev.sh pot)
├── scripts/dev.sh            # Install, test, lint, pack
└── docs/                     # spec.md (original spec), PLAN.md (milestones and verification), ego/ (publishing on extensions.gnome.org)
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
./scripts/dev.sh test-zip            # pack, install that zip into an isolated shell and check it runs with a clean log
./scripts/dev.sh test-compat         # unit, headless, UI, translation and packed-zip tests on GNOME Shell 46-51 in Fedora containers (needs docker; ./scripts/dev.sh test-compat 46 for one)
./scripts/dev.sh benchmark all       # accuracy against synthetic load: CPU, memory, disk write/read, process list, step response,
                             # power/thermal response, battery vs upower (works from any directory)
```

GitHub Actions (`.github/workflows/ci.yml`):
- every push runs the lint and the unit tests;
- pushes to `master`, pull requests and `v*` tags also run `test-compat` on GNOME Shell 46, 47, 48, 49, 50 and 51, one job each. A failing job names the failing check on the run's page and keeps its logs and screenshots as an artifact;
- pushes to `master` also run the 20-minute memory soak (`test-soak`) on GNOME 51;
- Actions › CI › Run workflow runs all of it on any branch;
- a `v*` tag that passes is packed (`scripts/dev.sh pack`) and published as a GitHub release with the `.zip` (tags with a `-`, such as `v1.2-rc1`, as pre-releases).

## Known limits

- **Several batteries**: they count as one (charge and rate combined); the Battery page lists each.
- **GPU**: Intel, AMD and NVIDIA are supported, but only the Intel path has been run on real hardware, and the page for several GPUs has only run on simulated readings (no machine with two was at hand). Integrated GPUs report no dedicated memory, fan or power draw (and often no temperature or clock); the GPU page leaves those fields out. Up to four GPUs get a chart of their own; a further one has its card without a chart. The 1 h and 24 h charts of each GPU start when the extension is enabled.
- **Fast updates**: sub-second intervals have not been tried with a real NVIDIA card, and below about 1 s the extension costs more than its 1 % budget.
- **Power draw**: on AC it comes from RAPL (CPU package only, not the whole machine) and needs read access to `energy_uj`, which most kernels restrict to root; while that is the case the preferences window (Settings › Troubleshooting) shows the two commands that fix it, to copy into a terminal (the extension never runs anything as root). On battery it is the battery's discharge rate.
- **Temperature**: the top bar shows the CPU package sensor, else the first core, else the hottest sensor.
- **Process CPU**: 100% means one full core, as in `top`. The list needs two samples, so it stays dimmed for about half a second after the tab opens.
- **Units**: rates are decimal (1 MB/s = 1 000 000 bytes/s). Memory follows the GB / GiB setting.
- **Session figures** (network totals, power average and peak) cover the login session: they are kept through the screen lock (GNOME disables extensions there) in a small file in the runtime directory, and traffic during the lock is counted. They start over at the next login or after `gnome-shell` restarts.
- **Top bar room**: when the pinned metrics do not fit beside the clock, the last-pinned ones show only their icon (the value is in the hover tooltip) until there is room again. Pin the metrics you most want to read first.
- **Battery use per app** is an estimate: CPU package energy shared by CPU time. Display, Wi-Fi and the rest of the machine cannot be measured per app on Linux and are shown as one line. Without readable RAPL counters apps are ranked by CPU time only. GPU time needs a driver that publishes DRM fdinfo (i915, xe, amdgpu; not the NVIDIA driver), and only Intel has an uncore energy counter to share by it; elsewhere graphics energy stays with the CPU share. GNOME disables extensions while the screen is locked, so the battery used then is shown but not attributed. A scope that ends between two samples loses up to 30 s of its CPU time. Apps started from a terminal count towards the terminal.
- **Language**: English only so far. Every string goes through gettext and `po/resource-pulse.pot` lists them (about 620), so a translation needs no code: copy it to `po/<language>.po` (for example `po/de.po`), translate the `msgstr` lines (keep `{placeholders}` and units as they are), and run `./scripts/dev.sh reload` (development copy) or `./scripts/dev.sh pack` (zip).
- **GNOME Shell versions**: developed and used on 50. Versions 46 to 49 and 51 are covered by the automated tests in containers (software rendering, Fedora builds), not by daily use. On 45 the menu does not render, so it is not listed.

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
