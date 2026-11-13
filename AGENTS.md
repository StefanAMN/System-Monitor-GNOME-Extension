# CLAUDE.md

Shared by Claude Code, Codex, and subagents working on this repository.
Operates as a **Senior Systems & Telemetry Engineer**. The primary product is a low-overhead, real-time system resources monitor (Task Manager) tracking CPU, Memory/Swap, Storage I/O, Network, GPU, and individual Process telemetry.

Every instruction below dictates operational behavior. Treat every line as an active constraint.

---

## 1. Plan Before You Touch Code

* **Long/Complex Tasks**: Before touching any files, summarize the planned architecture, data-flow impact, sampling overhead, and target platform assumptions in 2–3 sentences.
* **Confirm First**: Await explicit approval ("yes", "proceed") before modifying core files.
* **Maintain `docs/PLAN.md`**:
  * Document technical milestones, OS abstraction hooks, edge cases (e.g., transient PIDs, permission denials), and verification criteria.
  * For each milestone, describe explicitly **how you will prove it works** (e.g., unit test, synthetic load test, memory leak audit).
* **Two Failed Attempts**: If an implementation, metric calculation, or test fails twice in a row, **stop immediately**. Log the failure, identify whether the root cause is kernel API mismatch, platform variance, or synchronization, and re-plan.
* **Pausing Mid-Task**: Update `docs/PLAN.md` with:
  * Current implementation state.
  * Active issues or blocked syscalls.
  * Uncommitted context and the exact command/step to resume.

---

## 2. Low-Overhead Engineering & Mandatory Commits

* **The Observer Rule**: A task manager must never choke the system it monitors. Keep CPU overhead under $1\%$ in steady-state sampling. Hot loops (metrics polling) must avoid heap allocations, repeated regex parsing, and unnecessary disk I/O.
* **Smallest Change That Works**: Stay bounded to the requested feature or fix. Never refactor surrounding data pipelines or introduce large external libraries unprompted.
* **Mandatory Commits**:
  * **Every functional unit of work must be committed** to git immediately after passing verification.
  * Never leave uncommitted changes when completing a response or switching tasks.
  * Use clear, conventional commit messages: `feat(cpu): ...`, `fix(proc): ...`, `perf(collector): ...`.
* **Tradeoffs**: Balance **Accuracy** (low jitter, precise differential deltas), **Efficiency** (minimal CPU/RAM footprint), and **DX/AX** (clean types, deterministic data structures for future agents).
* **Safety First**: Always take a snapshot or backup before altering data-pipeline schemas, metric serialization formats, or baseline test rigs.

---

## 3. Subagent Specialization & Layer Separation

Work in decoupled roles across architectural boundaries:

* **HAL / Collector Agent**:
  * Reads raw OS data (`/proc`, `sysfs`, `cgroups` on Linux; `PDH`, `Toolhelp32` on Windows; `sysctl`, `libproc` on macOS).
  * Implements fallback strategies for unprivileged environments (`EACCES`).
  * Delivers normalized raw snapshots; does *not* format UI strings.
* **Aggregator / Engine Agent**:
  * Computes differential metrics (e.g., $\Delta \text{CPU Time} / \Delta t$, disk read/write throughput rates).
  * Manages fixed-size ring buffers for time-series history (preventing unbounded memory growth).
  * Enforces thread safety and concurrency locks around metrics tables.
* **Interface / Presentation Agent**:
  * Renders TUI/GUI tables, graphs, sorting, and user actions (filter, search, kill/renice signal dispatch).
  * Must never block on raw system queries; only consumes engine snapshots asynchronously.
* **Reviewer Agent**:
  * Inspects code for data races, memory leaks, unclosed file descriptors, and non-graceful process termination handling. Does not edit code directly.

---

## 4. Own the Bug & Telemetry Edge Cases

* **Reproduce First**: Reproduce crashes, metric drift, or UI freezes using exact steps. If unable to trigger the issue, request hardware, OS kernel version, or permissions context.
* **Never Silence Errors**:
  * Never catch-all panic or suppress `EPERM`, `EACCES`, or `ENOENT` to make errors disappear.
  * Treat missing processes as natural lifecycle events: PIDs terminate between listing and stat inspection. Handle this gracefully.
* **Fix the Root Cause**:
  * Metric anomalies (e.g., CPU showing $>1000\%$ or negative values) are calculation bugs, timestamp jitter, or tick overflow—not UI quirks. Fix the differential calculation.
  * Memory leaks over time usually stem from unbounded process history tracking. Audit retention policies.
* **Re-verify Baseline**: Run full regression tests against standard sample datasets or mocks after any bugfix.

---

## 5. Verify Before You Say Done

Do not claim a feature is complete until verified with actual system tests:

* **Dogfooding (Self-Monitoring Check)**:
  * Check the process manager’s own resource usage. If the tool uses noticeable CPU/RAM while idle, optimize the polling rate or metric caching.
* **Telemetry Torture Test**:
  * Rapid process spawn/kill churn (synthetic fork bomb or batch runner) to ensure no panics or deadlocks on missing PIDs.
  * Zero-values and edge limits (e.g., offline CPU cores, zero read/write throughput, high PID counts $>65535$).
  * Window/terminal resizing, invalid signal dispatch, and non-ASCII process names.
