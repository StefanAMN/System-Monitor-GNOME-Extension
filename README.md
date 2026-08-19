# Resource Pulse GNOME Shell Extension

Resource Pulse is a modern system resource monitoring extension for GNOME Shell 50.1 (ESM-based, Wayland-only). It displays a compact, customizable summary of pinned metrics in the top bar, and reveals a detailed dashboard panel with live Cairo-based graphical charts (progress rings and sparkline history charts) when clicked.

## Features

- **Pinnable Top Bar Icons**: CPU %, Memory %, Battery %, Power Draw (W), Disk %, Network speed, Temperature, and GPU %.
- **Cairo-based Charts**: Live sparklines backed by fixed 60-sample ring buffers, with real time-span and unit labels, plus progress bars for utilization.
- **Top Processes Card**: Current per-process CPU (delta of `/proc/[pid]/stat` ticks, 100% = one core) and resident memory, sampled only while the CPU or Memory tab is open.
- **Light and Dark**: The dashboard follows the shell's style variant; all colours live in `stylesheet.css` (`.rp-light` overrides).
- **Honest Readouts**: Metrics the machine cannot provide read `n/a` with the reason in the tooltip; "Disk %" always means space used on `/`.
- **Libadwaita Preferences**: Access update intervals (1-10s), display modes, temperature/memory units, and warning thresholds.
- **Hardware-Friendly Fallback**: Automatically degrades and hides battery, RAPL power draw, thermal zone, or GPU details if the hardware is not present.

## File Structure

```
├── extension.js          # Extension lifecycle, polling engine, indicator and dashboard
├── prefs.js              # Preferences UI using Libadwaita window pages
├── stylesheet.css        # CSS styles for custom layouts and dashboard cards
├── metadata.json         # Extension metadata
├── schemas/              # GSettings schema definition
├── icons/                # Bundled symbolic icons (thermal, CPU fallback)
├── ui/
│   └── widgets.js        # Cairo widgets: Sparkline, ProgressBar, ResizeHandle
├── lib/                  # Collectors (no UI code) and pure helpers
│   ├── cpu.js  memory.js  battery.js  power.js
│   ├── disk.js  network.js  thermal.js  gpu.js
│   ├── process.js        # Per-process CPU / memory from /proc/[pid]/stat
│   ├── ringbuffer.js     # Fixed-capacity history buffer
│   ├── format.js         # Unit formatting
│   ├── present.js        # Pure presentation decisions (n/a, icons, scales, hover)
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
./dev.sh test-unit   # parsers, deltas, ring buffer, process-churn run
./dev.sh test-ui     # real clicks on every tab, light/dark switch, disable/enable cycle in an isolated headless shell; fails on any JS error in the log
RP_KEEP=1 ./dev.sh test-ui   # same, and keeps the sandbox with screenshots of every tab
./dev.sh test-headless 10    # enable for 10 s in an isolated shell and scan its log
./dev.sh test-overhead       # the extension's own CPU cost inside the shell (off / on / open / CPU tab), menu churn, 10 min leak soak
./dev.sh benchmark all       # accuracy against synthetic load: CPU, memory, disk write/read, process list, step response,
                             # power/thermal response, battery vs upower (works from any directory)
```

## Installation & Deployment

### 1. Compile Schemas
After checking out or modifying GSettings, compile the schemas:
```bash
glib-compile-schemas schemas/
```

### 2. Dev Symlink
Symlink the extension folder to your local GNOME Shell extensions directory (replace the directory name with your target UUID):
```bash
mkdir -p ~/.local/share/gnome-shell/extensions/
ln -sfn "$(pwd)" ~/.local/share/gnome-shell/extensions/resource-pulse@yourdomain.example
```

### 3. Reload GNOME Shell
- **On a Nested Shell (Wayland/X11)**: Press `Alt+F2`, type `r` and hit `Enter` to reload the session.
- **On a standard Wayland Session**: You must log out and log back in, as GNOME Shell on Wayland does not support in-place reloads.

### 4. Enable Extension
Enable the extension via CLI:
```bash
gnome-extensions enable resource-pulse@yourdomain.example
```

## Pack for Distribution

To bundle the extension for upload or sharing:
```bash
gnome-extensions pack --extra-source=lib --extra-source=ui --extra-source=icons
```
This generates `resource-pulse@yourdomain.example.shell-extension.zip`.
