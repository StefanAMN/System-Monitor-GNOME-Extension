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

## State (2026-10-15, branch `alerts-and-history`)

| # | Result | Proof that was run |
|---|--------|--------------------|
| A | Alerts with ⚠ (22 px, narrower than any value so it hides at most one) and red pinned value; notifications with the cause ("sh ×12 using 11.7 cores"), clicking opens the page; GPU / disk limits and a notifications switch in Settings | 23 unit checks with a fake clock (sustain, hysteresis, recovery, unreadable values, gap per metric, lowered threshold); test-ui: every core burned, ⚠ + red value, tooltip by real hover, notification text, real click on the banner opens the CPU page, all clear after; ⚠ hides ≤ 1 value (measured: 5 → 6) |
| B | Pressure rows on CPU / Memory / Disk; memory pressure ≥ 20 % alerts | unit parse + fixture tree + missing-PSI tests; test-ui reads the three rows |
| C | End / Force quit / Cancel on top-process rows (CPU, Memory, Disk); session processes never offered; the ✕ keeps its room when hidden | unit tests: identity from a fixture /proc (zombie, reused pid, other user), real children ended by TERM and KILL, kill's error reported (pid_max, never a real process); test-ui with real clicks: polite process ended, one ignoring TERM force-quit, Cancel leaves it running, the click does not reach the row |
| D | 2m / 1h / 24h switch in the detail header; gaps drawn as gaps; peak line; network, battery, power read once a minute while not shown | unit tests (bucketing, gaps, capacity, hours in the hover label); test-ui clicks 1h / 24h / live and finds filled buckets |
| E | Disk page "Top Disk Usage": only processes doing I/O; other users' counted and named as unreadable | test-ui: a dd writer on ext4 listed first (718 MB/s); note shows 235 unreadable processes |
| F | Today / This month on the Network page, saved with the boot id | unit tests (baseline, day roll, month sum, counter reset, reboot, new interface, save/load, 62-day bound, foreign file refused); test-ui reads both rows |
| G | Copy report in Diagnostics | GTK check reads the clipboard: header, system line, findings by goal |

Found on the way:
- The UI test sandbox never loaded a user GTK theme. That is fixed in W6.
- The Tracking-page file check depended on inotify. This machine had 126 of 128 inotify instances in use, so GLib fell back to polling; the check now allows 10 s.
- The cause line said "sh ×14 1189 %". It now says cores.
- The bold red value grew wider than the space reserved for it and hid neighbouring values. The value is now red only, not bold.
- `Gdk.Clipboard.set_text` is not introspectable, so the report goes through a bytes content provider.
- The network-usage load compared a generation counter captured before `enable()` bumps it, so the saved totals were never attached. It now uses a per-enable token.

- A click on a process's ✕ could be lost. The press also reached the row, whose press animation shrinks it about its centre, so the ✕ moved about 13 px from under the pointer before the release (GNOME 49 container). The row's handlers now skip presses on the ✕. Stopping the event after the button instead broke the button's own click.
- In the containers the top bar had 1 px to spare. Under load the CPU value ("100%") is wider than the room reserved for normal values, so it can hide one value of its own. The ⚠ test therefore checks the guarantee (the ⚠ is narrower than any value) and only logs the count.
- The test now waits for the panel's scroll animation to settle before clicking.

Soak after the row reuse: menu closed +0.50 % (budget 1 %), with tracking +0.60 %; RSS slope 0.098 MB/min (0.387 before rows were reused); fds 75 → 75.

Not run: real NVIDIA / AMD GPUs (GPU alerts use the same reading as the GPU page); a kernel without PSI (fixture only); traffic across a real screen lock (the boot-id path is unit-tested).

## Smooth changes (branch `smooth-values`, 2026-10-16)

Owner's request: values changed too abruptly at the 2 s interval. Owner's decision: glide between readings (1) plus light averaging of noisy readings (2), with the glide lasting exactly one polling interval.

