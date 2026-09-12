# PLAN.md — Audit remediation (branch `audit-fixes`)

Source: read-only audit of 2026-10-01. `docs/spec.md` is the original product spec; this file tracks milestones.

Target: GNOME Shell 50.1 / Wayland / Linux 7.0, unprivileged user. Verified hardware: Intel 12-thread, Iris Xe (i915), BAT1.
NVIDIA and AMD GPU paths cannot be executed on this machine and are never marked as passed.

## Milestones

| # | Milestone | Layer | Proof |
|---|-----------|-------|-------|
| M1 | Isolated bug fixes: thermal `r.lbl`, stale row refs after disable/enable, stale drag timer id, formatter `undefined` unit, pkexec exit status | UI | unit tests for formatters; headless shell run with log scan for JS errors |
| M2 | Poll guard (in-flight flag, generation token, min re-sample gap) + fixed-capacity ring buffers owned by the extension, sparklines only render | Engine / UI | ring buffer unit test; overlapping `_poll()` impossible by construction; headless run |
| M3 | Close file enumerators, prune network maps, async virtual-iface check, `cr.$dispose()` | HAL / UI | fd count before/after 30 rediscoveries stays flat |
| M4 | Per-process CPU from `/proc/[pid]/stat` deltas (monotonic Δt, PID-reuse safe, pruned map); power semantics (battery rate is system draw only while discharging); battery state map + proxy fallback; CPU identity; page size | HAL / Engine | parser unit tests (vanished PID, PID > 65535, non-ASCII / parenthesised comm); live run vs busy-loop worker |
| M5 | Sample only what is needed: detailed thermal/disk only on their tab, `/proc/cpuinfo` and `/proc/vmstat` only when shown; history gap reset | Engine | per-sampler timing before/after |
| M6 | Pure parsers + fixture tests (`tests/unit.js`), `dev.sh test-unit`, syntax check covers `lib/` and `ui/`, headless test scans the shell log | Tests | `./dev.sh test-unit` green |
| M7 | Move widgets/formatters/pkexec script out of `extension.js`; schema ranges; packaging and README corrections | All | headless run; `./dev.sh pack` succeeds |

## Edge cases to hold

- PIDs vanish between enumeration and read: skipped, never an error.
- PID reuse: delta keyed on pid + starttime.
- Counter wrap / first sample: rate 0, never negative.
- Offline CPU cores: holes filled with 0.
- `EACCES` on RAPL: metric reported unsupported, no crash.
- disable() during an in-flight poll: generation token drops the result.

## Decisions / deviations

- History is dropped on `disable()` (extension review rules require full teardown), so it does not survive screen lock.
- While the menu is open all cheap `/proc` and sysfs samplers keep running so history stays continuous; only expensive detail reads are gated by tab.
- `metadata.json` `shell-version` (45–50) conflicts with AGENTS.md (`["50"]`); left untouched, needs owner decision.
- Inline styles → CSS classes is not done in this pass (visual-regression risk without interactive review).

## State (2026-10-01)

All milestones landed on `audit-fixes`; working tree clean apart from the untracked `CLAUDE.md`.

| # | Commit | Proof that was run |
|---|--------|--------------------|
| M1 | a7771c1 | `test-ui` fails on the old code (`r.lbl is undefined`), passes after |
| M2 | 20d4d51 | `test-ui` asserts history length stays 3..12 and capacity 60 under overlapping on-demand polls |
| M3 | 6ed734a | gjs harness: 300 listings, fds 10 -> 312 before, 10 -> 10 after |
| M4 | 3c68a7f | `yes` worker reads 99.8-100.1 %; 14-16 ms per sample at 441 processes |
| M5 | fef2b97 | cpu sample 0.68 -> 0.27 ms, memory 0.33 -> 0.09 ms (mean of 200) |
| M6 | cf4fe18 | `./dev.sh test-unit`: 58 checks incl. 400-child churn run |
| M7 | see git log | `test-unit`, `test-ui`, `./dev.sh pack` (zip contains `ui/` and new `lib/` modules) |

