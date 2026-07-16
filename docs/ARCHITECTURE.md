# Architecture

Nine MCP tools split by concern so each piece is independently testable.

```
server.js               backward-compat entrypoint (claude_desktop_config.json points here)
src/
  cli/entry.js           boot sequence: load config, validate, health check, start server, graceful shutdown
  server/mcpServer.js     builds the McpServer instance, owns the shared JobManager, registers all 9 tools
  server/health.js        non-blocking check that the configured claude binary exists
  handlers/                one file per tool: MCP-shaped request/response formatting
  services/delegationService.js  shared submit path: builds an ExecutionContext, calls jobManager.submit(),
                                    creates the job's workspace directly (see Workspace section for why)
  services/claudeCliService.js   arg-building + spawn()-based CLI delegation, OutputChunk emission
  services/jobManager.js  background task runner: queueing, concurrency, cancellation, lifecycle, progress
  services/jobStore.js     storage interface for Job records (in-memory today, swappable)
  services/runtimeEventBus.js  RuntimeEventBus contract + default (EventEmitter) implementation
  services/workspaceManager.js  per-job on-disk artifact mirror (metadata/context/stdout/stderr/result)
  services/workspaceEventBridge.js  subscribes workspace's terminal-side persistence to the bus
  services/mcpProgressAdapter.js  forwards a job's bus events as MCP notifications/progress
  services/observabilityService.js  read-only bus.subscribeAll() consumer; metrics/timeline/replay/snapshot/consumers (ADR-0003)
  services/metricsCollector.js  O(1) incremental job metrics + on-demand workspace usage
  services/timelineStore.js  per-job bounded, ordered event history
  services/replayEngine.js  read-only job-history reconstruction (runtime -> workspace -> unavailable)
  services/snapshotBuilder.js  immutable point-in-time metrics+activeJobs snapshots
  services/consumerRegistry.js  in-memory consumer registration/health/statistics bookkeeping
  services/streamJsonParser.js  incremental stream-json line parser (pure, reused by claudeCliService's tracker)
  services/debugInvoke.js  Debug Mode (DELEGATE_DEBUG=true) execution path — visible terminal + full logs
  services/debugTerminalLauncher.js  per-OS visible-terminal detection/launch, argv-safe (never shells the prompt)
  debug/debugRunner.js   runs inside the visible terminal; reuses buildArgs/spawnAndCollect/parseResult
  models/schemas.js       zod input schema for delegate_task/delegate_submit (the public tool contract)
  models/executionContext.js  ExecutionContext shape + factory — the CLI service's only input besides prompt
  models/job.js            Job shape, status enum, phase/progress metadata, summarizeJob()/toJobView()
  models/runtimeEvent.js  EVENT_TYPES enum + RuntimeEvent shape (ADR-0002)
  config/                 env-driven config loading + version constant
  validation/              startup config sanity checks
  logging/logger.js       structured JSON logs to stderr (stdout is reserved for MCP protocol frames)
  utils/errors.js         shared error types + MCP error-response formatting
tests/                    node:test unit + integration tests (no external test framework)
```

## Tool relationships

```
delegate_task  ─┐                                        delegate_status ──┐
                ├─> submitDelegation() ─> JobManager.submit() ─> Job store <─┼─ delegate_history
delegate_submit ┘         (ExecutionContext + claudeCliService.invoke)      └─ delegate_cancel

delegate_models — pure config introspection, does not touch JobManager or the CLI at all.
```

`delegate_task` and `delegate_submit` accept the *same* input shape and both go through the
same `submitDelegation()` helper (`services/delegationService.js`) — the only difference is
what happens after `jobManager.submit()` returns a job id:

- **`delegate_task`** calls `jobManager.waitForCompletion(jobId)` and blocks until the job is
  terminal, then formats the CLI result exactly as it did before this sprint (schema,
  response shape, and blocking behavior all unchanged — see the Security/verification notes
  below).
- **`delegate_submit`** returns immediately with `{ success: true, job_id, status }` — it
  never calls `waitForCompletion`.

