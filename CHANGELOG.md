# Changelog

## [1.7.0] - 2026-07-13

Streaming Activation & Protocol Validation
([ADR-0002](docs/adr/ADR-0002-streaming-and-event-architecture.md#observed-protocol-v170--real-captures-not-assumptions) —
"Observed protocol" section).

### Added
- **Real protocol capture**: two live `claude -p --output-format stream-json --verbose`
  captures (one auth-failure path, one successful task on a real account) used to validate
  ADR-0002's assumptions before activating anything. Key finding: the terminal `type:"result"`
  line is field-for-field identical to the old non-streaming `--output-format json` output —
  confirmed, not assumed, in both captures.
- **`--output-format stream-json --verbose` is now `buildArgs()`'s default.** (`--verbose` is
  required by the CLI itself when streaming — discovered via a real error message.)
- **`createStreamJsonTracker()`** (`claudeCliService.js`): incrementally parses stdout via
  `streamJsonParser.js`, captures the terminal result line to reconstruct `raw` for
  `parseResult()` (gracefully falls back to `parsed: null` if none was ever seen), and
  publishes real `JobProgress` for the two categories a capture confirmed both exist and are
  useful: `system/thinking_tokens` (live token-count ticks during extended thinking) and
  `assistant` events carrying a `text` content block. Deliberately does not surface hook/
  session bookkeeping, rate-limit telemetry, or the model's raw `thinking` content.
- 10 new tests (`tests/claudeCliServiceStreamJson.test.js`) using the real observed line
  shapes: progress-per-category, silence for non-progress types, malformed-line recovery,
  chunk-boundary reassembly, concurrent-job isolation, standalone (no-bus) safety.
- **Live end-to-end verification**: a real `delegate_task` call produced 17 genuine
  `notifications/progress` pushes (`"Job running"` → 15× `"Thinking… (~N tokens)"` → the
  actual response text → `"Job completed"`) while returning a response byte-compatible with
  the pre-streaming format.

### Also observed (documented, not acted on)
- `result.subtype` can be `"error_max_budget_usd"` with an `errors: [...]` array — the CLI's
  own cost tracking can spend slightly over `max_budget_usd` before stopping. Pre-existing
  CLI behavior, not a regression from this change; noted in the ADR's risk table.
- Not yet observed: `tool_use`/`tool_result` content blocks, multi-turn behavior. The tracker
  only branches on confirmed shapes — anything else is silently skipped, never guessed at.

### Compatibility
Zero MCP schema change — all 6 tools re-verified byte-identical via Inspector. `delegate_task`
response shape verified twice: once via the full test suite (95/95 passing), once live
against the real CLI. `RuntimeEventBus` contract, `FOUNDATION_FREEZE.md`, and `JobManager`'s
public methods untouched.

## [1.6.0] - 2026-07-13

RuntimeEventBus & Streaming Foundation
([ADR-0002](docs/adr/ADR-0002-streaming-and-event-architecture.md), amended in this wave —
see its Amendment Log).

### Added
- **`RuntimeEventBus`** (`src/services/runtimeEventBus.js`): implementation-independent
  `{publish, subscribe, subscribeAll}` contract; default backed by `node:events`, but that
  import is confined to this one file — no other module depends on `EventEmitter` directly.
  Per-listener isolation (a throwing subscriber is logged and skipped, never affects siblings
  or the publisher).
- **10 event types** (`src/models/runtimeEvent.js`): `JobQueued`, `JobStateChanged` (replaces
  the originally-proposed `JobStarting`/`JobRunning` — a state transition isn't progress, but
  `starting`/`running` don't need distinct types either, since neither carries a distinct
  payload), `JobProgress`, `OutputChunk` (replaces `StdoutReceived`/`StderrReceived` — same
  shape, differ only by a `stream` field), `JobCompleted`, `JobFailed`, `JobCancelled`,
  `ArtifactCreated`, `WorkspaceCreated`, `WorkspaceDeleted`. Every transition publishes
  exactly one event type — mechanically verifiable "no duplicate events" (see tests).
- **`JobManager`** now publishes a `RuntimeEvent` at every transition (`bus` is
  constructor-injected, defaulted if not given — fully backward compatible with every
  existing test construction).
- **`execFile` → `spawn()` migration** in `claudeCliService`: incremental stdout/stderr via
  `OutputChunk` events, manually re-implemented `maxBufferBytes` enforcement (spawn has no
  native `maxBuffer`), preserved `invoke()`'s resolved shape and error semantics exactly.
  Transport mechanics extracted into a new `spawnAndCollect()`, decoupled from
  claude-specific `buildArgs()` — this is what made it possible to test real `spawn()`
  behavior (abort, timeout-equivalent kill, maxBuffer, ENOENT) against `node` itself instead
  of only through stubs.