Not executed, therefore not claimed:

- NVIDIA (`nvidia-smi`) and AMD GPU paths, AMD RAPL, multi-battery and no-battery machines.
- CPU / RSS of the real `gnome-shell` process with the extension loaded over hours (only per-sampler timings in a gjs harness were measured).
- Offline-core handling against a really offlined core (covered by a fixture only).
- Visual check of the dashboard in the user's live session; the headless run only proves there are no JS errors and that rows populate.

Still open:

- `metadata.json` `shell-version` vs AGENTS.md — owner decision.
- Inline styles -> CSS classes, and splitting the ~3500-line `extension.js` into per-tab modules (only widgets, formatters, ring buffer and samplers were moved out).
- `lib/thermal.js` detailed read (~55 ms) and `lib/gpu.js` were not optimised.

Resume / re-verify: `./dev.sh test-unit && ./dev.sh test-ui`.

---

# UI pass (approved 2026-10-02, branch `audit-fixes`)

Presentation-layer work in `extension.js`, `ui/widgets.js`, `stylesheet.css`; two collector touches (process grouping, interface filter). No new timers or polls.

Owner decisions: group processes **by name** (no extra reads); **full light-theme support** while dark keeps the colourful tinted cards; sparkline **hover readout** is in; **no pause function**.

| # | Milestone | Proof |
|---|-----------|-------|
| U1 | Disk "used" vs "busy" labelled consistently; unavailable metrics show "n/a" with reason instead of 0 / stale; process list cleared when stale | headless assertions on label text; unit test |
| U2 | Top bar: tabular figures + stable width per metric; battery icon follows level / charging | unit tests for width template and icon mapping; headless run |
| U3 | Power and network bars scale to a decaying observed peak (no fixed 45 W / 10 MB/s) | unit test of peak tracker |
| U4 | Show every non-virtual network interface | unit test with fixture names |
| U5 | Process list: memory in bytes; rows grouped by name | unit tests; live comparison with `ps`; sampler re-timed |
| U6 | Inline colours -> CSS classes, light variant following the shell colour scheme, dark keeps tinted cards | headless run in light and dark with log scan; **appearance needs owner's eyes** |
| U7 | Lazy detail pages; closing prefs does not reopen the menu; sparkline hover readout | open-to-render timing before/after; headless tab + disable/enable cycle |

Edge cases: pinned metric whose hardware is absent; colour-scheme switch while the menu is open; hover on an empty sparkline; grouped process whose members exit between samples.

## UI state (2026-10-02)

All UI milestones landed; working tree clean apart from the untracked `CLAUDE.md`.

| # | Proof that was run |
|---|--------------------|
| U1 | headless: disk card equals root usage, injected unreadable power / missing thermal read "n/a" with reason, stale process list dimmed |
| U2 | headless: every pinned label has the same preferred width for '9%', '100%', 'n/a'. First attempt (Clutter min-width) aborted the shell; the test caught it |
| U3, U4 | unit: peak tracker rise / decay / floor; interface filter fixture |
| U5 | unit: grouping; live: group totals vs `ps -eo comm,rss` (2199 vs 2212 MB); sampler 10-15 ms, unchanged |
| U6 | headless: sandboxed desktop switched to light and back, resolved text / background luminance and card tint asserted; screenshots of every tab in both variants inspected |
| U7 | enable() 26.7 -> 17.8 ms; headless disable/enable cycle; hover readout painted at in- and out-of-range positions, screenshot inspected |

`./dev.sh test-ui` saves screenshots of every tab (dark and light) to `<sandbox>/shots/`.

Not executed, therefore not claimed:

- The owner's live session: real pointer hover, card dragging in light mode, and the look on the real panel were only seen in headless screenshots.
- Top-bar label widths with a non-default panel font or fractional scaling.
- Light variant of the GPU page on NVIDIA / AMD hardware (brand badges keep their brand colours).