Either way, the job lands in the same `JobManager`/store, so `delegate_status`,
`delegate_history`, and `delegate_cancel` work identically regardless of which tool created
the job. This is what "JobManager remains the single source of truth" means concretely: there
is exactly one write path into the job store (`JobManager.submit()` → `_run()` → `_transition()`),
never a second one bypassing it.

## Job lifecycle

```
queued ──> starting ──> running ──> completed
   │           │           │
   │           │           └──> failed      (task threw)
   │           └──────────────> cancelled   (aborted before markRunning fired)
   └──────────────────────────> cancelled   (removed from the queue, never ran)
```

- **queued**: created by `submit()`, sitting in `pending` until a concurrency slot frees up.
- **starting**: dequeued, subprocess about to spawn. `startedAt` is set here and never reset —
  runtime is measured continuously from this point through to the terminal state.
- **running**: the task calls `markRunning()` once real execution has begun. For
  `claudeCliService.invoke()` this fires on Node's actual `'spawn'` event for the child
  process, not a guess — so "running" means the OS has genuinely started the CLI.
- **completed / failed / cancelled**: terminal. `finishedAt` and the final `runtimeMs` are set
  once and never touched again — completed jobs are immutable, per spec (`cancelJob()` on a
  terminal job always returns `false`).

Every job also carries a `phase` and `progressMessage` field mirroring the status above
(`"queued"`/`"Waiting in queue"`, `"starting"`/`"Spawning claude CLI subprocess"`,
`"executing"`/`"Executing claude CLI"`, etc.) for the STARTING/QUEUED/terminal transitions.
While a job is actually running, `progressMessage` is now live (v1.7.0) — see "Streaming
(stream-json)" below — reflecting real `stream-json` content (`"Thinking… (~N tokens)"`, then
the response text) via `JobProgress` events, not the static per-phase placeholder text.

`runtimeMs` is "tracked continuously" in the sense that a client polling `delegate_status`
mid-run sees live elapsed time (`models/job.js`'s `deriveRuntimeMs()` computes
`Date.now() - startedAt` for any non-terminal job) rather than a stale `null` until
completion — verified in the Sprint 4 end-to-end test (`runtime=15ms` while running, final
`runtimeMs=5091` once completed).

## ExecutionContext

`models/executionContext.js` is the one object the CLI layer actually consumes — `model`,
`effort`, `timeoutMs`, `workingDirectory`, `allowedTools`, `trustAll`, `maxBudgetUsd`,
`metadata`, `environment`. `claudeCliService.buildArgs()`/`invoke()` take `(prompt, context,
config)`, never a raw tool-input object — so a future third submission path (a different
schema, a scheduled job, whatever) only needs to build an `ExecutionContext`, not touch the
CLI service at all.

## Job manager

`services/jobManager.js` runs arbitrary async tasks (`(signal, markRunning) =>
Promise<result>`) in the background with a bounded concurrency queue (`maxConcurrentJobs`,
default 2), tracking each as a `Job` (`models/job.js`).

- Storage is behind `services/jobStore.js`'s `InMemoryJobStore` — a future persistent store
  (SQLite, etc.) implements the same four methods (`create`/`get`/`update`/`list`) and is
  passed in via `new JobManager({ store })`; nothing else changes.
- History is capped (`maxJobHistory`, default 500): oldest terminal jobs are evicted once
  the store exceeds the cap; queued/starting/running jobs are never evicted.
- `waitForCompletion(id)` resolves once a job reaches a terminal status — this is what lets
  `delegate_task` stay synchronous while still going through the same job system as
  `delegate_submit`.

## RuntimeEventBus & events

See [ADR-0002](adr/ADR-0002-streaming-and-event-architecture.md) for the full design,
event schema, and streaming-strategy rationale. Summary: `RuntimeEventBus` is a
`{publish, subscribe, subscribeAll}` contract (`services/runtimeEventBus.js`) — its default
implementation happens to use `node:events`, but that import is confined to that one file.
`JobManager` owns one shared `bus` instance (constructor-injected, defaulted if not given)
and publishes a `RuntimeEvent` at every state transition; `claudeCliService.invoke()`
publishes `OutputChunk` as stdout/stderr arrive. Subscribers (workspace persistence, the MCP
progress adapter, and any future consumer) never touch `JobManager` or `claudeCliService`
directly — they just subscribe to the bus `mcpServer.js` wires up once at boot.

