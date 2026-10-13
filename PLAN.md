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

Overhead (`./dev.sh test-overhead`, standard 600 s soak): passed. Menu closed +0.70 %, overview +0.67 %, CPU tab +1.27 % of one core; soak RSS 263.4 -> 265.9 MB, slope 0.224 MB/min (budget 0.5), fds 75 -> 75, actors 788 -> 788.

- These CPU figures are higher than the 2026-10-03 ones (+0.23 / +0.37 / +0.90). An A/B run of `c4f204c` (before this branch) against HEAD, alternating, 45 s windows, two rounds each, shows the same level for both: menu closed old +0.44 / +0.60, new +0.49 / +0.60; overview old +0.87 / +1.07, new +0.82 / +0.89; CPU tab old +1.40 / +1.49, new +1.29 / +1.40. So this branch did not add cost; why the machine measures higher than a week ago was not investigated.
- A first run with a shortened 120 s soak failed on RSS slope (0.69 MB/min over six samples, RSS falling 267.1 -> 264.3 MB overall). The window is too short for the slope budget; the standard run is the one that counts.
- One churn round in the standard run counted 793 instead of 788 actors (network tab 46 -> 51); the check only fails on growth in every round. Not investigated.

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

---

# Owner decisions (2026-10-11, branch `audit-fixes`)

| # | Decision | Change | Proof |
|---|----------|--------|-------|
| D1 | MIT license | `LICENSE`, packed into the zip | zip listing |
| D2 | AGENTS.md removed | procfs exception restated in `lib/process.js` | review |
| D3 | UUID `resource-pulse@stefanamn.github.io` | metadata, `dev.sh`, drivers, README | `test-unit`, `test-ui` |
| D4 | Top bar never ellipsizes: when the pinned metrics do not fit, the last-pinned ones drop to icon-only (value in the tooltip) until everything fits | UI | `test-ui` on a narrow virtual monitor with all eight pinned: no ellipsized label, indicator inside the panel, labels return when room returns |
| D5 | Lint and CI | ESLint flat config (run through `npx`), GitHub Actions job: syntax, lint, unit tests | lint runs clean locally; the workflow itself can only be proven by a push |
| D6 | `shell-version` lists only versions the extension was actually run on | `./dev.sh test-compat`: unit tests and a headless enable in containers with other GNOME Shell versions | per-version result table; a version that cannot be run is not listed |

Translations: not wanted for now.

## State of the owner's decisions (2026-10-11)

D1–D6 are done and committed on `audit-fixes` (not merged, not pushed).

- D3: the local install was migrated without touching the running session: a second symlink `~/.local/share/gnome-shell/extensions/resource-pulse@stefanamn.github.io` and a second entry in `org.gnome.shell enabled-extensions`. The old symlink and entry (`resource-pulse@yourdomain.example`) are still there and should be removed after the next login.
- D4: proof as planned. The first version passed by timing only: the fit returned early while a relayout was pending (`has_allocation()`), seen as one failing run in three and fixed in `c9fe012`; three consecutive passes after it. The room is read from the panel's centre box; nothing was tested with a dock that shifts the work area, or in RTL.
- D5: lint clean; the workflow's steps were rehearsed in an `ubuntu:24.04` container (gjs 1.80.2, 186 checks). The workflow has not run on GitHub.
- D6: `./dev.sh test-compat` result with the final code:

  | GNOME Shell | image | unit | headless enable | UI test |
  |---|---|---|---|---|
  | 45.10 | Fedora 39 | pass with a `/proc` listing fallback that was not kept | pass | FAIL: the menu body does not render |
  | 46.10 | Fedora 40 | pass | pass | pass |
  | 47.10 | Fedora 41 | pass | pass | pass |
  | 48.8 | Fedora 42 | pass | pass | pass |
  | 49.10 | Fedora 43 | pass | pass | pass |
  | 50.1 | this machine | pass | pass | pass |

  `shell-version` is therefore 46–50. What the containers do not show: real GPUs (software rendering), Ubuntu's or other distributions' builds of these versions, and behaviour over days of use. The legacy cursor path (45–49) is only checked for not throwing; the cursor shape itself was not looked at. The matrix was run before the unused GNOME 45 `/proc` fallback was dropped again; that code is not reached on 46+.
- Intermediate commits `c9fe012` and `7b00a39` were split out of one tested tree and not tested on their own.

Still open from the audit: GPU tab `--` values on Intel, truncated settings rows, widgets updated while the menu is closed, first battery / GPU only, no tests for `prefs.js`, drag or resize, dead CSS and inline styles. Translations are not wanted for now.

---

# Settings page redesign (2026-10-12, branch `settings-redesign`) — approved by the owner 2026-10-12

Owner's request: the in-menu settings page feels overcrowded and is hard to read because its rows and controls vary in size. The plan below is as approved; what was built, and where it deviates, is under "State" at the end of this section.

## What is wrong today (dark-settings screenshot, 380 px panel)