- **`streamJsonParser.js`**: incremental newline-delimited JSON parser for
  `stream-json`, built and unit-tested (multi-chunk line reassembly, malformed-line handling)
  but **not wired into the live `--output-format` argument** — see Deferred below.
- **Workspace is now bus-driven** (`workspaceEventBridge.js`): terminal-side persistence
  (`persistJobArtifacts`/`pruneWorkspaces`) subscribes to `JobCompleted`/`JobFailed`/
  `JobCancelled` instead of being called directly from `delegationService`.
- **MCP progress notifications** (`mcpProgressAdapter.js`): `delegate_task` forwards its
  job's lifecycle events as `notifications/progress` when the caller supplies
  `_meta.progressToken` (verified against the installed MCP SDK's actual API). Purely
  additive — a caller that doesn't request progress sees no behavior change.
- 43 new tests: 6 new files (`runtimeEventBus`, `jobManagerEvents` — ordering/no-duplicates/
  concurrency, `streamJsonParser`, `claudeCliServiceSpawn` — 11 tests against real child
  processes, `workspaceEventBridge`, `mcpProgressAdapter`) plus 2 new cases in the existing
  integration suite (progress-notification forwarding, with/without a `progressToken`).
  Total: 85 tests, up from 42.

### Deliberately deferred (see ADR-0002 for full reasoning)
- `stream-json` is not the live `--output-format` — the parser is built and tested, but
  switching the argument a frozen response shape depends on isn't verifiable against a real,
  logged-in CLI session in this environment, and an unverified guess isn't an acceptable risk.
- `createJobWorkspace()` stays a direct call, not bus-wired — a **security-motivated**
  boundary: it needs the unredacted `ExecutionContext` (`environment`/`process.env`), which
  must never be duplicated into `JobManager`'s job record (`job.metadata` is returned
  verbatim in `delegate_status`'s MCP response).
- `OutputChunk` is not forwarded to MCP progress notifications — too high-frequency for a
  protocol channel; no production subscriber for it exists yet at all.
- Dashboard and plugin consumers: explicitly out of scope, "just" future bus subscribers.

### Compatibility
Zero change to any MCP tool schema — all 6 tools re-verified byte-identical via Inspector
against the pre-wave snapshot. `delegate_task`/`delegate_submit` response shapes unchanged.
Live end-to-end run against the real `claude.exe` confirmed the full pipeline (spawn,
OutputChunk, workspace persistence, stderr capture) still works correctly. 85 tests total,
all passing.

## [1.5.0] - 2026-07-13

Foundation Freeze certified ([docs/FOUNDATION_FREEZE.md](docs/FOUNDATION_FREEZE.md)) plus the
Workspace & Artifact wave ([ADR-0001](docs/adr/ADR-0001-workspace-and-artifact-architecture.md)).

### Added
- **Workspace persistence layer** (`src/services/workspaceManager.js`): every job gets
  `<workspaceRoot>/jobs/<job-id>/{metadata.json, context.json, stdout.log, stderr.log,
  result.json, artifacts/}`, written once at settle time as a best-effort mirror of
  `JobManager`'s state — never a second source of truth. Wired into the shared
  `delegationService.submitDelegation()`, so both `delegate_task` and `delegate_submit` get
  it identically with no duplicated logic.
- Two new config fields: `workspaceRoot` (`CLAUDE_DELEGATE_WORKSPACE_DIR`, default
  `<project>/workspace`) and `maxWorkspaceHistory` (`CLAUDE_DELEGATE_MAX_WORKSPACE_HISTORY`,
  default 100) — oldest completed workspaces beyond the cap are pruned automatically, never
  touching an in-flight job's directory.
- `claudeCliService.invoke()`'s resolved result gains a `stderr` field (previously discarded
  entirely) so it can be persisted to `stderr.log`.
- 13 new tests: `tests/workspaceManager.test.js` (unit — path-traversal rejection, context
  redaction, artifact writes, pruning) and 5 new integration tests (workspace creation,
  concurrent jobs get isolated directories, failed/cancelled jobs persist correctly, pruning
  under load).

### Fixed (test hygiene, found while wiring this wave)
- The integration test suite was writing real job directories into the project's own
  `workspace/` folder (no `workspaceRoot` override) — fixed by pointing tests at an isolated
  `os.tmpdir()` location, cleaned up via `node:test`'s `after()`.

### Security
- `isValidJobId()` rejects any non-UUID string before it's used to build a filesystem path
  (defense in depth — job ids are always `JobManager`-generated `randomUUID()` output).
- `context.json` never contains `ExecutionContext.environment` (`process.env`) — redacted to
  a placeholder string, since persisting it verbatim would write secrets to disk.
- All workspace I/O is wrapped to fail safe: a write/prune error is logged and swallowed,
  never surfaces as a tool error or affects a job's actual outcome.