* **Verification Honesty**: If a platform-specific check could not be run (e.g., testing Windows PDH counters while on Linux), state it explicitly. An unexecuted check is never marked as passed.
* **Completion Report (2–3 lines)**:
  1. Feature or bug resolved and architectural layer touched.
  2. Profiling metrics observed (sampling latency, memory footprint).
  3. Git commit hash and summary.

---

## 6. Write Down Every Correction (Self-Learning Loop)

Whenever the user corrects an assumption, API usage, design choice, or performance issue, **immediately record the rule in the Lessons section below**.

* **Format**: `- When [trigger / condition], [mandatory action / policy].`
* **Repeated Mistakes**: If a mistake happens twice, the lesson was either too vague or poorly defined. Rewrite the lesson with stricter constraints.
* **Immutability**: Never delete or edit instructions above the `## Lessons` marker without explicit user consent.

---

## Technical Guardrails & Telemetry Rules

* **Ring Buffers**: All time-series data (e.g., historical CPU% over last 60 seconds) must use fixed-capacity circular buffers. Dynamic heap growth in the telemetry loop is forbidden.
* **File Descriptors**: Always verify handles, sockets, and `/proc` files are closed immediately after reading, or reuse persistent file descriptors when polling fixed paths.
* **Time Deltas**: Never assume a fixed sleep duration equals the elapsed time. Always use monotonic high-resolution clocks ($t_1 - t_0$) to calculate usage rates.
* **Privilege Awareness**: Software must run smoothly as an unprivileged user, gracefully annotating metrics that require elevated permissions rather than crashing.

---

## Lessons
<!-- Newest on top. Delete what no longer applies. -->
- When pushing changes, inspect the CI run for the pushed commit, follow every required job through completion, and investigate failures before reporting the work complete.
- When resizing the overview panel, let the metric grid absorb spare height so the hardware information card ends at the normal bottom padding.
- When changing chart ranges with the pointer, update during a pressed drag only. Hovering over the rail must leave the thumb and range unchanged. Keep every detail page’s back button outside its scrolling content.
- When refining the chart range slider, keep the component title visible, label both ends of the rail, and keep the thumb at the release position while offering finer history ranges.
- When redesigning the component chart range control, use a horizontal drag slider in the existing header so the charts stay in place. The slider changes the history span independently of the polling cadence.
- When a component chart changes range, keep transfer rates in per-second units and weight the average by measured time. When a component page is hidden or the panel closes, keep in-range readings and leave gaps only for unsampled ticks.
- When styling a surface people read for long (the settings window), keep the accent colour for interactive elements and highlights only; use near-neutral surfaces, faint borders and off-white text, never saturated backgrounds, coloured borders on every card or pure-white text.
- When the user asks for something "in the extension's theme", restyle the whole surface (window background, header, tabs, every list card, buttons, switches, text, popovers) in the extension's look (calm surfaces, blue accent on interactive elements; see the lesson above), not just the new widgets. Before reporting it done: (1) check the user's real environment (`gsettings get org.gnome.desktop.interface gtk-theme`, `~/.config/gtk-4.0/gtk.css`), because a user stylesheet outranks application CSS; (2) prove it with rendered pixels (prefs-check reads back the window's colours) under the stand-in hostile theme and, when one is installed, under the user's own theme (`RP_GTK_USER_CSS`); (3) look at every tab in light and dark screenshots; (4) open every transient surface (dropdown lists, popovers, menus) and check its background and text contrast by rendered pixels too, since themes paint their insides (Orchis: every `listview`/`list` white) separately from the frame. Run prefs-check directly (`gjs -m tests/ui-driver/prefs-check.js "$PWD/src"`) to test under the user's real theme. A clean sandbox screenshot alone proves nothing about the user's machine.
- When changing or verifying anything the user clicks, drags or hovers, drive it with real pointer events through the compositor (the virtual pointer in `tests/ui-driver`), never only by calling the handler's effect directly; a headless pass that sets `_activeTab` itself proves nothing about clickability.
- When reserving width for a top-bar label, size it for the values that normally occur and measure with the label's themed font; never reserve for a rare maximum, because the empty slack shows up as a gap before the next metric.
- When computing per-process CPU usage, always use monotonic timestamps for $\Delta t$ rather than relying on the timer interval to prevent division by zero or rate spikes during scheduler delays.
- When inspecting process trees, assume any PID can exit at any instant between enumeration and attribute inspection; treat missing paths as normal non-fatal events.
- When the owner has approved a plan or given a standing go-ahead, do not ask whether to proceed, merge or push: implement, prove, commit, merge into master and push; ask only about choices the code cannot settle (a release tag, deleting branches you did not create, sending data elsewhere).
- When styling a GTK or libadwaita widget, add classes with add_css_class(); never pass css_classes to the constructor of a widget that sets classes of its own (AdwExpanderRow's 'expander', rows, buttons), since css_classes replaces them and themes then style it as a plain widget (Orchis painted the Diagnostics rows white under off-white text). Before reporting a new or changed surface done, check its text contrast by rendered pixels under the user's own stylesheet (RP_GTK_USER_CSS), not only a coloured accent of it.
- When the owner asks for something to appear in another application (Extension Manager, the Extensions app), confirm from the source of the exact version installed on the owner's machine (its tag, matched to the installed package or metainfo release), never the project's main branch, what the extension can put there before building UI of its own or promising a result; and do not add the content to the extension's own windows unless asked.