- Rows are 36 px or 43 px high depending on whether they have a description.
- Five control shapes and many widths: square stepper buttons, an `ON`/`OFF` pill (46 px), `°C`/`°F` (two 36 px pills), `% Only`/`% + Time` (~140 px), three network pills (~190 px). Their left edges are ragged and they squeeze the labels: "Network Top Bar…" and "Frequency of data sampling (1 to 10 s…" are ellipsized.
- The pinned grid is eight pills that touch each other; with everything pinned it is one blue block, and state is shown by colour alone.
- Five boxed cards with blue upper-case titles, each with 14 px padding inside the page's 16 px: rows get about 310 of 380 px, and the page is roughly two panel heights long.
- Three small text sizes (0.75 / 0.78 / 0.85 em).
- Settings and one-off actions are mixed: the RAPL fix carries a three-line warning permanently, even on machines where power already works.
- The top bar now hides labels in reverse pinned order, but nothing shows what that order is.
- The preferences window (`prefs.js`) repeats the same settings with different labels and step sizes (thresholds step 1 there, 5 here).

## Design

One row template, one control column, fewer boxes.

- **Row**: fixed height (44 px), title on the left on one line, control in a fixed-width column on the right (132 px), so every control starts and ends at the same x. A description line only where it says something the title does not; titles shortened so none can be ellipsized at the minimum panel width.
- **Three controls, one height (28 px) and one corner radius**:
  switch (the shell's own `PopupMenu.Switch`) for on/off; segmented control with equal-width segments filling the column for 2–3 choices; stepper `−  value  +` filling the column for numbers.
- **Sections instead of cards**: a dim section heading and a thin separator, no nested boxes.
  1. *Top bar*: pinned metrics, compact mode, tooltips, battery format, network format.
  2. *Units and refresh*: update interval, temperature unit, memory unit.
  3. *Alerts*: CPU, memory, temperature thresholds.
  4. *Panel*: reset size; "Enable CPU power monitoring" only when power is in fact unreadable, with its warning shown when the row is activated, not permanently.
- **Pinned metrics**: a 2 × 4 grid of equal tiles with 8 px gaps, icon + name; a pinned tile shows its position (1, 2, 3…) so the collapse order of the top bar is visible. Reordering by drag is not in this plan.
- **Type and colour**: two sizes (row title, secondary). Accent colour only for the selected state.
- **One description of the settings** (`lib/settingsmodel.js`: key, title, kind, choices or range and step) used to build this page, so labels, order and step sizes have one source. `prefs.js` can be built from it later (S5).

Sketch (380 px):

```
 ‹  Settings
 TOP BAR
 [▣ CPU      1] [▣ Memory   2]
 [▣ Battery  3] [▣ Power     ]
 [▣ Disk      ] [▣ Network   ]
 [▣ Thermal   ] [▣ GPU       ]
 Compact (icons only)              ( ●)
 Tooltips                          (● )
 Battery shows            [  %  | % + time ]
 Network shows            [ ↓ | ↑ | ↓↑ ]
 ─────────────────────────────────────────
 UNITS AND REFRESH
 Update every             [ −   2 s   + ]
 Temperature              [  °C  |  °F  ]
 Memory                   [  GB  | GiB  ]
 ─────────────────────────────────────────
 ALERTS  · values above these turn red
 CPU                      [ −   90%   + ]
 Memory                   [ −   90%   + ]
 Temperature              [ −   80°C  + ]
 ─────────────────────────────────────────
 PANEL
 Size  420 × 560                 [ Reset ]
```

Expected length: about 850 px instead of about 1150 px (1.5 panel heights instead of 2).

## Milestones

| # | Milestone | Layer | Proof |
|---|-----------|-------|-------|
| S0 | Baseline: full-page screenshots of the current settings page (dark, light), kept for comparison | Test | files in the sandbox, shown to the owner next to the result |
| S1 | `lib/settingsmodel.js`: pure list of settings (key, title, kind, choices / range / step) checked against the schema | Engine | unit test: every key exists in the schema, every choice is accepted by it, ranges equal the schema's |
| S2 | Row template and the three controls as widgets in `ui/`, styled by CSS classes (no inline styles on this page) | UI | `test-ui`: each control changes its GSettings key when clicked with the virtual pointer, and follows the key when it changes elsewhere |
| S3 | Page rebuilt from the model: sections, pin tiles with order numbers, conditional power row | UI | `test-ui`: all rows have the same height; all controls share left and right edges (allocation boxes); no label on the page is ellipsized at the default and at the minimum panel width; page height at most 900 px; dark and light screenshots |
| S4 | Keyboard: Tab reaches every control, Left / Right change a segmented control or stepper, Space toggles a switch | UI | `test-ui` with the virtual keyboard |
| S5 | Optional: `prefs.js` built from the same model | UI | not automatable today (nothing drives `prefs.js`); manual check, stated as such |
| S6 | Optional, main panel: see below | UI | per item |

All of S2–S4 also run through `./dev.sh test-compat` (46–49). Overhead: the page is built on first open and does no polling, so the sampling cost is unchanged; `test-overhead` is rerun once at the end.

## Main panel (optional, S6)

Seen in the same screenshots, smaller than the settings problem:

- Overview cards are 102–115 px high depending on content; give all eight one template (title, value, one detail line, bar) so the grid is even.
- The reorder grip is drawn on every card all the time; show it on hover or keyboard focus only.
- GPU tab on Intel shows `--` for five of six values; hide rows and header fields the GPU does not report.
- Detail-page titles name units inconsistently ("CPU Usage", "Charge Level History (%)", "GPU Utilization (%)").

## Edge cases to hold

- Minimum panel width and the widest translation-free labels ("Temperature", "% + time") must fit without ellipsis.
- A setting changed from the preferences window while the page is open must update the control.
- `threshold-*` values that are not a multiple of the step (set from preferences) still clamp to the schema range.
- No battery / no RAPL / no GPU: rows that do not apply are hidden, not disabled with a placeholder.

## Owner's decisions (2026-10-12)

1. Every setting stays in the menu.
2. S5 (preferences window from the same model): yes.
3. S6 (main panel): first answer was "CPU, Memory, Power, Thermal", which did not map onto the four items; asked again, and the owner chose the even card grid and hiding empty GPU rows (2026-10-12). The grip on hover and the chart titles were not chosen and are untouched.

## State (2026-10-12)

Done and committed on `settings-redesign` (not pushed):

| # | Result | Proof that was run |
|---|--------|--------------------|
| S0 | Baseline screenshots taken before any change (`test(ui): screenshot the whole settings page`) | compared by eye with the result |
| S1 | `lib/settingsmodel.js` | unit: key types, accepted choices, ranges and steps against the schema; 216 unit checks pass |
| S2 | `ui/settings.js`: `SettingRow`, `SwitchButton`, `SegmentedControl`, `Stepper`, `ActionButton`, `PinTile`, `Note`; CSS classes `rp-set-*`, no inline style on the page | `test-ui`, real pointer: pin tile, switch (knob position checked), segment, stepper (button goes insensitive at the limit), Reset; a change made behind the page's back is followed |
| S3 | Page rebuilt: 4 sections, 11 rows (12 with the power row) | `test-ui`: rows all 40 px, controls all 28 px, one control column (148 px), 8 equal tiles 8 px apart, no ellipsized label among > 40 at 380 px and at the 360 px minimum, page 821 px (861 px with the power row) instead of about 1150 px |
| S4 | Keyboard | `test-ui`, real key events: Down / Tab enter the panel from the top-bar button, Tab reaches all 29 controls, focused control scrolls into view, Space / Return on a switch, Left / Right on a choice and on a stepper, Backspace goes back and Return on the menu button opens the page with the focus following, Escape closes the menu |
| S5 | `ui/prefsrows.js`, `prefs.js` reduced to the header button | `tests/ui-driver/prefs-check.js`: 65 checks on real GTK rows over a memory-backed schema, run by the driver as a client of the sandboxed shell; the real window is opened and screenshotted (its content is checked by eye only) |

Deviations from the plan above, and things found on the way:

- Rows are 40 px, not 44 px, and the control column 148 px, not 132 px ("% + time" did not fit two equal segments of 66 px).
- The switch is drawn by the extension (`SwitchButton`), not `PopupMenu.Switch`: the shell's switch takes the system accent (orange on Ubuntu) next to this page's blue controls, and brings glyphs the icon check cannot resolve.
- `lib/power.js` now reports `raplBlocked` (counters exist, reading denied) and has `forgetProbe()`; the power row needs the first, and the second makes the fix show at once instead of after the 60 s probe cache. Unit-tested against a fixture directory.
- Found: the scroll offset carried over from one page to the next (`fix(ui): open every page at its top`).
- Found: keyboard focus could not get into the panel at all. The menu item and the page container were focusable themselves and St does not navigate inside a focusable widget; the stacking container was a bare `Clutter.Actor`. Two attempts at the Tab test failed before the cause was looked for with a focus trace instead of guessed (`fix(ui): let keyboard focus into the panel`). This also makes the overview cards reachable, which the earlier "cards open with Return / Space" check had only proved for a card that was given focus by the test.
- Found: hiding the page that held the focus dropped the focus out of the panel (`fix(ui): keep the keyboard focus when the page changes`).
- Found: the panel's own Escape handler never runs, because the shell's menu grab takes Escape first and closes the menu. Left as the shell has it; Backspace is the back key. The README said Escape goes back and was corrected.
- The old settings CSS (`resource-pulse-settings-*`, `-setting-*`, `-toggle-btn`, `-stepper-btn`, `-action-btn`, `-status-label`) is removed.

Whole-project checks on the final code (2026-10-12):

- Lint clean; 216 unit checks pass; `./dev.sh test-ui` passes on GNOME 50 (host).
- `./dev.sh test-overhead` (600 s soak): menu closed +0.37 % of one core (budget 1 %), overview +0.87 %, CPU tab +2.00 % (budget 5 %); soak RSS 274.8 -> 267.5 MB with a steady-state slope of 0.353 MB/min; fds 75 -> 75; menu actors 789 -> 789 over three churn rounds. The run before the redesign measured +0.70 % / +0.67 % / +1.27 % and 0.224 MB/min; the settings page does no sampling, but the test was run once, so how much of the difference is run-to-run spread was not measured.
- `./dev.sh test-compat`: GNOME Shell 46.10, 47.10, 48.8 and 49.10 pass unit, headless and UI tests in containers (the UI test includes the settings layout, pointer, keyboard and preferences checks). 45 is not listed and was not run.

Not executed:

- The second click of the power row (it starts `pkexec`); the first click, the warning and the row's appearing and disappearing are tested with a stubbed reading.
- A machine whose energy counters really are blocked (this one has the fix applied); the collector's side is covered by the fixture test only.
- Preferences window content beyond the 65 row checks: no pointer drives the real window.

## S6: main panel (2026-10-12, branch `main-panel-s6`)

Reproduced first: the new checks failed on the old code with cards of 116 px (CPU, Memory: graph), 104 px (Battery, Disk, Power, GPU: detail line) and 107 px (Network / Thermal row), and the GPU page on this Intel machine showed five `--` values.

| Item | Result | Proof that was run |
|------|--------|--------------------|
| Even card grid | `_buildMetricCard()` builds all eight cards: name, value, a slot of fixed height (`CARD_SLOT_HEIGHT`, 22 px: trend graph or one detail line) and a bar. Replaces four near-copies. | `test-ui`, dark, light and after re-enable: 8 visible cards, all 170 x 112 px, bar 95 px from the top of each |
| GPU rows | `gpuReadings()` in `lib/present.js` returns null for a reading the GPU does not report; the page hides that field or row, the header's stat line when it is empty, and all reading cards when there is no GPU | unit: 4 cases (integrated, full, partial, absent; a stopped fan is `0 RPM`, not hidden). `test-ui`: three readings fed through the real poll (everything / load only / no GPU), row visibility checked and no `--` label mapped in any of them; plus the machine's own Intel reading |

Side effects to know:

- The CPU and Memory trend graphs on the overview are 22 px high instead of 30 px; the four card rows together are 448 px instead of 431 px, so the hardware card below starts 17 px lower.
- The Thermal card has no detail line (it only has one when no sensor is found), so its slot is empty.

Not executed: a real NVIDIA or AMD GPU (the full reading is a stub fed to the poll); dragging a card to reorder it (no test drives the drag; the card's drag wiring is unchanged and clicks on cards pass).

Whole-project checks on the final code (2026-10-12):

- Lint clean; 220 unit checks pass; `./dev.sh test-ui` passes on GNOME 50 (host).
- `./dev.sh test-compat`: GNOME Shell 46.10, 47.10, 48.8 and 49.10 pass unit, headless and UI tests in containers.
- `./dev.sh test-overhead` (600 s soak, one run): menu closed +0.20 % of one core (budget 1 %), overview +0.37 %, CPU tab +1.20 % (budget 5 %); soak RSS 266.4 -> 262.9 MB, steady-state slope 0.118 MB/min; fds 75 -> 75; menu actors 797 -> 797 (8 more than before: one slot per card). The baseline of this run was 0.60 % against 0.97 % in the previous one, so the two runs were made on a differently loaded machine and their differences are not attributed to the code.

Follow-up the owner asked for (2026-10-12): the GPU model name wraps onto a second line instead of ending in an ellipsis. The check written for it (no ellipsized label on the GPU page) failed first on the old code for "Intel Alder Lake-UP3 GT2 [Iris Xe Graphics]", and then also caught the no-GPU notice being cut off, which wraps now too (`fix(gpu): wrap the model name and the no-GPU notice instead of cutting them off`). Run after it: lint, 220 unit checks, `test-ui` on GNOME 50, `test-compat` on 46.10 / 47.10 / 48.8 / 49.10, all passing. The overhead test was not rerun for this change (two label properties set once when the page is built).

---

# Battery report, diagnostics and a details window (2026-10-14, branch `battery-report`) — approved by the owner 2026-10-14

Owner's request: track which apps use the battery, give a report of the biggest consumers and a diagnostic that helps the machine last longer; consider a separate window for in-depth settings and statistics instead of crowding the panel. No code has been changed for this section.

## What this machine gives an unprivileged extension (checked 2026-10-14, kernel 7.0, GNOME 50)

- **Per-app CPU time, without polling processes.** GNOME starts every app in its own systemd scope (`app-gnome-<desktop id>-<pid>.scope`, `app-flatpak-…`, `snap.…`), and `cpu.stat` (`usage_usec`) of each scope is readable by the user. It counts every process the app ever ran, including short-lived ones, so nothing is lost between samples. The root cgroup and `system.slice` are readable too, so system services and the kernel can be shown as their own lines. Terminals split their windows into further scopes (`kitty-21009-1.scope`, `vte-spawn-…`).
- **Energy.** RAPL `package-0`, `core` and `uncore` (integrated GPU) are readable here (after the earlier fix); on battery the discharge rate comes from UPower. Display, Wi-Fi and the rest of the platform cannot be measured per app by anything on Linux.
- **Per-app GPU time.** `/proc/<pid>/fdinfo` of a DRM file gives `drm-engine-render` nanoseconds (i915 here), for the user's own processes.
- **For the diagnostic.** Backlight level (`/sys/class/backlight`, here at 100 %), power profile (power-profiles-daemon over D-Bus, here "balanced"), battery health (here 38.99 of 45 Wh design, 87 %, 204 cycles), UPower `EnableChargeThreshold` (present; this battery has no `charge_control_end_threshold`, so it is not supported here), focused app (`Shell.WindowTracker`).

## Answer to "a separate window?"

Yes. The panel should keep a one-line summary at most; ranked lists, history and advice need a real window.

Recommended way to get it: grow the preferences window the extension already has into a multi-page window (Settings, Battery, Diagnostics), opened from a new icon in the panel's overview header. It ships in the same zip, is allowed on extensions.gnome.org, reuses `ui/prefsrows.js` and the `prefs-check.js` test rig, and runs in its own GTK process, so a heavy page never touches the shell.

The alternative, a separate GJS application with its own app id and launcher icon, gives the window its own identity in the dash, but must install a `.desktop` file outside the extension's directory, needs its own single-instance and lifecycle code, and is not something extensions.gnome.org accepts as part of an extension. Not recommended unless the dash identity matters.

Either way the data is collected by the extension inside the shell (the window only exists while it is open) and written to a file the window reads.

## How consumption is attributed (an estimate, and labelled as one)

Every 30 s, independent of the panel's own refresh, and also while the menu is closed:

1. Read `usage_usec` of each app scope, of `system.slice` and of the root cgroup; read RAPL package (and uncore) energy; read battery energy, rate and AC state; note the focused app (signal, not polled) and the backlight level.
2. CPU energy of an app over the interval = (package energy − idle baseline) × app CPU time / total CPU time. The idle baseline is a low percentile of the package power seen on this machine and is reported as "idle and platform", not given to any app.
3. Each app's share is split into foreground (it had focus) and background.
4. On battery, everything the battery delivered that is not attributed to an app is shown as "display, radios and the rest", so the list never pretends to explain 100 %.
5. Without readable RAPL the report shows CPU time shares only (no watts) and offers the existing permission fix.

Stored as hourly buckets: for each hour, AC or battery, battery energy used, and per app CPU time, attributed energy and foreground share. Fixed capacity: 14 days × 24 hours, at most 30 apps per hour plus "other". One file in `~/.local/share/resource-pulse/`, written when an hour closes and when the extension is disabled (screen lock), so about 25 writes a day. Local only; a switch to stop tracking and a button to clear the history.

GNOME disables extensions while the screen is locked, so nothing is attributed then; the battery energy used meanwhile is shown as "while locked". Suspend is detected (boot-time clock against monotonic clock) and its interval is not attributed.

## The window

- **Settings**: the current preferences rows, unchanged.
- **Battery**: range (today, 24 h, 7 days, 14 days) and "on battery only". Summary (battery used in Wh and % of capacity, average drain, estimated runtime at that drain, share attributed to apps). Ranked list of apps with icon and name (from the desktop id), energy, share, foreground / background split and CPU time. Later: a drain-over-time chart stacked by the top apps.
- **Diagnostics**: findings, each with its evidence and, where it can be estimated, its effect ("about 0.9 W, roughly 35 min on a full charge"). Only findings backed by data are shown:
  - an app that used a large share in the background over the last hours;
  - a high backlight level on battery (the display is often the largest consumer, but it cannot be measured here, and the finding says so);
  - the "performance" power profile on battery, with a button to switch (power-profiles-daemon allows this without a password);
  - battery health: capacity against design and cycle count; where the battery supports a charge limit, advice to turn it on (in GNOME Settings, or `EnableChargeThreshold`);
  - long periods of high CPU temperature on battery;
  - power readings not available, pointing to the fix.
- **Panel**: a "details" icon in the overview header opens the window; the battery page in the panel gets one line, "Top app on battery today: X (n %)", that opens the Battery page.

## Milestones

| # | Milestone | Layer | Proof |
|---|-----------|-------|-------|
| B1 | `lib/appusage.js`: read scope CPU counters; turn scope names into an app id and a label (GNOME, flatpak, snap, escaped `\x2d`, terminal sub-scopes, services) | HAL | unit: name parser on real names from this machine; fixture cgroup tree (scopes appearing, vanishing, unreadable) |
| B2 | `lib/batteryledger.js`: attribution, idle baseline, foreground split, hourly buckets with fixed capacity, file format with version, recovery from a damaged file (kept aside and reported, never silently dropped) | Engine | unit: synthetic counters with known answers; rollover; caps; suspend gap; write / read round trip |
| B3 | Tracker in the extension: 30 s timer, focus signal, lock and suspend gaps, `battery-tracking` setting | Engine / UI | `test-ui`: a CPU burner started as `systemd-run --user --scope -u app-test-burner-1.scope` ranks first with about its true share; churn of short-lived scopes; `test-overhead` with tracking on against off |
| B4 | The window: Settings, Battery and Diagnostics pages; header icon in the panel; panel battery line | UI | `prefs-check.js` extended: pages built from a fixture history; driver: real click on the icon opens the window; screenshots light / dark |
| B5 | `lib/diagnostics.js`: the rules as pure functions over a ledger summary plus system state; power-profile action | Engine / UI | unit: each rule fires on its evidence and stays silent without it; the action is tested where power-profiles-daemon runs (not in the containers; stated) |
| B6 | Optional: per-app GPU time from `drm-engine-render`, uncore energy split by it | HAL | unit with fixture fdinfo; real reading on this Intel machine |
| B7 | Docs, compat 46–49, overhead soak | All | as before |

Overhead budget: the tracker reads about 100 small files every 30 s (expected well under 0.05 % of a core); the window does its work in its own process. Measured, not assumed, in B3.

## Not possible or not planned

- Per-app display, Wi-Fi or disk power: Linux has no source for it; it stays in "the rest".
- Exact per-app watts: an estimate from CPU (and later GPU) time.
- Tracking while the screen is locked (GNOME disables extensions then).
- Changing system settings that need a password (charge limits, kernel tunables): advice only.

## Owner's decisions (2026-10-14)

1. Grow the preferences window.
2. Tracking is off by default; the window has a tab dedicated to tracking (switch, history, report).
3. 14 days of history.
4. Both: runtime per charge and battery lifespan.
5. B6 (GPU per app) after B1–B5 and B7 are done.

## Decisions as first asked

1. The window: grow the preferences window (recommended) or build a separate app.
2. Tracking: off until the user starts it on the Battery page (recommended, since it records which apps were used and when) or on by default.
3. History: 14 days (recommended) or 30.
4. "Last longer": longer runtime per charge, longer battery lifespan, or both (recommended: both; the diagnostic list above covers both).
5. B6 (GPU per app): now or later (recommended: later).

## State (2026-10-14)

Done on `battery-report` (not pushed):

| # | Result | Proof that was run |
|---|--------|--------------------|
| B1 | `lib/appusage.js`: per-unit CPU time from the session's cgroups, units named (GNOME / flatpak / plain app scopes, terminal window scopes, snaps, services) | unit: real unit names from this machine, fixture cgroup tree (nested slices, socket, unreadable counter, no tree); live: 64 units in about 15 ms |
| B2 | `lib/batteryledger.js`: attribution (package energy above a learnt idle baseline, by CPU time), focus split, gaps, hourly buckets, 14 days, 30 apps per closed hour, atomic file, damaged file moved aside | unit: hand-computed shares, baseline, churn, gaps, AC / battery, caps, retention, file round trip |
| B3 | `lib/batterytracker.js` in the extension; keys `battery-tracking` (off by default), `action-flush-history`, `action-clear-history`; time above the temperature alert recorded | unit with stand-in samplers; `test-ui`: a burner started as its own app scope by the user's systemd gets 6.01 s of CPU for about 6 s and ranks first, flush and clear work, switching off stops it; `test-overhead`: 10 ms CPU per sample (+0.033 % of a core), tracking on through churn and soak (RSS slope -0.07 MB/min, fds flat) |
| B4 | Preferences window with Settings, Tracking and Diagnostics tabs (`ui/prefsbattery.js`, `ui/prefsdiagnostics.js`, `lib/systemstate.js`, `lib/appnames.js`); overview header button and the battery page's "top app today" line open it (`prefs-page` key) | `prefs-check.js`: both tabs on a fixture history with stubbed state (85 checks: ranking, summary, period and battery-only switches, file following, findings and their actions); driver: real clicks on the button and the battery line open the window, the menu closes, the window takes the requested tab; screenshots |
| B5 | `lib/diagnostics.js`: background apps, power mode, brightness, heat, wear, charge limit, mostly plugged in, missing power readings | unit, rule by rule, including silence without evidence |
| B6 | `lib/gpuusage.js` (GPU busy time per unit from DRM fdinfo), uncore power in `lib/power.js`, graphics share in the ledger and the Tracking tab | unit: fdinfo parsing, fixture /proc (dup'd, shared, non-GPU fds), the graphics split by hand; live: 4 units hold GPU clients, about 10 ms wall time per sample after the first scan |
| B7 | README, this plan; compat and overhead below | |

Corrections to the plan's findings: this battery does support a charge limit through UPower (`ChargeThresholdSupported` true, `ChargeThresholdEnabled` false), although sysfs has no `charge_control_end_threshold`; the diagnostic therefore advises turning on "Preserve Battery Health" here. The power-mode finding has a one-click switch; the charge limit opens Power settings (setting it needs authorisation).

Not executed or not verifiable here:

- A real NVIDIA or AMD GPU (fdinfo format follows the kernel's documented drm-usage-stats; only i915 was read live).
- A machine whose energy counters are blocked (only fixtures).
- The containers have no systemd user session, so the burner part of the tracking test is skipped there by design; passing container runs do not keep their logs, so this was not confirmed from a log.
- The power-mode switch against a real power-profiles-daemon (the action is tested with a stub; the D-Bus write path was not run, to leave this machine's setting alone).
- Tracking over days, across real screen locks and suspends (gaps are unit-tested).

Whole-project checks on the final code (2026-10-14):

- Lint clean; 297 unit checks pass; `./dev.sh test-ui` passes on GNOME 50 (host), including the 85 GTK checks of `prefs-check.js`.
- `./dev.sh test-compat`: 46.10 and 47.10 pass; 48 and 49 first failed to build their images (the Fedora registry could not be reached), and passed when rerun alone: unit, headless and UI tests on all four.
- `./dev.sh test-overhead` (600 s soak, one run, GPU time included): menu closed +0.47 % of one core, tracking 28 ms CPU per sample (+0.093 %), together +0.56 % (budget 1 %); overview +0.77 %, CPU tab +1.07 % (budget 5 %); soak RSS 283.6 -> 282.1 MB, slope 0.195 MB/min; fds 75 -> 75. The churn rounds counted 808, 808, 813 actors: the network tab grew from 46 to 51 actors in the third round (an interface appearing on the host, within the test's tolerance); not investigated further.

---

# One settings window in the extension's look (2026-10-14, branch `details-window`) — approved by the owner 2026-10-14

Owner's decisions: all settings live in the details (preferences) window only; the window takes the panel's look with the extension's blue accent instead of the system accent.

| # | Milestone | Layer | Proof |
|---|-----------|-------|-------|
| W1 | Panel settings page removed; ⋮ (overview and detail pages) opens the window on Settings; the separate details button goes (⋮ does its job); "Panel size → Reset" moves into the window and the extension follows `menu-custom-width/height` when they change elsewhere; the panel power-fix row goes (the window's Troubleshooting has it) | UI | `test-ui`: a real click on ⋮ opens the window on the Settings tab; Reset in the window (GTK check) clears the size and the panel follows; no settings-page code left |
| W2 | Window stylesheet (`prefs.css`, loaded by prefs.js for this window only): panel surfaces, metric tints, blue accent for GNOME 46 (named colours) and 47+ (CSS variables), dark and light | UI | screenshots dark / light next to the panel on 50; `test-compat` 46–49 screenshots not kept, so 46 is checked by its CSS parsing without warnings in the GTK client |
| W3 | Tracking tab: summary as stat tiles, apps with tinted bars, battery drain chart (Gtk.DrawingArea, Cairo) | UI | `prefs-check.js` on the fixture: tiles show the summary values, chart has the hourly points; screenshots |
| W4 | Diagnostics and Settings tabs restyled (cards, severity tints) | UI | screenshots; existing checks unchanged |

Panel tests that drove the in-panel settings page (layout, pointer, keyboard, power row, stepper clamp, threshold unit) are retired with the page; what they protected now lives in the GTK checks of the window (rows write and follow settings, ranges and steps match the schema).

## State (2026-10-14)

Done on `details-window` (not pushed):

| # | Result | Proof that was run |
|---|--------|--------------------|
| W1 | Panel settings page, `ui/settings.js` and its styles removed; ⋮ (overview and detail pages) opens the window on Settings; the separate details button dropped; Panel › Size with Reset in the window; the panel follows size changes made elsewhere | `test-ui`: real click on ⋮ opens the window and it takes the Settings tab; the panel follows a stored size and a reset; keyboard (Down / Tab in, Return on a card, Backspace back with focus kept, Escape closes); GTK check of Reset |
| W2 | `ui/prefsstyle.js`: the panel's surfaces and tints, blue accent; variables on `window.rp-window` (libadwaita ≥ 1.6), named colours removed on close (1.5); follows dark / light | GTK check: the stylesheet parses without errors for the running libadwaita, dark and light; on GNOME 46 (libadwaita 1.5) this ran in its container and passed; screenshots light and dark on 50 |
| W3 | Tracking: stat tiles, battery-use chart (per hour or per day, processor part inside), tinted bars | GTK checks: tile values, chart bars add up to the battery used, chart hidden in the AC-and-battery view; screenshots |
| W4 | Settings: tinted metric icons on the pinned rows (icon names moved to `lib/settingsmodel.js`); Diagnostics: tinted severity icons; header mark | GTK check: every pinned row has its icon; screenshots |

Found on the way: the tracking test ranked the burner by CPU over the whole hour, so an IDE in use on the test machine could out-rank it; it now compares the CPU gained while the burner ran (separate commit).

Deviation: the header shows the extension's mark only; with the name as well the tab switcher was cut off ("Diagno…").

Checks on the final code: lint clean; 297 unit checks; `test-ui` on 50 (94 GTK checks of the window); `test-compat` 46.10, 47.10, 48.8, 49.10 pass. `test-overhead` was not rerun: sampling is unchanged and the panel lost a page rather than gained work.

### W5 (2026-10-15): the whole window in the panel's blue

Owner's correction: the first pass only styled the new widgets; the window itself stayed the neutral grey of the system theme. Now the entire window takes the panel's CPU-card look: navy background and header (pale blue in light), every list card and tile in the CPU card's surface with its thin blue border, blue-tinted buttons, a blue selected tab, blue hover on rows and in popovers.

Proof: lint clean; GTK check that the stylesheet parses (dark and light) in the running libadwaita; `test-ui` on 50, now screenshotting Settings, Tracking and Diagnostics top to bottom in light and dark; `test-compat` 46–49 for the named-colour path.

### W6 (2026-10-15): the look holds under a third-party GTK theme

Owner's report: on their machine the window was still the system's (Orchis-Pink): white surfaces, pink switches and tab. Root cause: Orchis installs itself as the user stylesheet (`~/.config/gtk-4.0/gtk.css`), which GTK ranks above every application stylesheet (priority 800 against 600), and it sets its own accent on `:root` and hard-codes light surfaces and dark text on rows, labels and buttons. The test sandbox has its own config directory, so no user theme was ever loaded there and the tests could not see it.

Fix: the window's stylesheet is added at user priority + 1 (still scoped to `window.rp-window`), and it states the colours a theme may hard-code: text, subtitles, header, view-switcher buttons, rows, buttons (flat, suggested, destructive), switches, checks, entries, popovers.

Proof: `test-ui` now installs `tests/ui-driver/hostile-gtk.css`, a stand-in modelled on Orchis, as the sandbox user stylesheet, and prefs-check renders the window and reads back its pixels in dark and light: window background, header, card, a checked switch (the extension's blue), and row text (light on dark, dark on light). Before the fix this failed with exactly the owner's colours (white card, `rgb(236, 64, 122)` switch, black text on dark); after it passes. Also run once with the owner's real Orchis stylesheet (`RP_GTK_USER_CSS=…`): passes, screenshots navy/blue. Orchis still shapes the switches (a thin track); their colours are the extension's.

## Alerts, load, process actions, longer history (branch `alerts-and-history`, 2026-10-15)

Owner's request: implement the suggested features; add a danger symbol in the top bar when a metric is close to 100 %. Owner's decisions: one ⚠ at the start of the indicator (tooltip names the metric) plus the pinned metric's value in red; watch every metric even when unpinned; End on a grouped process row ends the whole group (the user's own processes).

Data flow: alerts read the poll's snapshot (Aggregator); new collectors are HAL modules returning raw numbers; the panel and notifications only consume snapshots. Steady-state budget with the menu closed stays under 1 % CPU (measured with `test-overhead` after A, D and F).

| # | Milestone | Layer | Edge cases | Proof |
|---|-----------|-------|------------|-------|
| A | `lib/alerts.js`: per-metric state with sustain (30 s above the threshold) and recovery (5 points below for 10 s), monotonic time; inputs CPU, memory, temperature, GPU, disk space (new `threshold-disk`, `threshold-gpu`), memory pressure. Danger ⚠ in the top bar (tooltip lists the metrics), pinned value in red; GNOME notification with the cause (top process for CPU / memory), at most one per metric per 10 min; `alert-notify` switch in Settings. Unpinned CPU / memory / temperature sampled every interval, disk space every 60 s, GPU every 30 s | Engine + UI | metric unavailable (n/a never alerts), threshold changed while active, clock jumps (monotonic only), disable() while a notification is pending | unit tests with a fake clock; test-ui: a CPU burner raises ⚠ and a notification, both clear after; overhead |
| B | `lib/pressure.js`: PSI avg10 for cpu / memory / io; on the CPU, Memory and Disk pages; memory `full` above 10 % feeds alerts | HAL + UI | kernel without PSI (ENOENT → n/a with reason, logged once) | unit parse tests on fixtures; test-ui reads the rows |
| C | End on top-process rows: confirm inline, SIGTERM to every pid of the group owned by the user whose start time still matches, Force quit offered after 5 s; EPERM / ESRCH reported, not hidden | UI + HAL | PID reuse, process exits between list and signal, other users' processes | unit tests of the pid filter; test-ui: real clicks end a spawned child, and a second child that ignores SIGTERM is force-quit |
| D | Longer history: per key fixed rings of 60 × 1 min and 96 × 15 min (min / avg / max); 2 min / 1 h / 24 h switch on the detail charts | Engine + UI | gaps while a metric was not sampled, interval changes | unit tests (bucketing, gaps, capacity); test-ui clicks the switch; overhead |
| E | Disk page: top processes by read + write rate from `/proc/<pid>/io`, only while the page is open; the user's processes only (EACCES for others is expected, counted, not shown) | HAL + UI | PID exits between listing and read | unit tests; test-ui with a writer process |
| F | Network data per day and month from `/proc/net/dev` every 60 s, counter resets handled, 62 days kept in `~/.local/share/resource-pulse/network-usage.json` | HAL + Engine + UI | counter wrap / interface re-created, clock change across midnight (wall time for day keys only) | unit tests; overhead |
| G | Diagnostics: "Copy report" puts findings and system state on the clipboard as text | UI (prefs) | no findings yet | GTK check reads the clipboard |