Design: `lib/smoothing.js` (pure) averages CPU, GPU, network and disk rates (half weight per reading) and interpolates named numeric fields between two readings. The shell keeps the raw reading in `_lastData` for alerts, history and the battery tracker, and shows a glide from what is on screen to the new (averaged) reading over one interval. The existing renderers draw the interpolated reading: about 15 frames a second with the menu open, and with it closed only the top bar in four steps per interval. Live charts slide by the time since their last sample. Setting `smooth-transitions`, on by default.

Measured first: a full render costs 0.5–0.7 ms of JS and the top bar alone 0.06 ms.

| Proof | Result |
|---|---|
| Unit tests: averaging, raw reading untouched, only named fields glide, process lists and load averages never blended, start / end / unavailable values | 14 checks pass (382 in total) |
| UI: two known readings with polling paused | memory 20 → 22 26 30 … 74 78 → 80 over 2 s, never going back; CPU lands on the average (50); top bar ends exact; charts slide and come to rest |
| Overhead soak | see below |

Overhead, measured (software-rendered test shell, % of one core over the extension disabled):

| Variant | Menu closed | Menu open (overview / CPU tab) | Memory slope (limit 0.5 MB/min) |
|---|---|---|---|
| Before smoothing | +0.50 | +0.90 / +1.43 | 0.098 |
| Glide at 15 fps | +0.57 | +11.80 / +14.36 (fail) | — |
| Bars as plain actors, charts only on samples, 15 fps | +0.77 | +12.57 / +15.63 (fail) | — |
| 4 fps | +0.87 (with tracking +0.99) | +3.40 / +4.53 | 0.479 |
| 4 fps, reused buffer, no tooltip rebuild on frames | +0.87 (with tracking +1.00) | +3.77 / +4.23 | 0.552 (fail; total RSS fell 293.3 → 287.9 MB) |

Per-component probe at 15 fps with the menu open: any visible change costs about the same (+7-8 %: one label, one bar, or the whole panel), because each change redraws the open panel in software. The cost is per frame, not per widget.

| Top bar not gliding while the menu is closed (owner's decision), five process rows built up front | +0.63 (with tracking +0.75) | +4.00 / +4.53 | 0.077 over a 30 min soak |

Stopped after repeated budget failures (CLAUDE.md, two failed attempts) and asked the owner. A further 10 min soak measured +1.00 % closed (+1.13 % with tracking), so the closed-menu top-bar glide was the cause. Owner's decision: with the menu closed the top bar shows the averaged values once per reading and no frames run.

Memory: the 10 min soaks after the glide gave slopes of 0.48–0.62 MB/min. The 30 min soak with the series logged shows a plateau: the 5-minute means are 291.0, 290.8, 294.0, 294.7, 294.2 and 294.3 MB, and RSS went 301.0 → 292.3 MB. The 10 min slope was catching the garbage collector's settling, not a leak.

Also: the Disk list added rows as more processes became active, so the actor count grew 913 → 939 (flagged as drift). All five rows are now built up front.

Intermittent test (not caused by this work): opening the window from the battery line failed twice in many runs, once in the GNOME 46 container before any smoothing code; the next runs passed.

Found on the way:
- The panel-size test read the `width` property. While a relayout is pending, that answers the requested width (380) rather than the laid-out one (372, a constant). Values changing 15 times a second made this frequent. The test now reads the allocation.
- The GPU page test checks exact injected readings, so it now runs with smoothing off.

## Settings only from the Extensions app (branch `prefs-entry`, 2026-10-16)

Owner's request: the Extensions app's settings should not show Tracking and Diagnostics; the window opened from the panel keeps them.

How: the panel sets `prefs-page` just before it opens the window, and the Extensions app never does. `ui/prefswindow.js` (moved out of `prefs.js` so it can be tested) builds the Settings page always. It adds the Tracking and Diagnostics tabs and the back-to-panel button only on a panel request. A request that arrives while a settings-only window is open (GNOME then only raises it) adds the tabs on the spot.

Proof:
- prefs-check: from the Extensions app the window has `settings` only. A panel request on that open window adds the tabs and shows the page asked for, and the request is cleared. From the panel, all three tabs open on the page asked for.
- test-ui: the real Extensions-app path (`openExtensionPrefs` with no page) opens the window, and the screenshot shows no tabs and no back button. ⋮ still opens all three tabs.

## Calmer window colours (branch `calmer-window`, 2026-10-18)

Owner's report: the settings window's blue was too contrasty and tiring. Changed in `ui/prefsstyle.js`:
- Surfaces are charcoal (light mode: near-white) with only a hint of blue, instead of navy (light: pale blue).
- Card borders are faint neutral lines instead of blue.
- Text is off-white instead of pure white.
- Neutral buttons have a grey tint.
- The blue accent stays on switches, the selected tab and highlights.
- The coloured stat tiles keep their metric tints, as in the panel.

Proof: the rendered-colour check passes in dark and light under the stand-in theme and under the owner's Orchis-Pink. That check reads the background, header, card, a checked switch (still the extension's blue) and the text. Screenshots of every tab in both variants.

