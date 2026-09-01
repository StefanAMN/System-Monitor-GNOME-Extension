# Resource Pulse GNOME Shell Extension

Resource Pulse is a modern system resource monitoring extension for GNOME Shell 46 to 50 (ESM-based, Wayland-only; developed on 50.1). It displays a compact, customizable summary of pinned metrics in the top bar, and reveals a detailed dashboard panel with live Cairo-based charts (history graphs and progress bars) when clicked.

## Features

- **Pinnable Top Bar Icons**: CPU %, Memory %, Battery %, Power Draw (W), Disk %, Network speed, Temperature, and GPU %.
- **Cairo-based Charts**: Live sparklines backed by fixed 60-sample ring buffers, with real time-span and unit labels, plus progress bars for utilization.
- **Top Processes Card**: Current per-process CPU (delta of `/proc/[pid]/stat` ticks, 100% = one core) and resident memory, sampled only while the CPU or Memory tab is open.
- **Light and Dark**: The dashboard follows the shell's style variant; all colours live in `stylesheet.css` (`.rp-light` overrides).
- **Honest Readouts**: Metrics the machine cannot provide read `n/a` with the reason in the tooltip; "Disk %" always means space used on `/`.
- **One Set of Settings, Two Places**: The panel's settings page (⋮ on the overview) and the Libadwaita preferences window are built from the same list (`lib/settingsmodel.js`): pinned metrics and their order, compact mode, tooltips, battery and network format, update interval (1–10 s), temperature and memory units, warning thresholds.
- **Keyboard**: Down or Tab from the top-bar button enters the panel; Tab moves between cards and controls, Return or Space activates, Left / Right change a choice or a number, Backspace goes back a page, Escape closes the panel.
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
│   ├── settings.js       # Settings page widgets: row, switch, segmented choice, stepper, pin tile
│   └── prefsrows.js      # Preferences rows (GTK side, never loaded by the shell)
├── lib/                  # Collectors (no UI code) and pure helpers
│   ├── cpu.js  memory.js  battery.js  power.js
│   ├── disk.js  network.js  thermal.js  gpu.js
│   ├── process.js        # Per-process CPU / memory from /proc/[pid]/stat
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
    └── ui-driver/        # ./dev.sh test-ui    (isolated headless shell)
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
- **GPU**: Intel, AMD and NVIDIA are supported, but only the Intel path has been run on real hardware. Integrated GPUs report no dedicated memory, temperature or fan; those fields read `--`.
- **Power draw**: on AC it comes from RAPL (CPU package only, not the whole machine) and needs read access to `energy_uj`, which most kernels restrict to root; while that is the case the settings page (Panel section) and the preferences window offer a one-time fix. On battery it is the battery's discharge rate.
- **Temperature**: the top bar shows the CPU package sensor, else the first core, else the hottest sensor.
- **Process CPU**: 100% means one full core, as in `top`. The list needs two samples, so it stays dimmed for about half a second after the tab opens.
- **Units**: rates are decimal (1 MB/s = 1 000 000 bytes/s). Memory follows the GB / GiB setting.
- **Session figures** (network totals, power average and peak) start over when the extension is disabled, which GNOME does on every screen lock.
- **Top bar room**: when the pinned metrics do not fit beside the clock, the last-pinned ones show only their icon (the value is in the hover tooltip) until there is room again. Pin the metrics you most want to read first.
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