### Compatibility
Zero change to any MCP tool schema, `ExecutionContext`'s shape, or `JobManager`'s public
methods — re-verified via Inspector (`tools/list` byte-identical to the pre-wave snapshot)
and a live end-to-end `delegate_task` call (workspace files confirmed written for a real,
non-stubbed job).

## [1.4.3] - 2026-07-13

Zero-defect hardening pass (second consecutive audit; see 1.4.2 for the first).

### Fixed
- **Duplicated model/effort constants**: `["haiku","sonnet","opus","fable"]` and
  `["low","medium","high","xhigh","max"]` were each hand-typed twice — once in
  `schemas.js`'s zod enum, once in `delegateModelsHandler.js`. Exported `MODELS`/`EFFORTS`
  from `schemas.js` as the single source; the handler now imports them. Regression test
  asserts the schema's enum options and the handler's listing both derive from the same array.
- **Dead config field**: `config.readonlyTools` was computed by `loadConfig()` but never
  read anywhere (`schemas.js` already imported the `READONLY_TOOLS` constant directly) —
  same class of defect as `maxBufferBytes` fixed in 1.4.2. Removed.

### Verified, not changed
Re-audited for TODO/FIXME/HACK markers, `shell: true`, `eval`/`exec`/insecure-randomness
patterns, and unreachable exports — none found. `DelegateError` (base class of `ConfigError`)
has no direct call sites but is an active, used superclass, not dead code.

## [1.4.2] - 2026-07-13

Self-Harness-style audit of the current implementation (no PR existed to review — see below).

### Fixed
- **Documentation drift in live tool descriptions**: `delegate_status`, `delegate_history`,
  `delegate_cancel`, and the shared `job_id` field description still said "delegate_task job"
  and omitted the `starting` status — stale since `delegate_submit` and `starting` were added
  in 1.4.0. These are LLM-facing strings read via `tools/list`, not just human docs. Fixed;
  `delegate_task`'s own schema re-verified unchanged.
- **Dead/duplicated config**: `config.maxBufferBytes` was computed but never read —
  `claudeCliService.js` had its own separate hardcoded `MAX_BUFFER_BYTES` constant instead
  (confirmed via grep). Extracted a testable `buildExecOptions()` so config is the actual
  source of truth again, with a regression test proving it.
- **Inconsistent error-handling coverage in `JobManager._run()`**: the `starting` transition's
  store write happened before the try/catch that covers every other transition, so a store
  failure there would be an unhandled rejection (`_drain()` calls `_run()` without awaiting or
  `.catch()`ing it) — currently benign only because `InMemoryJobStore` never throws, but the
  architecture explicitly anticipates a swappable/persistent store that could. Moved inside
  the try; regression test simulates a throwing store and confirms the job now lands in
  `failed` instead of hanging silently at `queued`.
- **`_trimHistory()` duplicated work**: re-called `store.list()` (O(n)) on every eviction-loop
  iteration instead of tracking a decrementing count, making a bulk eviction O(n²). Fixed to
  a single O(n) pass; also closes a real test-coverage gap — this eviction feature (since
  1.2.0) had zero prior tests.

### Note
`/review`'s invocation named a GitHub PR `Use` to diff — no such PR exists (repo has no
remote; confirmed via `git remote -v`/`gh pr view`). Reviewed the current implementation
(local commits) instead, per user confirmation.

## [1.4.1] - 2026-07-13

### Fixed
- **`max_budget_usd` accepted zero/negative values** — added `.positive()` to the zod schema
  (`delegate_task`/`delegate_submit`, shared shape). Minor, backward-compatible schema
  tightening: default unchanged, no legitimate caller was ever relying on a non-positive
  budget. Verified via `tools/list` diff — only this field's JSON Schema changed.