## Restructure into folders (branch `restructure`, 2026-10-18)

Owner's request: fewer single files in the root, more modules in folders. Owner's decisions:
- The extension moves to `src/`, and the installed symlink points there.
- `extension.js` (4,049 lines) is split into modules.
- PLAN.md moves to `docs/`, with consent to update CLAUDE.md's two mentions.

| # | Step | Proof |
|---|------|-------|
| R1 | `git mv` of 46 files: `src/` (extension.js, prefs.js, metadata, stylesheet, schemas, icons, lib, ui); `lib/` split into `collectors/`, `engine/`, `common/`; `ui/` into `panel/` and `prefs/` (prefs files renamed without the prefix); `tests/unit/`, `tests/bench/`; `scripts/dev.sh`; `docs/PLAN.md`. Imports rewritten by resolving each one from the old location; dev.sh, the container entry, CI, .gitignore, README and comments updated | a script resolves all 109 relative and extension-root paths (0 missing); lint; unit tests; full UI test; pack, with the zip holding every source file in its folder plus LICENSE and the schema |
| R2 | `extension.js` (4,049 lines) split into 17 method groups in `src/ui/panel/`: shared, sizing, polling, topbar, alerts, processes, overview, details, eight pages and dashboard. Each group is a class whose methods are copied onto the extension's prototype (`mixins.js`, which throws on a name defined twice), so the method bodies moved verbatim. `extension.js` keeps `enable()` / `disable()` (519 lines). Shared constants are in `constants.js`. Imports were trimmed per file from ESLint's unused / undefined report | every non-blank line of the old class is in the new files except 5 section banners (checked by script); lint clean (no undefined names); 387 unit checks; full UI test; overhead soak; GNOME 46–49 containers |

Found during R2's container runs: the intermittent "the battery line did not open the window" (seen before in the GNOME 46 container and locally) failed 3 of 3 times on GNOME 47. The session log showed an unhandled rejection of `openExtensionPrefs`: GNOME's preferences service quits when its last window closes, and a request that reaches it while it is quitting fails. The shell drops that error (46–49 do not even return it). This is a real bug: close the window and click ⋮ again within a second, and nothing opens. Fix: the extension makes the same D-Bus call (`org.gnome.Shell.Extensions.OpenExtensionPrefs`), logs a failure and retries (3 tries, 500 ms apart; D-Bus starts a new service).

Proof:
- The UI test makes the first request fail (as the quitting service did) and clicks ⋮ with the real pointer. Two requests are made, the warning is in the shell log, and the window opens.
- GNOME 47 container: 3 of 3 runs pass after the fix, against 3 of 3 failures before.

## Dropdown lists readable under third-party themes (branch `fix-popover`, 2026-10-18)

Owner's report: Tracking › Report › Period showed its options as off-white text on a bright background. Reproduced by rendering an open dropdown under the owner's Orchis-Pink theme. The popover frame was dark, but Orchis paints every `listview` and `list` white (`listview, list { background-color: #FFFFFF }`), and the window's stylesheet only coloured `popover > contents`. Fix: inside the window, lists, `.view`, scrolled windows and rows in popovers are transparent with the window's text colour, so they sit on the popover's surface.

