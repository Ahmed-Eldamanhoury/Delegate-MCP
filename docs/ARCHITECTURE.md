# Architecture

Six MCP tools split by concern so each piece is independently testable.

```
server.js               backward-compat entrypoint (claude_desktop_config.json points here)
src/
  cli/entry.js           boot sequence: load config, validate, health check, start server, graceful shutdown
  server/mcpServer.js     builds the McpServer instance, owns the shared JobManager, registers all 6 tools
  server/health.js        non-blocking check that the configured claude binary exists
  handlers/                one file per tool: MCP-shaped request/response formatting
  services/delegationService.js  shared submit path: builds an ExecutionContext, calls jobManager.submit(),
                                    triggers workspace create/persist/prune (fire-and-forget)
  services/claudeCliService.js   pure arg-building + child_process spawn/parse (the actual CLI delegation)
  services/jobManager.js  background task runner: queueing, concurrency, cancellation, lifecycle, progress
  services/jobStore.js     storage interface for Job records (in-memory today, swappable)
  services/workspaceManager.js  per-job on-disk artifact mirror (metadata/context/stdout/stderr/result)
  models/schemas.js       zod input schema for delegate_task/delegate_submit (the public tool contract)
  models/executionContext.js  ExecutionContext shape + factory — the CLI service's only input besides prompt
  models/job.js            Job shape, status enum, phase/progress metadata, summarizeJob()/toJobView()
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
`"executing"`/`"Executing claude CLI"`, etc.) — fixed per-phase text, not live streaming.
They exist so a future incremental-progress feature has a field to update without a schema
change; nothing currently updates `progressMessage` mid-phase.

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

## Workspace (persistence layer)

See [ADR-0001](adr/ADR-0001-workspace-and-artifact-architecture.md) for the full design.
Summary: `delegationService.submitDelegation()` calls `workspaceManager.createJobWorkspace()`
right after `jobManager.submit()` (writes `context.json` + an empty `artifacts/`), then
attaches a fire-and-forget `jobManager.waitForCompletion(jobId).then(...)` that calls
`persistJobArtifacts()` (writes `metadata.json`/`stdout.log`/`stderr.log`/`result.json`) and
`pruneWorkspaces()`. This works because `JobManager.waitForCompletion()` already supports
multiple independent waiters per job id — `delegate_task`'s own `await
waitForCompletion(jobId)` and this fire-and-forget one don't interfere. The workspace is a
write-once mirror taken at settle time, never a second source of truth for job state.

## Security: no shell in the CLI spawn

`claudeCliService.invoke()` spawns `config.claudeBin` directly via `execFile` with no shell.
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