- **Orphaned subprocess on Windows cancellation/timeout** — killing `claude.exe` (via
  `AbortSignal` or the CLI call's `timeout`) did not kill any child process it had spawned
  (Windows has no POSIX process groups), which could leak a running process past job
  cancellation. `claudeCliService.invoke()` now runs a best-effort `taskkill /t /f` on the
  whole process tree when this applies (win32 + aborted/force-killed) via the new, unit-tested
  `shouldCleanupProcessTree()` predicate.

## [1.4.0] - 2026-07-13

### Added
- **`delegate_submit`**: same input schema as `delegate_task`, but returns immediately
  (`{ success, job_id, status }`) instead of waiting for the job to finish.
- **`ExecutionContext`** (`src/models/executionContext.js`): the single object
  `claudeCliService.buildArgs()`/`invoke()` now consume (model, effort, timeoutMs,
  workingDirectory, allowedTools, trustAll, maxBudgetUsd, metadata, environment) — built once
  by the new shared `src/services/delegationService.js`, used by both `delegate_task` and
  `delegate_submit` so neither duplicates context-building or job-submission logic.
- **`starting` job status**, inserted between `queued` and `running`. `running` is now
  reached via a real signal — Node's child_process `'spawn'` event — not assumed the instant
  a job is dequeued.
- **`phase` / `progressMessage`** fields on every job (static per-phase text, e.g.
  `"executing"` / `"Executing claude CLI"`). No streaming — just metadata ready for a future
  incremental-progress feature to update without a schema change.
- **Continuous runtime tracking**: `models/job.js`'s `deriveRuntimeMs()`/`toJobView()` compute
  live elapsed time for in-flight jobs (verified end-to-end: `runtime=15ms` while running,
  final `runtimeMs=5091` once completed) instead of `null` until the job finishes.
- `delegate_cancel` now also aborts jobs in the `starting` phase (previously only
  `queued`/`running` were handled).
- Integration test suite (`tests/asyncExecution.integration.test.js`): full submit → status →
  history → cancel(queued) → cancel(running) → completed lifecycle, plus explicit checks that
  `delegate_task` still blocks with an unchanged response shape and that `delegate_submit`
  never blocks regardless of task duration.

### Changed
- `claudeCliService.buildArgs()`/`invoke()` signature changed from `(input, config)` to
  `(prompt, context, config)` — an internal refactor to consume `ExecutionContext`, not a
  behavior change. `delegate_task`'s external contract (name, schema, response shape,
  blocking behavior) is unchanged and was re-verified via `tools/list` diffed byte-for-byte
  against the Sprint 3 snapshot, plus a live end-to-end run.

## [1.3.0] - 2026-07-13

### Added
- Four new MCP tools, all backed by the existing `JobManager`/`claudeCliService` (no
  duplicated logic): `delegate_status` (look up a job by id), `delegate_history` (list
  recent jobs, filterable by status), `delegate_models` (list model tiers, fallbacks,
  effort levels, defaults), `delegate_cancel` (cancel a queued or running job).
- `delegate_task` now submits through the shared `JobManager` instead of calling
  `claudeCliService` directly, so the new tools have real job data to report. Its external
  contract — name, schema, response shape, synchronous blocking behavior — is unchanged;
  verified via `tools/list` and an end-to-end multi-tool session before/after.
- `JobManager.waitForCompletion()` and history eviction (`maxJobHistory`, default 500, via
  `CLAUDE_DELEGATE_MAX_JOB_HISTORY`) so the in-memory job store doesn't grow unbounded.

### Fixed
- **Command injection risk removed.** The CLI was being spawned via the `claude.cmd` shim
  with `shell: true` (required to work around Windows EINVAL on `.cmd` files), which passed
  `prompt` — arbitrary, caller-controlled text — through cmd.exe without safe escaping
  (flagged by Node's own `DEP0190` warning). Fixed by spawning the real `claude.exe`
  directly with no shell at all; `CLAUDE_DELEGATE_BIN` now defaults to that executable.
  Regression test added (`buildArgs keeps prompt as a single literal argv entry`).

## [1.2.0] - 2026-07-13

### Added
- Internal job manager (`src/services/jobManager.js`): submit/get/list/cancel, in-memory
  `Job` records (`src/models/job.js`) with status lifecycle (queued/running/completed/
  failed/cancelled), timestamps, runtime, exit code, metadata, result/error.
- Bounded concurrency queue (`CLAUDE_DELEGATE_MAX_CONCURRENT_JOBS`, default 2).
- Storage seam for future persistence (`src/services/jobStore.js`'s `InMemoryJobStore`) —
  swap the `store` dependency to persist without touching `JobManager`.
- `claudeCliService.invoke()` now accepts an `AbortSignal` so a cancelled job can actually
  kill its subprocess.
- Unit tests for the full job lifecycle, cancellation (queued and running), and concurrency
  limiting (`tests/jobManager.test.js`).

### Unchanged
- `delegate_task` remains fully synchronous and is not wired to the job manager yet — no new
  MCP tool was added this sprint.

## [1.1.0] - 2026-07-13

### Changed
- Refactored into a layered `src/` structure (server/handlers/services/cli/config/models/utils/logging/validation). No change to the `delegate_task` tool schema, defaults, or observed behavior — verified via `tools/list`/`tools/call` before and after.
- `server.js` is now a thin backward-compatible shim; `claude_desktop_config.json` does not need to change.

### Added
- Structured JSON logging to stderr (`src/logging/logger.js`).
- Startup config validation (`src/validation/configValidation.js`).
- Non-blocking health check for the configured `claude` binary (`src/server/health.js`).
- Graceful shutdown on SIGINT/SIGTERM.
- `VERSION` constant sourced from `package.json`.
- Unit tests (`node --test`) for arg-building, config validation, and the input schema.

## [1.0.0] - 2026-07-12
- Initial single-file `delegate_task` MCP server.