Proof:
- prefs-check opens a real dropdown (Temperature; Period is the same widget) in dark and light. It reads the list's background (must be the popover colour) and the option text's contrast against it (difference above 110).
- Against the old stylesheet under Orchis this fails exactly as reported: `rgb(228, 231, 235)` on `rgb(255, 255, 255)`. With the fix it passes.
- The stand-in theme now paints lists white as Orchis does.
- The switch check now searches the whole switch for the accent: Orchis's thin 32 × 14 track made the fixed sample point land on the card in light mode, although the switch was blue.
- prefs-check run directly under Orchis: 136 / 136. test-ui passes with the stand-in theme and with Orchis.

## Next areas (plan, 2026-10-18; awaiting the owner's approval)

Owner's order: 1, 2, 5 first, then the rest. Each area gets its own branch and commits and is merged only after its proof has run.

Owner's decision (2026-10-19, after area 1 was merged): "continue with the other areas without asking me next". Each area is therefore merged into `master` and pushed once its proof has passed. The open questions are settled with the defaults below, each noted in its area:
- translations: the template for every language, plus the language this machine's locale settings use if it is not English (decided in area 3);
- several GPUs: the busiest one in the top bar;
- extensions.gnome.org: the RAPL fix keeps its pkexec helper only if the review rules allow it.

### Area 1: the full tests on GitHub (CI) and release builds

Today CI runs lint and unit tests only. The UI tests and GNOME 46–49 run only on the owner's laptop, so a push cannot catch a broken panel.

- **Workflow:** `.github/workflows/ci.yml` gets a job matrix over GNOME 46, 47, 48, 49 and 50. The jobs reuse `tests/compat` (Fedora containers; 50 = Fedora 44, added to `compat_fedora` in `scripts/dev.sh`) and run unit, headless and UI tests with software rendering, in parallel. A new `scripts/dev.sh test-compat-one <version>` lets each job run one version.
- **On failure:** the job uploads the screenshots and shell log as an artifact, and the job summary names the failing check.
- **Releases:** a workflow on tags `v*` runs the matrix, packs the `.zip` (`scripts/dev.sh pack`) and attaches it to a GitHub release.
- **When it runs:** pushes to `master` and pull requests get the full matrix; other branches get lint and unit tests (fast). The 10-minute soak is not in CI until area 5 makes it reliable, and then only on `master`.
- **Edge cases:**
  - Runners have 4 cores; the tests size their CPU burners from the core count, which already copes.
  - Docker image builds are cached between runs (buildx and the GitHub cache) to keep a run near 10–15 minutes.
  - A Fedora mirror failing is retried once, as seen locally.
- **Proof:**
  1. The workflow runs green on a branch push.
  2. A throwaway branch with a deliberately broken panel (one click handler removed) turns it red with the right check named, and that branch is then deleted.
  3. A test tag produces a release with the `.zip`; then the tag and release are deleted.

#### State (branch `ci-matrix`, 2026-10-18; approved by the owner: "start with area 1")

Built as planned, with these differences:
- No `test-compat-one`: `scripts/dev.sh test-compat 47` already runs one version.
- `test-compat` gained:
  - `RP_COMPAT_OUT=<dir>`: keeps the logs;
  - `RP_ARTIFACTS` (set inside each container): a failing test copies its sandbox's logs and screenshots out before the container goes;
  - a GitHub `::error` annotation and a job-summary table naming the failing check;
  - one retry of a failed image build;
  - `RP_COMPAT_NO_BATTERY=1`: hides the batteries (`--tmpfs /sys/class/power_supply`), so a laptop can test what a desktop or a GitHub runner sees.
