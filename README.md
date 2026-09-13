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
- **Details Window in the Extension's Look**: The preferences window has Settings, Tracking and Diagnostics tabs and is styled like the panel throughout: navy (or pale blue in light mode) background, header and cards with a thin blue border, blue buttons and tabs, the metric tints and icons, panel-style stat tiles and a battery-use chart. It keeps this look under third-party GTK themes such as Orchis. It opens from ⋮ or from the battery page's "top app today" line.
- **Alerts**: A metric that stays above its limit for 30 s (CPU, memory, temperature, GPU, disk space, and time spent waiting for memory) puts a red ⚠ at the start of the indicator, turns its pinned value red and sends a notification naming the cause, such as the process using the CPU (at most one per metric every 10 minutes; can be switched off). Clicking the notification opens that metric's page. Unpinned metrics are watched too.
- **System Load**: How much of the time programs were waiting for the CPU, memory or the disk (the kernel's pressure figures), on those pages.
- **End a Process**: An ✕ on the top-process rows asks first, then asks the process (or the whole group, e.g. all of a browser's processes) to quit, and offers Force quit if it does not. Only your own processes; never the shell or other parts of the session.
- **1 h / 24 h Charts**: Every detail chart switches between the recent samples, the last hour (per minute) and the last day (per quarter hour), with the average and the peak; times nothing was read show as gaps.
- **Disk Users**: The Disk page lists the processes reading and writing right now.
- **Data per Day and Month**: The Network page shows today's and this month's traffic on physical interfaces, kept in `~/.local/share/resource-pulse/network-usage.json` (62 days).
- **Copy Report**: Diagnostics can copy its findings and the machine's state as text.
- **Keyboard**: Down or Tab from the top-bar button enters the panel; Tab moves between cards and buttons, Return or Space opens a card, Left / Right move between detail pages, Backspace goes back to the overview, Escape closes the panel.
- **Hardware-Friendly Fallback**: Automatically degrades and hides battery, RAPL power draw, thermal zone, or GPU details if the hardware is not present.

## File Structure

```
├── extension.js          # Extension lifecycle, polling engine, indicator and dashboard
├── prefs.js              # Preferences window (rows come from ui/prefsrows.js)
├── stylesheet.css        # CSS styles for custom layouts and dashboard cards
├── metadata.json         # Extension metadata
├── schemas/              # GSettings schema definition
├── docs/spec.md          # Original product spec (PLAN.md tracks milestones and verification)
├── icons/                # Bundled symbolic icons (thermal, CPU fallback)
├── ui/
│   ├── widgets.js        # Cairo widgets: Sparkline, ProgressBar, ResizeHandle
│   ├── prefsstyle.js     # The preferences window's stylesheet (panel look, blue accent)
│   ├── prefsrows.js      # Preferences rows (GTK side, never loaded by the shell)
│   ├── prefsbattery.js   # Tracking tab: switch, history, battery report (GTK side)
│   └── prefsdiagnostics.js # Diagnostics tab (GTK side)
├── lib/                  # Collectors (no UI code) and pure helpers
│   ├── cpu.js  memory.js  battery.js  power.js
│   ├── disk.js  network.js  thermal.js  gpu.js
│   ├── process.js        # Per-process CPU / memory / disk I/O; ending processes
│   ├── pressure.js       # Time spent waiting for CPU, memory, disk (PSI)
│   ├── alerts.js         # Sustained-threshold alerts
│   ├── longhistory.js    # 1 h / 24 h bucketed history (average and peak)
│   ├── netusage.js       # Network data per day, kept on disk
│   ├── appusage.js       # CPU time per app from the session's cgroups
│   ├── gpuusage.js       # GPU busy time per app from DRM fdinfo
│   ├── batteryledger.js  # Energy per app: attribution, hourly buckets, file
│   ├── batterytracker.js # Runs the ledger every 30 s in the shell
│   ├── diagnostics.js    # Rules for the Diagnostics tab
│   ├── systemstate.js    # Battery health, charge limit, power mode, backlight
│   ├── appnames.js       # App names and icons from desktop entries
│   ├── ringbuffer.js     # Fixed-capacity history buffer
│   ├── format.js         # Unit formatting
│   ├── settingsmodel.js  # The user-facing settings, described once for both settings UIs
│   ├── present.js        # Pure presentation decisions (n/a, icons, scales, hover)
│   ├── stats.js          # Time-weighted running mean / peak (power session stats)
│   ├── raplfix.js        # The single privileged (pkexec) action
│   └── utils.js          # Async file, directory and subprocess helpers
└── tests/
    ├── unit.js           # ./dev.sh test-unit  (plain gjs)
    ├── benchmark_runner.js, workload_generator.py   # ./dev.sh benchmark
    ├── overhead-driver/  # ./dev.sh test-overhead (isolated headless shell)
    └── ui-driver/        # ./dev.sh test-ui    (isolated headless shell; hostile-gtk.css stands in for a third-party theme)
```

## Testing

```bash
# Shell and session logs go to files; add --show-logs (anywhere on the line) to stream them here:
#   ./dev.sh test --show-logs
npm ci && ./dev.sh lint   # ESLint (development dependency only; the extension has no npm dependencies)
./dev.sh test-unit   # parsers, deltas, ring buffer, process-churn run
./dev.sh test-ui     # real clicks on every tab, light/dark switch, disable/enable cycle in an isolated headless shell; fails on any JS error in the log
RP_KEEP=1 ./dev.sh test-ui   # same, and keeps the sandbox with screenshots of every tab
./dev.sh test-headless 10    # enable for 10 s in an isolated shell and scan its log
./dev.sh test-overhead       # the extension's own CPU cost inside the shell (off / on / open / CPU tab), menu churn, 10 min leak soak
./dev.sh test-compat         # unit, headless and UI tests on GNOME Shell 46-49 in Fedora containers (needs docker; ./dev.sh test-compat 46 for one)
./dev.sh benchmark all       # accuracy against synthetic load: CPU, memory, disk write/read, process list, step response,
                             # power/thermal response, battery vs upower (works from any directory)
```

Every push and pull request runs the lint and the unit tests on GitHub Actions (`.github/workflows/ci.yml`). The UI tests need GNOME Shell and are run locally.

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
- **Language**: the interface is English only.
- **GNOME Shell versions**: developed and used on 50. Versions 46 to 49 are covered by the automated tests in containers (software rendering, Fedora builds), not by daily use. On 45 the menu does not render, so it is not listed.

## Installation & Deployment

### 1. Compile Schemas
After checking out or modifying GSettings, compile the schemas:
```bash
glib-compile-schemas schemas/
```

### 2. Dev Symlink
Symlink the extension folder into your local GNOME Shell extensions directory; the directory name must be the UUID from `metadata.json`:
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -sfn "$(pwd)" ~/.local/share/gnome-shell/extensions/resource-pulse@stefanamn.github.io
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
gnome-extensions pack --extra-source=lib --extra-source=ui --extra-source=icons --extra-source=LICENSE
```
This generates `resource-pulse@stefanamn.github.io.shell-extension.zip`.

## License

MIT, see [LICENSE](LICENSE).
