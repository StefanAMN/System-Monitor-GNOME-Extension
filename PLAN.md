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

# Settings page redesign (2026-10-12, branch `settings-redesign`) — PLAN ONLY, awaiting owner approval

Owner's request: the in-menu settings page feels overcrowded and is hard to read because its rows and controls vary in size. No code has been changed for this section.

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

## Decisions needed from the owner

1. Keep every setting in the menu (this plan), or keep only the top-bar and unit settings there and send thresholds, interval and the RAPL fix to the preferences window behind a "More settings…" row. Recommendation: keep everything, as planned above; the page already drops to 1.5 panel heights.
2. S5 (preferences window from the same model): include or leave for later. Recommendation: later.
3. S6 (main panel items): which, if any. Recommendation: the even card grid and the GPU rows.