- The manual trigger (`workflow_dispatch`) lets the full matrix run on any branch; it is how proofs 1 and 2 are run.
- No image cache: a whole job on the runners, image build included, takes about 5½ minutes (a full run about 7 minutes), so caching 2 GB images would save little.
- The actions are on their current majors (`checkout`, `setup-node`, `upload-artifact` v7), which run on Node 24; v4 drew GitHub's Node 20 deprecation warning.
- Fedora 44 ships GNOME Shell 50.6; it passes unit, headless and UI tests locally (8 min 18 s with the image build).
- GNOME 46's `gnome-extensions pack` handles the folder sources, so the release job packs on the Ubuntu runner.

The first CI run (all five red) found two problems the laptop runs never showed:
1. **A gap after "n/a" in the top bar** (GNOME 46, 47, 49, 50). The runners have no battery, so the pinned battery shows "n/a", but its label still reserved room for "100%" (16 px of empty space). A desktop user who pins the battery sees the same.
   - Fix (`ui/panel/topbar.js`): while a label shows "n/a", the value the machine cannot provide, it reserves nothing. The label's own `notify::text` handler follows it into and out of "n/a". The handler does one string comparison per text change and measures only on a transition.
   - The UI test's width check now also checks "n/a" against its own text, and checks that a value after "n/a" gets its reserved room back.
   - The alert test's "⚠ narrower than any value" check now measures only labels that show a value. An "n/a" label can be narrower than the ⚠ (20 vs 22 px), but hiding it costs no value, and the next label hidden is wider than the ⚠, so making room for the ⚠ still hides at most one value.
   - Reproduced locally with `RP_COMPAT_NO_BATTERY=1`: the old code fails with exactly the CI message.
2. **The open-dropdown check could not see the list on GNOME 48 and 49.** It read `rgb(0, 0, 0)`, the check's fallback for "no pixels".
   - That check (from `fix-popover`) had only run on GNOME 50 before merging.
   - Attempt 1, waiting for the list to be laid out, failed: the popover stayed mapped and laid out for 5 s with nothing to read.
   - Attempt 2 got past part of it. On GTK 4.18 a popover, being its own native surface, renders nothing through a `WidgetPaintable`, so the check now renders its `contents` node. That passed once in CI and failed once (the throwaway run), so per the two-attempts rule I stopped and traced it.
   - Traced on GNOME 48 with 2 CPUs (fails 3–4 of 4 there):
     - the compositor configures the popup (`layout` events, 208 × 148);
     - the shared frame clock ticks;
     - the contents are mapped and drawable;
     - yet GTK never paints the first opening of a popover opened from code (no user input) in a window that has been up a while.
     - Closed and opened again, it paints within 100 ms (every second opening in every run did).
   - The shell sits in the Overview at startup on 46–49, but closing it did not change this.
   - Fix (`tests/ui-driver/prefs-check.js`): the check reopens a popover that has not drawn within a second, up to 5 s in all, and says "not on screen" instead of reporting black. Result: 4 of 4 runs pass on GNOME 48 with 2 CPUs.
3. **The dropdowns' current values sat in white boxes** under the stand-in theme, on every version: "Percentage (85%)" and the like, off-white on white. Found in the GNOME 48 screenshots while tracing item 2.
   - The value is an inline `listview.view` in the row, which the stand-in paints white like every list. The owner's Orchis exempts it (`row.combo listview.inline { background: none }`), so their machine was not affected; a theme without that exemption would be.
   - The prefs screenshots in `fix-popover` showed it and it was missed; no pixel check looked there.
   - Fix (`ui/prefs/style.js`): inline lists in combo rows are transparent and inherit the row's text colour.
   - New check: prefs-check reads the pixels around the Temperature row's current value. They must be the card colour, and the text must contrast with them (difference above 110).
   - It fails on the previous stylesheet with exactly the white box.
   - With the fix: 140 / 140 on GNOME 46, 47, 49 and 50 under the stand-in theme, and on 50 and 48 under the owner's Orchis-Pink-Light. Screenshots in light and dark checked by eye.

