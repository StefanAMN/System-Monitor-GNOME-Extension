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

## State

See git log on `audit-fixes`. Resume: `./dev.sh test-unit && ./dev.sh test-headless 8`.