Known limits:

- Grouping is by the kernel's 15-byte `comm`, so helpers that rename themselves ("Isolated Web Co") form their own group; summed RSS is an upper bound.
- Brand badges and the power-fix status text keep fixed colours in both variants.

## Follow-up fixes (2026-10-02, from owner testing with `./dev.sh test`)

- **Cards not clickable.** Root cause: the card's generic `event` handler ran before `button-release-event` and cleared the click-candidate flag, so every quick click was discarded. The same handler exists on `master`; earlier headless runs missed it because they set `_activeTab` directly. Proof: the driver now clicks the panel button, four cards and the menu button with a virtual pointer (failed before the fix, passes after), on first open and after a disable/enable cycle.
- **Gap before the next top-bar metric.** Two causes: labels reserved room for rare maxima (`000.0W`, a battery time estimate that may be absent), and the reserved width was measured with a stale font, over-reserving every label. Now sized for common values, measured with the themed font, network speed uses a three-digit compact format. Proof: with all eight metrics pinned no label reserves more than 14 px beyond its text; screenshot inspected.

Not executed: the Mutter Devkit window (`./dev.sh test`) itself; the same code was driven in the headless shell.

## Tooling review (2026-10-03)

Fixed, each reproduced first: syntax check never parsed ES modules (`93e0576`); benchmark broke outside the repo root, hung forever on a dying worker, and judged 1-core CPU load against desktop background noise (`3d5064f`); test-headless was not isolated and ignored its log, sandboxes piled up, pack depended on cwd, status filtered the wrong string, ensure_installed deleted a real directory (`b7bae9c`).

Not run: the windowed `./dev.sh test` session (manual by design).

## Test coverage additions (2026-10-03)

- `./dev.sh test-overhead`: shell CPU with the extension off / on / open / CPU tab, three menu churn rounds, 10 min soak at 1 s interval with the menu open.
  Last run: closed +0.17%, overview +0.37%, CPU tab +2.60% of one core; churn 788/788/788 actors; soak fds 75 -> 75, actors and sparklines constant, RSS 264.5 -> 266.4 MB (slope 0.33 MB/min, budget 0.5).
  Open question: the RSS slope is under budget but not zero; 10 minutes cannot separate allocator warm-up from a slow leak. A 60 min soak (`./dev.sh test-overhead 3600`) would.
- Collector fixtures in `test-unit` (153 checks); benchmarks for process list, disk read, power/thermal response, battery vs upower.
- Found and fixed through the new checks: tabs did not fetch their detail data on open, and top-bar samples collapsed the open Thermal/Disk lists.

## Process list in-shell reads (2026-10-03, owner-approved AGENTS.md exception)

CPU tab overhead +2.60% -> +0.90% of one core (process sample 23 ms -> 4.5 ms CPU, longest main-loop block 2.4 ms). Menu closed +0.23%, overview +0.37%, churn 788/788/788.

---

# Second audit remediation (2026-10-11, branch `audit-fixes`)

Source: read-only audit of 2026-10-11 (owner said "yes, start fixing"). Same target and hardware as above; NVIDIA / AMD paths and machines without a package temperature sensor still cannot be executed here.

