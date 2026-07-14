# Plan: Production Validation Sprint

Branch: `feature/production-validation-self-harness` (worktree at
`.claude/worktrees/feature+production-validation-self-harness`).

## Purpose

Dual-purpose sprint: (1) close three small, independent, already-documented gaps in
claude-delegate-mcp, and (2) generate real, evidence-based data on whether delegating tasks
through claude-delegate-mcp's own `delegate_task`/`delegate_submit` tools is worth doing versus
a native Claude Code subagent — by actually using both mechanisms side by side on
comparable-complexity work.

## Global Constraints (bind every task)

- Do not modify: any of the 6 MCP tools' schemas, `docs/FOUNDATION_FREEZE.md`,
  `docs/OBSERVABILITY_FREEZE.md` guarantees, `RuntimeEventBus`'s `{publish, subscribe,
  subscribeAll}` contract, the Job lifecycle enum, `ExecutionContext`'s shape. No new MCP tools.
- TDD required: write a failing test first, then implement, then confirm green — for every
  functional change.
- `npm test` must show 0 failures both before your change and after — the full suite, not just
  your new tests.
- No new production dependencies.
- Match existing code style exactly (JSDoc conventions, `logger?.warn?.()` defensive pattern,
  fail-safe I/O — a workspace/logging write failure must never affect the caller's result).
- Do NOT touch CHANGELOG.md, README.md, or docs/ARCHITECTURE.md — the controller reconciles
  documentation centrally after all three tasks land, to avoid merge conflicts between tasks
  running concurrently on the same branch.
- Commit your own work when done (`git add` the specific files you touched — never `git add -A`
  or `.`). Do not amend or rebase.

## Task 1 — ConsumerRegistry stale-consumer pruning

**Files**: `src/services/consumerRegistry.js`, `tests/consumerRegistry.test.js` only.

**Problem**: `ConsumerRegistry` has no auto-expiry (documented, accepted limitation in
`docs/releases/KNOWN_LIMITATIONS.md`) — a consumer that registers and never calls
`unregister()` lingers indefinitely.

**Requirements**:
1. Add a new method `pruneStale(maxAgeMs)`: removes every consumer whose `lastSeenAt` is older
   than `maxAgeMs` milliseconds before the current time. Returns the number of consumers
   removed (a plain number).
2. Do not change the behavior of any existing method (`register`, `unregister`, `touch`,
   `list`, `getHealth`, `getStatistics`).
3. `getStatistics()`'s `totalRegistered` stays all-time (never decremented) — pruning affects
   only `activeCount`, matching the exact semantics `unregister()` already has.
4. TDD: write tests first in `tests/consumerRegistry.test.js`, following that file's existing
   style exactly. Cover: a stale consumer (registered/touched long ago) is pruned; a fresh
   consumer is not; the returned count matches how many were actually removed; `getStatistics()`
   reflects the change after pruning.

**Out of scope**: wiring this into `ObservabilityService`'s public API — that's a separate,
future task. This task is the registry primitive only.

## Task 2 — MetricsCollector artifact-count directory filtering (verified defect)

**Files**: `src/services/metricsCollector.js`, `tests/metricsCollector.test.js` only.

**Problem** (verified, documented Low-severity finding, `docs/CERTIFICATION_REPORT_v1.md`):
`getWorkspaceUsage()`'s artifact-count walk does not filter which subdirectories of
`workspace/jobs/` it treats as job directories the way `workspaceManager.js`'s
`pruneWorkspaces()` already does (via `isValidJobId()`). Not a security issue (directory names
come from `readdirSync()` itself, never external input) — a real accuracy gap: any
non-UUID-named directory manually placed under `workspace/jobs/` gets its contents
miscounted as "artifacts."

**Requirements**:
1. Import `isValidJobId` from `./workspaceManager.js` (reuse — do not reimplement the UUID
   check).
2. In the artifact-count loop, skip any directory entry whose name fails `isValidJobId()`.
3. Do NOT change `workspaceSizeBytes`'s behavior — that metric intentionally sums everything
   under `jobsRoot` by design; only the artifact-count directory-selection loop changes.
4. TDD: write a regression test first in `tests/metricsCollector.test.js` proving a directory
   named e.g. `"notes"` (not a valid job id) under `workspace/jobs/` is excluded from
   `artifactCount` even if it contains files, while a real UUID-named directory's artifacts
   still count.

## Task 3 — Debug Mode: make delegate_cancel actually stop a running job

**Files**: `src/services/debugInvoke.js`, `src/debug/debugRunner.js`, `tests/debugInvoke.test.js`,
`tests/debugRunner.test.js` only.

**Problem** (documented known limitation, README.md/ARCHITECTURE.md/CHANGELOG.md v2.1.0):
`delegate_cancel` cannot forcibly stop a Debug Mode job — the CLI subprocess is owned by a
detached runner process the main server holds no handle to.

**Requirements**:
1. `invokeInDebugMode()` currently has no `signal` parameter (unlike production `invoke()`,
   which already accepts `{signal}` for `AbortController`-based cancellation — see
   `claudeCliService.js`). Add one, matching the same calling convention.
2. When the signal aborts while polling for `response.json`: stop waiting immediately and
   reject with an `AbortError`-named error (matching production's existing abort semantics —
   see `spawnAndCollect`'s `err.name !== "AbortError"` check for the exact shape to match) —
   do not wait out the remaining timeout budget.
3. On abort, also write a sentinel file (`<logsDir>/cancel.request`, empty content is fine) so
   `debugRunner.js` — which owns the actual `claude` child process the parent has no handle to
   — can detect the cancellation and kill its own child. `debugRunner.js`'s `runDebugJob()`
   needs a lightweight, injectable way to check for this sentinel periodically while its
   `spawnAndCollectFn` promise is pending (a `setInterval` poll checking `existsSync` is
   sufficient — this mirrors the same file-based signaling `debugInvoke.js` already uses to
   read `response.json`, not a new mechanism).
4. When the sentinel is detected mid-run, `debugRunner.js` must actually terminate its spawned
   child process tree — reuse `shouldCleanupProcessTree`/the Windows `taskkill /t /f` approach
   already in `claudeCliService.js` (export what's needed rather than reimplementing it).
5. TDD: write tests first covering (a) aborting an in-flight `invokeInDebugMode()` call rejects
   promptly (well before the configured timeout) with an AbortError-shaped error; (b) the
   sentinel file is written on abort; (c) `runDebugJob()`, given an injected long-running fake
   `spawnAndCollectFn` and a way to simulate the sentinel appearing mid-run, actually invokes
   its child-kill path (inject and assert on a fake kill function — do not spawn a real process
   in this test).
6. Preserve: Debug OFF is unaffected; all 26 existing Debug Mode tests keep passing.

**Out of scope**: changing `delegate_cancel`'s MCP-facing behavior/response shape, or
`JobManager.cancelJob()`'s existing logic for the non-debug path — this task only makes Debug
Mode observe the SAME cancellation signal production already wires through
(`JobManager.cancelJob()` already calls `controller.abort()`; this task is about
`claudeCliService.invoke()`'s debug branch actually passing that signal through to
`invokeInDebugMode()`, which it currently drops).

## Execution Notes (for the controller, not the implementers)

- Tasks 1, 2, 3 touch disjoint files — verified independent. Dispatched in parallel per
  `dispatching-parallel-agents`, with `subagent-driven-development`'s per-task review gate
  applied to each. (`subagent-driven-development`'s general "never parallel implementers"
  caution is about avoiding file/edit conflicts on a shared task list where tasks often share
  state; these three were deliberately chosen not to.)
- Task 1 dispatched via `delegate_submit` (cheap/mechanical work, non-blocking).
- Task 2 dispatched via a native Claude Code subagent (same complexity class as Task 1 —
  direct comparison data point).
- Task 3 dispatched via `delegate_task` (bigger, more judgment-heavy — a second, different
  comparison data point at higher complexity).
- All timing, cost, approval-prompt, and retry data for the `delegate_*`-dispatched tasks is
  recorded for `DELEGATE_VALUE_REPORT.md`.
