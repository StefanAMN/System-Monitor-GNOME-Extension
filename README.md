# Resource Pulse GNOME Shell Extension

Resource Pulse is a modern system resource monitoring extension for GNOME Shell 50.1 (ESM-based, Wayland-only). It displays a compact, customizable summary of pinned metrics in the top bar, and reveals a detailed dashboard panel with live Cairo-based graphical charts (progress rings and sparkline history charts) when clicked.

## Features

- **Pinnable Top Bar Icons**: CPU %, Memory %, Battery %, Power Draw (W), Disk %, Network speed, Temperature, and GPU %.
- **Cairo-based Charts**: Circular rings for CPU/Memory/GPU utilization, live sparklines for history (~60 samples), and a custom battery glyph indicating level and charging status.
- **Top Processes Card**: Monitors the top CPU/Memory consumers only when the dropdown is open to minimize CPU overhead.
- **Libadwaita Preferences**: Access update intervals (1-10s), display modes, temperature/memory units, and warning thresholds.
- **Hardware-Friendly Fallback**: Automatically degrades and hides battery, RAPL power draw, thermal zone, or GPU details if the hardware is not present.

## File Structure

```
├── extension.js          # Core Extension logic, indicator, menu, Cairo widgets
├── prefs.js              # Preferences UI using Libadwaita window pages
├── stylesheet.css        # CSS styles for custom layouts and dashboard cards
├── metadata.json         # Extension metadata
├── schemas/              # GSettings schema definition
│   └── org.gnome.shell.extensions.resource-pulse.gschema.xml
└── lib/                  # Samplers for each metric domain
    ├── cpu.js
    ├── memory.js
    ├── battery.js
    ├── power.js
    ├── disk.js
    ├── network.js
    ├── thermal.js
    └── gpu.js
├── icons/                # Symbolic SVG icons
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
gnome-extensions pack --extra-source=lib --extra-source=icons
```
This generates `resource-pulse@yourdomain.example.shell-extension.zip`.
