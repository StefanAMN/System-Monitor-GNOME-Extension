Target environment


Ubuntu 26.04 LTS, kernel 7.0.0-27-generic
GNOME Shell 50.1, Wayland only (GDM + Shell, Xwayland for legacy apps — note that GNOME Shell 50 dropped X11 session support entirely, so don't rely on any X11-only APIs or nested X11 test sessions)
Extensions use ES Modules (standard since GNOME 45) — no legacy imports.* syntax
Target shell-version in metadata.json: ["50"]


Goal

Build a GNOME Shell extension called "Resource Pulse" that monitors system resources (CPU, memory, battery, power draw, disk, network, temperature, etc.), shows a compact, user-configurable summary permanently in the top bar, and reveals full detail plus a graphical dashboard in a dropdown panel when clicked.

Core interaction model


Top bar indicator: a PanelMenu.Button showing only the metrics the user has pinned. Each pinned metric renders as a small icon + short numeric label (e.g. CPU 34%) laid out horizontally, separated by thin dividers.
Left-click on the indicator opens the standard PopupMenu dropdown containing:

A selection grid/list of every available metric, each row with a toggle (PopupSwitchMenuItem or a custom clickable row) that pins/unpins it to the top bar in real time.
A live dashboard section below the selector showing all metrics (pinned or not) with mini sparkline/graph history (last ~60 samples), using St.DrawingArea + Cairo for custom graphs (rings for CPU/memory %, line graphs for history, a battery glyph with fill level).
Values update in place without closing the menu.



Persist the user's pinned-metric selection and any layout/order preference across sessions using the extension's Gio.Settings (a GSettings schema shipped with the extension), not just in-memory state.
Provide a preferences window (prefs.js using Adw.PreferencesWindow / Adw.PreferencesPage, per the modern GNOME 45+ prefs API) that duplicates the pin/unpin controls plus:

Update/poll interval (slider, e.g. 1–10s, with sane default ~2s)
Unit choice (°C/°F, GB/GiB, etc.)
Compact vs. detailed top-bar label style (icon-only vs icon+number)
Color thresholds for warnings (e.g. CPU > 90% turns red)





Architecture requirements


extension.js: default-exports a class extending Extension (per current GNOME 45+ API — import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'). Implement enable() / disable() cleanly; destroy all sources, timers (GLib.timeout_add / GLib.source_remove), and signal connections in disable() to avoid leaks — GNOME Shell reviewers reject extensions that leak timeouts.
prefs.js: default-exports a class extending ExtensionPreferences, building the Adw-based prefs UI.
metadata.json: correct uuid (reverse-DNS style, e.g. resource-pulse@yourdomain.example), shell-version: ["50"], settings-schema pointing at your GSettings schema id.
schemas/org.gnome.shell.extensions.resource-pulse.gschema.xml: GSettings schema defining keys for pinned metrics (as a string array or bitmask), poll interval, units, thresholds. Compile with glib-compile-schemas.
Data collection modules — split by domain, e.g. lib/cpu.js, lib/memory.js, lib/battery.js, lib/power.js, lib/disk.js, lib/network.js, lib/thermal.js. Each module exposes an async sample() returning normalized values.
Never block the main loop. Read /proc and /sys pseudo-files asynchronously (Gio.File async read APIs, or spawn helper processes via Gio.Subprocess when a value isn't available from /proc//sys, e.g. upower for battery/power details). Avoid synchronous file I/O or synchronous subprocess calls on the UI thread.
Use GLib.timeout_add_seconds (or add if sub-second precision is truly needed) for the polling loop, driven by the user's configured interval; a single scheduler feeding all metric modules is preferable to one timer per metric.
Style with a stylesheet.css scoped to the extension; use GNOME's semantic color variables where possible so the widget respects light/dark theme and accent color.
Icons: prefer symbolic icons bundled in an icons/ directory (SVG, single-color, following GNOME's symbolic icon guidelines) with graceful fallback to built-in icon-theme names (e.g. battery-good-symbolic).


Data sources (Linux/GNOME specifics)


CPU usage: parse /proc/stat, compute delta between two samples (idle vs total jiffies) — do not read a single snapshot and report a bogus instantaneous value.
Per-core + load average: /proc/loadavg, /proc/cpuinfo for core count.
Memory/swap: /proc/meminfo.
Battery/power: prefer UPower over DBus (org.freedesktop.UPower) rather than shelling out, since GNOME Shell already talks to UPower for its own battery indicator — reuse that pattern (Gio.DBusProxy to /org/freedesktop/UPower/devices/DisplayDevice). Fall back to /sys/class/power_supply/BAT0/... if DBus is unavailable.
CPU/package power draw: powercap/RAPL via /sys/class/powercap/intel-rapl:*/energy_uj where available (Intel); note this doesn't exist on all hardware (AMD/ARM) — handle gracefully and hide the metric if unsupported rather than showing an error.
Disk usage: Gio.File + g_file_query_filesystem_info for space; /proc/diskstats for I/O throughput deltas.
Network: /proc/net/dev, delta-based throughput per interface.
Temperature/fan: /sys/class/thermal/thermal_zone*/temp and /sys/class/hwmon/hwmon*/ — sensor availability is hardware-dependent; detect and degrade gracefully.
GPU: best-effort — nvidia-smi subprocess (async) if present for NVIDIA, /sys/class/drm/card*/device/gpu_busy_percent for AMD; treat as optional/hidden if no supported GPU is detected.


Quality bar


Follow the current gjs.guide extension guidelines (ESM modules, no deprecated imports.misc.extensionUtils).
No polling faster than necessary; respect the user-configured interval to keep CPU overhead of the monitor itself negligible.
Handle missing sensors/hardware without throwing — hide the unavailable metric from both the top bar picker and the dashboard, don't crash enable().
Clean, commented code; a README.md with install/dev instructions (gnome-extensions pack, symlinking into ~/.local/share/gnome-shell/extensions/, reloading via Alt+F2 r — noting this reload trick works because you're on Wayland-with-nested-test-session; a full Wayland session restart is otherwise required — or via gnome-shell-test-tool if available).
Target GNOME Shell's official extensions.gnome.org review guidelines (no telemetry, no remote code execution, minimal permissions) in case the user wants to publish it later.


Deliverables


Full extension source (extension.js, prefs.js, metadata.json, GSettings schema, stylesheet.css, icons, lib/*.js metric modules).
Packaging instructions (gnome-extensions pack --extra-source=...).
A short manual test checklist covering: toggling pins, prefs window round-trip, behavior when a sensor is missing (e.g. a desktop with no battery), and cleanup on disable().



Utilization stats to implement

Tier 1 — core, almost everyone wants these pinnable to the top bar


CPU usage (overall %, from /proc/stat deltas)
Memory usage (used/total, %, from /proc/meminfo)
Battery level (%) and charging/discharging state
Battery time remaining (estimate, from UPower)
Disk usage (% full, per mounted volume)
Network throughput (upload/download, per active interface)


Tier 2 — detailed panel, valuable but noisier for the top bar


Per-core CPU usage (individual core %, small multi-bar or heatmap)
System load average (1/5/15 min, from /proc/loadavg)
Swap usage (used/total)
CPU package/core temperature
Fan speed (RPM, where exposed via hwmon)
Power draw (instantaneous watts, from RAPL/powercap where supported)
Battery health / cycle count / design vs. current capacity (UPower)
Disk I/O throughput (read/write MB/s, from /proc/diskstats)
Uptime / time since boot


Tier 3 — nice-to-have / hardware-dependent, best-effort with graceful fallback


GPU utilization % (NVIDIA via nvidia-smi, AMD via sysfs)
GPU memory usage (VRAM used/total)
GPU temperature
Per-process top consumers (top 3–5 CPU/memory hogs, click-through to full list)
CPU frequency (current vs. max, from /sys/devices/system/cpu/cpu*/cpufreq/)
Network packet error/drop counts
Battery wear level trend (historical capacity degradation, if you persist samples over time)
Ambient/system chassis temperature sensors (varies wildly by hardware)


Suggested top-bar defaults (before user customizes)

CPU % · Memory % · Battery % (with charging glyph) — a minimal, low-clutter starting set that covers the three things most people glance at most often, with everything else one click away in the dropdown.