Proof (all on GitHub):
1. Green: run 39161468401 on `ci-matrix`, all five shells pass (5½–7 minutes per job).
2. Red: run 39161474404 on the throwaway branch `ci-proof-broken` (the ⋮ button's `clicked` handler removed). All five shells fail, each naming the same check on the run's page: `RP-UITEST FAIL: prefs: 0 window requests, expected the failed one and one retry`. Each job kept its logs and screenshots as an artifact (1.3–2.3 MB). Run 39199414195 repeated this on the v7 actions.
3. Release: tag `v0.0.0-ci-test` (run 39199411239). All five shells passed, then the release job published "Resource Pulse v0.0.0-ci-test", marked as a pre-release, with the zip (160 KB). The downloaded zip is file-for-file identical to a local pack on GNOME 50 (61 files). The release, the tag and the throwaway branch were then deleted; the runs stay as the record.

Overhead (`test-overhead 30`, `master` and this branch alternated twice each on the owner's laptop, with their desktop apps running):

| Run | Load | Closed | Closed + tracking | Overview open | CPU tab |
|---|---|---|---|---|---|
| master 1 | 0.82 | +0.40 % | +0.74 % | +4.63 % | +5.70 % |
| branch 1 | 0.62 | +0.40 % | +0.71 % | +4.50 % | +6.23 % |
| master 2 | 1.07 | +0.40 % | +0.65 % | +3.77 % | +4.90 % |
| branch 2 | 2.11 | +0.87 % | +1.22 % (fails the 1 % budget) | +4.23 % | +6.10 % |

At similar load the branch measures the same as `master`; the `notify::text` handler adds nothing measurable. An earlier branch run at load about 1.2 also read +1.22 % with tracking. Both over-budget readings came with the highest host load, and `master` varies as much (CPU tab 4.90–5.70 %). The closed-with-tracking budget has only about 0.3 % to spare on a busy machine, for either version. Measuring overhead reliably on a shared desktop belongs with area 5's work on trustworthy measurements. (`master`'s second run also tripped the 30 s soak's memory slope, 3.22 MB/min: the known unreliable check, area 5.)

Not run: the soak in CI (area 5 first). Merging `ci-matrix` waits for the owner.

### Area 2: accessibility (screen readers)

Only 2 of the panel's interactive items have names a screen reader can announce. The rest are bare icons or cards.

- **Names and roles:**
  - every top-bar metric ("CPU 7 percent"), kept in step with its value;
  - the ⚠ ("Alerts: CPU 97 percent for 1 minute");
  - overview cards ("CPU, 7 percent, opens CPU details");
  - every button (back, ⋮, refresh, range, Show All, End, Force quit, Cancel, System Monitor, resize corners);
  - process rows (name and value);
  - detail rows, where the value is announced together with its label.
- **Roles:** set where St offers them: buttons, toggle for the range chips, list items. Layer: UI only, with no collectors involved. Names are set when the text changes, not per frame (no measurable cost).
- **Edge cases:**
  - names must follow the glide's shown value without re-announcing every frame, so the accessible name is updated on readings only;
  - hidden rows (spare process rows, the ⚠ when off) must not be announced.
- **Proof:**
  - **Automated:** a test client walks the shell's accessibility tree over AT-SPI (`gi://Atspi`, in the sandbox with toolkit accessibility on). It asserts that every focusable or clickable panel element has a non-empty name and a role. It fails if a new unnamed button is added.
  - **Versions:** the check runs in the GNOME 46–50 containers. St's accessibility API changed across versions, so it is checked on each.
  - **Manual:** an Orca run on the owner's machine, which I cannot do; it is listed as not run until the owner tries it.

### Area 5: a memory check that can be trusted

The 10-minute soak's RSS slope fails intermittently (0.48–0.72 MB/min) while 30-minute runs show a plateau (0.077, 0.151). It measures the garbage collector settling, not leaks.

- **Primary check (new):** count live JavaScript objects with `System.dumpHeap()` at the start of the steady phase and at its end, grouped by kind (arrays, plain objects, GObject wrappers by class). A leak, meaning something kept per poll, grows a count steadily. Allocator retention does not.
  - Threshold: no group grows by more than a fixed small margin per 100 polls, checked on two intervals so a one-off cache fill does not count.
- **Secondary check:** RSS stays a sanity bound, measured after a settling period (the first 10 minutes are ignored) with a robust slope (Theil–Sen), in a 20-minute default soak.
- **Edge cases:** heap dumps are large (tens of MB), so they are written to the sandbox, parsed by a small script and deleted. Dumping pauses the shell, so it happens outside the CPU measurement windows.
- **Proof:**
  1. A deliberate leak, behind a test-only setting the driver turns on (one array element per poll kept forever), must fail the new check within the soak.
  2. The current code must pass it three times in a row.
  3. Only then does the soak join CI on `master`.

### Area 3: translations

The interface is English only, and no file uses gettext.

- **Wiring:** `gettext` / `ngettext` through the extension's own domain (`gettext-domain` in metadata; `Extension.gettext` in the shell, `ExtensionPreferences` in the window).
  - Sentences with numbers use full sentences with placeholders, so word order can change per language.
  - `po/` with a `.pot` extracted by `scripts/dev.sh pot` (xgettext); `.mo` files built into `src/locale` by pack and test.
- **Scope:** about 70 literal UI strings plus the diagnostics, notification and alert sentences (about 250 in total).
- **Edge cases:**
  - metric names in the top bar must keep the width reservation working (measured per language);
  - units stay as symbols.
- **Proof:** a pseudo-language that wraps every translated string in markers is installed in the sandbox. The UI test reads every visible label in the panel and window and fails on any text without the markers (an untranslated string). Screenshots in a real translation are also checked.
- **Decision needed:** which language(s) first.

### Area 4: ready for extensions.gnome.org

- **Audit:** go through the current review guidelines item by item (fetched at the time, since they change) and fix what does not comply. Likely items:
  - the 5 synchronous `/proc` reads in the shell (an owner-approved exception today; reviewers may ask for async);
  - the pkexec RAPL fix (reviewers question privileged helpers; it may need to become documented manual steps);
  - log volume;
  - metadata (description, URL, versions);
  - the packed zip's contents.
- **Proof:** the checklist recorded here with each item's state, a pack and install from the `.zip` on GNOME 50 and in the containers, and the overhead soak after any change to the reads.
- **Not mine to do:** the submission itself goes through the owner's account.

### Area 6: more than one battery or GPU

- **Batteries:**
  - the top bar uses UPower's combined DisplayDevice, which is already read for some values;
  - the Battery page lists each battery (BAT0, BAT1) with its own level and health;
  - tracking uses the combined energy.
- **GPUs:**
  - the collector returns every GPU (DRM cards and `nvidia-smi` lines), and the GPU page shows one card per GPU;
  - the top bar shows the busiest one or a chosen one (new setting);
  - alerts consider each.
- **Edge cases:**
  - a dGPU that is powered down (runtime PM): reading it must not wake it (sysfs runtime status is checked first);
  - batteries added or removed (docks).
- **Proof:** fixtures for two DRM cards, two `nvidia-smi` lines and two UPower batteries in unit tests; UI tests with injected readings, like the existing GPU page test. Real hybrid-graphics hardware is not available, which will be stated.

### Area 7: smaller improvements

1. **Process lists:**
   - search (a filter field on the CPU, Memory and Disk pages; while it has text, the sampler returns all groups instead of the top 5, only while that page is open) and sorting by CPU, memory or I/O;
   - proof: unit tests on filtering, a UI test typing a name with real key events, and an overhead measurement with search active.
2. **Session totals across the screen lock:**
   - network session totals and the power average and peak persist for the login session (keyed by `XDG_SESSION_ID` and the boot id, like the daily network totals), so a lock no longer resets them;
   - proof: unit tests and a disable/enable cycle in the UI test keeping the figures.
3. **Settings export, import and reset:**
   - a "Backup" group in Settings: export to a JSON file, import with validation against the schema (unknown keys and bad values rejected and listed), and reset all with a confirmation;
   - proof: a prefs-check round trip, a rejected malformed file, and reset restoring the defaults.