| # | Milestone | Layer | Proof |
|---|-----------|-------|-------|
| R1 | A collector that never answers must not freeze the others: per-poll deadline, no re-entry into a stuck collector, hung `nvidia-smi` killed | Engine / HAL | unit test: `sleep 30` child killed by the timeout; `test-ui`: one collector replaced by a promise that never settles, the rest keep updating |
| R2 | Icons that exist: bundled thermal icon, names present in Adwaita, no invented app icons | UI | `test-ui` walks every `St.Icon` in the panel and menu and fails on one the theme cannot resolve |
| R3 | In-menu steppers clamp to the schema range and show the stored value | UI | `test-ui` clicks `+` with the virtual pointer at 98 % |
| R4 | Power session average / peak computed once per sample, time-weighted, in the engine | Engine | unit test |
| R5 | Top bar and Thermal tab report the same sensor | HAL | unit test with a fixture that has no package / core sensor |
| R6 | Process CPU never averaged over a long gap: stale baseline is dropped, warm-up resampled after 0.5 s | HAL / Engine | unit test |
| R7 | Rates in decimal units matching their labels, no "1000.0 KB"; GPU tooltip omits what the GPU cannot report; exFAT / ntfs3 / f2fs mounts | Engine / UI | unit tests |
| R8 | Settings validated: schema `choices`, pinned list sanitised, unused key removed | UI | unit test of the sanitiser; `test-ui` with a bogus pinned key |
| R9 | No silently swallowed read errors: optional files read through one helper that logs anything other than "not there" once | HAL | unit test |
| R10 | Docs: AGENTS.md facts, spec moved to `docs/spec.md` (no case-colliding `plan.md`), README limits | Docs | review |

Not planned without an owner decision: `metadata.json` uuid and `shell-version`, a LICENSE file, what the top bar should do when it runs out of room, translations.

## State (2026-10-11)

R1–R10 are done and committed on `audit-fixes` (not merged, not pushed). Beyond the table: overview cards open with Return / Space, the in-menu temperature threshold follows the °C / °F setting, the undefined `rp-interactive` class is gone.

How each was checked:

- `./dev.sh test-unit`: 186 checks. New: subprocess timeout and cancel, `RunningStats`, `primarySensor` plus a no-package-sensor fixture read through `ThermalSampler`, stale process baseline, decimal units and rollover, `gpuTooltip`, exFAT / ntfs3 mounts, pinned-list sanitiser, schema choices, `noteReadError`.
- `./dev.sh test-ui`: icon walk under Yaru and Adwaita, stepper `+` clicked at 98 % with the virtual pointer, temperature threshold in °F, Return / Space on a focused card through a virtual keyboard, bogus pinned list, one collector that never answers.
- Run against the code before the fix and seen to fail on the intended assertion: icons, threshold unit, keyboard (on the missing focus highlight; the key press itself was not reached).
- Not shown failing on the old code: the stepper click (the old-code run stopped earlier, on the test's own missing button reference; the rejected 98 -> 103 write was observed by hand during the audit), the stuck collector, the bogus pinned list, and unit tests of functions that did not exist before.
- Commit `5d5dc6e` (keyboard) was split out of a tree that was UI-tested together with `3678985`; it was not UI-tested on its own.

Not executed on this machine, so not marked as passed:

- `nvidia-smi` timeout against a real hung `nvidia-smi` (the kill path is tested with `sleep 30`); every NVIDIA / AMD code path.
- A real machine without a package / core temperature sensor (covered by a fixture only).
- `noteReadError` on a machine where RAPL is root-only: expected to log one "Permission denied" line per RAPL file; here the files are readable and the log stays empty.

Audit findings still open:

- Owner decisions: `metadata.json` uuid (`resource-pulse@yourdomain.example`) and `shell-version` (45–50, AGENTS.md says `["50"]`), LICENSE, top bar with all eight metrics pinned at 1280 px (power still reads "13…."), translations, lint / CI (installed ESLint 6.4 cannot parse the code).
- GPU tab on Intel shows `--` for the values an integrated GPU cannot report; truncated settings rows and GPU model name.
- Dashboard widgets and tooltip strings are updated every poll while the menu is closed; thermal detailed sample 56 ms wall / 9 ms CPU. Both inside the 1 % budget.
- Only the first battery and the first GPU are shown; session figures reset on screen lock (documented in the README).
- Tests: nothing drives `prefs.js`, card drag, or window resize; memory parsing has no pure function to test; dead CSS (about 67 classes look unused, several are built dynamically) and 197 inline style strings are untouched.

To resume: `git switch audit-fixes`, then `./dev.sh test-unit && ./dev.sh test-ui`.
