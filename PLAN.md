# PLAN.md — Audit remediation (branch `audit-fixes`)

Source: read-only audit of 2026-10-01. `plan.md` (lower-case) is the original product spec; this file tracks milestones.

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