## Streaming (stream-json)

Activated in v1.7.0 after real protocol capture — see [ADR-0002](adr/ADR-0002-streaming-and-event-architecture.md#observed-protocol-v170--real-captures-not-assumptions)
for the full evidence. `buildArgs()` always passes `--output-format stream-json --verbose`
(the latter is required by the CLI itself). `claudeCliService.js`'s
`createStreamJsonTracker()` consumes stdout chunks incrementally via
`streamJsonParser.js`'s pure line-buffering parser, and:
- Captures the terminal `type:"result"` line (confirmed field-for-field identical to the old
  non-streaming `json` format) to reconstruct `raw` for `parseResult()` — `delegate_task`'s
  response shape is unaffected by the transport change.
- Publishes `JobProgress` only for `system/thinking_tokens` and `assistant` events carrying a
  `text` content block — the two categories a real capture confirmed both exist and are
  useful. Everything else (hook/session bookkeeping, rate-limit telemetry, the model's raw
  `thinking` content, and any unrecognized future shape like `tool_use`) is silently skipped,
  never guessed at.

## Debug Mode (development only)

Opt-in (`DELEGATE_DEBUG=true`, default off), entirely additive to `claudeCliService.invoke()` —
when off (the default), `invoke()`'s existing hidden-pipe code path is untouched, byte-for-byte,
which is why every pre-existing test still passes unmodified.

**Why this needed care, not just code**: this whole project's one hard security invariant is
that `prompt` (arbitrary, caller-controlled text) never touches a shell (see "Security: no
shell in the CLI spawn" below). Opening a *visible terminal* naturally means invoking some
terminal host (`wt.exe`, `cmd.exe`, a Linux emulator, `Terminal.app`) — exactly the kind of
shell-adjacent surface that invariant exists to avoid. The design keeps the invariant intact
structurally, not by convention:

- **`debugTerminalLauncher.js`**: `buildLaunchInvocation()` is a pure function whose output
  never includes the prompt — only a job id (`randomUUID()`, never user content) and
  filesystem paths this process itself constructed. `launchDebugTerminal()` always spawns with
  `shell: false`. Per OS: Windows Terminal (`wt.exe new-tab --`) preferred, `cmd.exe`'s
  `start ""` (empty title — the documented idiom for avoiding `start` mistaking a spaced
  program path for the title) as fallback; the detected Linux terminal emulator's `-e`/`--`
  convention; `open -a Terminal --args` on macOS. Every one of these passes the launched
  command as a real argv array, never a string a shell re-parses.
- **`debug/debugRunner.js`**: runs *inside* the visible terminal, invoked as
  `node debugRunner.js <path-to-invocation.json>` — its only argv is a file path, never the
  prompt. Reads the prompt from `invocation.json` (written by `debugInvoke.js` before the
  terminal opens), then reuses the exact same production building blocks (`buildArgs`,
  `buildExecOptions`, `spawnAndCollect`, `parseResult`) to actually run `claude` — this is not
  a second implementation of CLI invocation, only a differently-observed one. Tees stdout/stderr
  to both the visible console and log files, incrementally parses stream-json (reusing
  `parseStreamJsonChunk`) to write timestamped, ordered entries to `stream.jsonl`, and writes
  `response.json`/`metadata.json` on completion — including on failure, so the parent's poll
  never hangs. `environment` is never written to `invocation.json` (same redaction principle as
  `context.json`): the runner inherits the real environment naturally, since it's a descendant
  of the MCP server process, spawned with env inherited by default at every hop — functionally
  identical to `createExecutionContext()`'s `environment: process.env`.
- **`debugInvoke.js`**: `invokeInDebugMode()` creates `workspace/jobs/<job-id>/logs/`, writes
  `prompt.txt` + `invocation.json`, launches the terminal, then polls for `response.json` (the
  visible terminal's own host process returns almost immediately after requesting the window —
  its lifetime isn't tied to a simple child-process `close` event the way a normal spawn would
  be) while tailing `stream.jsonl` to keep publishing live `JobProgress` on the same
  `RuntimeEventBus`, exactly like the hidden-pipe path does (`classifyStreamJsonEvent()`,
  extracted from `createStreamJsonTracker` into `streamJsonParser.js`, is the shared decision
  both paths reuse — not two implementations of "which events matter").

**Cancellation**: because the actual `claude` subprocess is owned by a detached runner process
(so a debug session survives an MCP server restart), the parent (`invokeInDebugMode()`) has no
handle to kill it directly. Instead it observes the same `AbortSignal` production's `invoke()`
already threads through: on abort it writes a `<logsDir>/cancel.request` sentinel file, and
`debugRunner.js` polls for that sentinel (a lightweight `setInterval`, mirroring the same
file-based signaling already used for `response.json`) and converts its appearance into an
`AbortSignal` abort of its own, which routes through `spawnAndCollect`'s existing
`shouldCleanupProcessTree`/`killWindowsProcessTree` tree-kill — the same cleanup path production
cancellation already uses, not a second implementation of it.

**Verified live**, not just via mocked tests: a real `launchDebugTerminal()` call against a
(deliberately nonexistent) `claudeBin` path was observed to genuinely open a terminal, run the
runner, hit a real `ENOENT`, and correctly write `response.json` reflecting that failure — which
is also how the "terminal closes itself instantly on fast completion" limitation was found and
fixed (the runner now pauses for a keypress before exiting when attached to a real TTY).

## Observability

See [ADR-0003](adr/ADR-0003-observability-architecture.md) for the full design. Summary:
`ObservabilityService` is a *second, independent* `bus.subscribeAll()` consumer, alongside
`workspaceEventBridge`/`mcpProgressAdapter` — but unlike those two, it's an **observer**, not
a pipeline participant. The Passive Observation Rule makes this structural, not just
documented: `ObservabilityService` holds no reference to `JobManager`, `claudeCliService`, or
`bus.publish` — there is nothing in the object for a future change to accidentally call that
would mutate anything. Dependency direction is one-way (`RuntimeEventBus → Observability →
Dashboard → future consumers`); no consumer of `ObservabilityService` can reach back into
execution.

- `MetricsCollector`: O(1) incremental aggregates from `record(event)` — no stored history
  arrays. Workspace size/artifact count are the one on-demand exception, computed from disk
  via `workspaceManager.getWorkspaceRoot()` (reused, not re-derived) only when `getMetrics()`
  is called.
- `TimelineStore`: per-job append-only event list, deterministic order (bus dispatch is
  synchronous, Node is single-threaded — no reordering possible), bounded by
  `maxTimelineHistory` with the same oldest-*terminal*-first eviction shape
  `JobManager._trimHistory()`/`workspaceManager.pruneWorkspaces()` already use. An in-flight
  job's timeline is never evicted.
- Wired once in `mcpServer.js`, `maxTimelineHistory` defaulted to `config.maxJobHistory` (no
  new config field for Phase 1).
- `ReplayEngine`, `SnapshotBuilder`, `ConsumerRegistry` (Phase 2, v1.9.0) round out the
  platform: replay reconstructs a job's history (`runtime` full-fidelity while retained in
  `TimelineStore`, `durable` full-fidelity from `EventHistoryStore`'s on-disk log if
  `CLAUDE_DELEGATE_EVENT_HISTORY=file` was enabled — see
  [ADR-0006](adr/ADR-0006-persistent-event-history.md) — `workspace` coarse fallback via
  `metadata.json`, entries marked `synthetic: true`, or `unavailable` — read-only,
  deterministic, never duplicates stored data); snapshots are
  `structuredClone()` + recursively `Object.freeze()`d (`{takenAt, metrics, activeJobs}`,
  `activeJobs` sourced from `MetricsCollector.getActiveJobs()`, itself event-derived, never a
  `JobManager` query); `ConsumerRegistry` is pure in-memory registration/health/statistics
  bookkeeping with no transport layer of its own.
- `replay()` now has its first external consumer: the `delegate_replay` MCP tool
  ([ADR-0007](adr/ADR-0007-mcp-replay-access.md)), a thin transport adapter with no
  replay/filtering/persistence logic of its own. `getMetrics()` now has its own external
  consumer too: the `delegate_metrics` MCP tool ([ADR-0008](adr/ADR-0008-mcp-metrics-access.md)),
  an equally thin wrapper. `getSnapshot()` now has its own external consumer too: the
  `delegate_snapshot` MCP tool ([ADR-0009](adr/ADR-0009-mcp-snapshot-access.md)), an equally
  thin wrapper. Every other method (`getTimeline()`/`ConsumerRegistry`) is still not exposed
  via any MCP tool — Dashboard/REST API/plugin/future-MCP-tool consumption of those remains
  future work. Frozen public contracts: [OBSERVABILITY_FREEZE.md](OBSERVABILITY_FREEZE.md).

## Workspace (persistence layer)

See [ADR-0001](adr/ADR-0001-workspace-and-artifact-architecture.md) for the original design.
As of ADR-0002, terminal-side persistence is bus-driven: `workspaceEventBridge.js` subscribes
to `JobCompleted`/`JobFailed`/`JobCancelled`, refetches the full `Job` via
`jobManager.getJob(id)`, and calls `persistJobArtifacts()` + `pruneWorkspaces()`.
`createJobWorkspace()` (which writes `context.json`) is the one piece still called *directly*
from `delegationService.submitDelegation()`, not via the bus — deliberately: it needs the
unredacted `ExecutionContext` (including `environment`/`process.env`), which must never be
duplicated into `JobManager`'s job record, since `job.metadata` is returned verbatim in
`delegate_status`'s MCP response. Storing raw env vars there would leak secrets through the
protocol — the same class of leak `context.json`'s own redaction prevents at the disk layer.
The workspace remains a write-once mirror taken at settle time, never a second source of
truth for job state.

## Security: no shell in the CLI spawn

`claudeCliService.invoke()` spawns `config.claudeBin` directly via `spawn()` with no shell.
`config.claudeBin` must point at the real `claude.exe`, not the `.cmd`/`.bat` shim — spawning
a shim requires a shell (`shell: true`), and `prompt` is arbitrary, caller-controlled text
that a shell would parse for metacharacters (`&`, `|`, `` ` ``, etc.), which is a command
injection vector on Windows. With no shell, `prompt` is passed as one literal argv entry to
the child process and is never re-interpreted, regardless of its contents.

## Security: Windows process-tree cleanup

Windows has no POSIX process groups, so killing `claude.exe` (via cancellation's
`AbortSignal` or the `timeout` option) does not kill any child process *it* spawned (e.g. a
Bash tool call still running when the job was cancelled) — that child would otherwise be
orphaned. `claudeCliService.js`'s `shouldCleanupProcessTree()` decides when this applies
(win32 + aborted/force-killed), and `invoke()` runs a best-effort `taskkill /t /f` on the
whole tree in that case.

## Security: buffer growth protection

`execFile()` enforced `maxBuffer` natively; `spawn()` has no equivalent option, so
`claudeCliService.spawnAndCollect()` re-implements it manually — stdout/stderr accumulation
is checked against `config.maxBufferBytes` on every chunk, and the child is killed the moment
either stream exceeds it (verified in `tests/claudeCliServiceSpawn.test.js`). Losing this
during the `execFile` → `spawn` migration would have been a real regression, not just a
missing nice-to-have.

## Input validation

`max_budget_usd` (both `delegate_task` and `delegate_submit`) is `positive()` in the zod
schema — zero or negative values are rejected before a job is ever created.

## Security: workspace path safety

`workspaceManager.js`'s `isValidJobId()` rejects anything that isn't a UUID before it's ever
joined into a filesystem path — job ids are always `randomUUID()` output from `JobManager`,
so this is defense in depth, not a currently-reachable gap. Filenames within a job's
directory are fixed literals (`metadata.json`, etc.), never derived from job content. Every
workspace operation is wrapped so a failure (disk full, permissions, invalid id) is logged
and swallowed — it never affects a tool's response. `context.json` omits
`ExecutionContext.environment` (`process.env`, which may hold secrets).
