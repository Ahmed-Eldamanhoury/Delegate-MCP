# ADR-0001: Workspace & Artifact Architecture

## Status
Accepted, implemented in v1.5.0.

## Context
Every job's full record lives only in `JobManager`'s in-memory `InMemoryJobStore` — lost on
process restart, and `_trimHistory()` evicts old terminal jobs entirely once `maxJobHistory`
is exceeded. There is no on-disk trail of what a job actually did (stdout/stderr, the exact
`ExecutionContext` it ran with, its final structured result) once evicted or after a
restart. This ADR adds a per-job on-disk workspace as a durable artifact trail, independent
of — and never authoritative over — `JobManager`.

## Goals
- Give every job a durable, inspectable record on disk, independent of the in-memory store's
  lifetime.
- Never make the workspace layer a second source of truth: `JobManager`'s in-memory state is
  authoritative for anything currently running; the workspace is a write-once mirror taken at
  settle time.
- Zero change to any public MCP tool, to `ExecutionContext`'s shape, or to `JobManager`'s
  public methods.
- Fail safe: a workspace I/O failure must never surface as a tool-call error or affect job
  outcome.

## Public contract
- `services/workspaceManager.js` exports:
  - `getWorkspaceRoot(config): string`
  - `isValidJobId(id): boolean` — defense-in-depth; job ids are always `randomUUID()` output,
    but this is checked before any path is constructed from one.
  - `createJobWorkspace(jobId, context, config): void` — best-effort, synchronous.
  - `persistJobArtifacts(jobId, job, config): void` — best-effort, synchronous.
  - `pruneWorkspaces(config): void` — best-effort, synchronous.
- `config/index.js` gains two new fields (additive, backward compatible):
  `workspaceRoot` (env `CLAUDE_DELEGATE_WORKSPACE_DIR`, default `<project>/workspace`) and
  `maxWorkspaceHistory` (env `CLAUDE_DELEGATE_MAX_WORKSPACE_HISTORY`, default 100).
- `claudeCliService.invoke()`'s resolved value gains a `stderr` field (additive — existing
  `{raw, parsed, exitCode}` consumers are unaffected).

## Lifecycle
```
delegationService.submitDelegation()
  1. build ExecutionContext (unchanged)
  2. jobManager.submit(...) -> jobId (unchanged)
  3. createJobWorkspace(jobId, context, config)   <- new: dir + metadata.json + context.json
  4. jobManager.waitForCompletion(jobId).then(job => {
       persistJobArtifacts(jobId, job, config)     <- new: stdout.log/stderr.log/result.json/
                                                       final metadata.json
       pruneWorkspaces(config)                      <- new: evict oldest beyond the cap
     })  // fire-and-forget; JobManager already supports multiple waiters per job id
  5. return jobId (unchanged)
```
Both `delegate_task` (which separately awaits the same job) and `delegate_submit` go through
step 3–4 identically — no duplicated logic, no MCP-visible change.

## Directory layout
```
<workspaceRoot>/jobs/<job-id>/
  metadata.json   # id, tool, status, timestamps, runtimeMs, exitCode, cost, error
  context.json    # ExecutionContext with `environment` redacted (see Security)
  stdout.log      # raw CLI stdout
  stderr.log      # raw CLI stderr
  result.json     # parsed CLI JSON result (or null if unparseable)
  artifacts/      # reserved, empty today — extension point for future job-produced files
```

## Extension points
- `artifacts/` exists per job but nothing populates it yet; a future feature (e.g. the CLI
  writing files) can use it without a layout change.
- `store`-style swap: nothing today depends on `InMemoryJobStore` vs. a future persistent
  store *also* writing here — the workspace is orthogonal to whichever `JobStore`
  implementation `JobManager` uses.

## Security model
- **Path traversal**: `jobId` is validated (`isValidJobId`) as a UUID before any path join;
  never accept an arbitrary string as a directory name.
- **Filename validation**: all filenames within a job's directory are fixed literals
  (`metadata.json`, `context.json`, etc.) — never derived from job content.
- **Workspace isolation**: each job gets its own directory keyed by its own id; no shared
  mutable files between jobs.
- **Sensitive data**: `ExecutionContext.environment` is `process.env` — writing it verbatim
  to disk would leak secrets. `context.json` persists everything except `environment`.
- **Best-effort, non-blocking**: every workspace operation is wrapped so a failure logs and
  is swallowed, never propagates into a tool response or crashes the process.

## Failure handling
A workspace write failure (disk full, permissions, etc.) is logged at `warn`/`error` via the
existing structured logger and otherwise ignored — the job's actual outcome (as reported by
`delegate_task`/`delegate_status`/etc.) is unaffected, since `JobManager`'s in-memory result
is unrelated to whether the disk mirror succeeded.

## Cleanup strategy
`pruneWorkspaces()` runs after every job settles: list `jobs/*` directories that already have
a `metadata.json` (i.e., a completed write — never touches a directory still mid-write or
belonging to a running job), sort oldest-first by `finishedAt`, delete the excess beyond
`maxWorkspaceHistory` using `fs.rmSync(..., { recursive: true, force: true })` (idempotent
under concurrent prune calls — `force` ignores an already-gone directory).

## Compatibility impact
None on any public contract in `FOUNDATION_FREEZE.md`. Purely additive: new files on disk,
two new optional config fields, one new object field (`stderr`) on an internal
(non-MCP-facing) return value.

## Alternatives considered
- Writing artifacts synchronously inside `claudeCliService.invoke()` — rejected: couples a
  pure CLI-invocation service to disk I/O and a specific directory layout; keeping it in
  `delegationService` (the shared submit funnel) keeps `claudeCliService` reusable and
  testable in isolation, as it already is.
- Reusing `maxJobHistory` for workspace retention too — rejected: in-memory job records and
  on-disk artifact directories are different resources with potentially different useful
  retention windows (disk is cheaper than RAM-resident history); kept as a separate,
  independently configurable cap.
