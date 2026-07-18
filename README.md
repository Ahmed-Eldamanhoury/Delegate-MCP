# claude-delegate-mcp

> **Documentation** — 🇺🇸 [English](docs/en/PROJECT_OVERVIEW.md) · 🇸🇦 [العربية](docs/ar/PROJECT_OVERVIEW.md)

An MCP server for Claude Desktop that hands tasks off to a headless Claude Code CLI session
(`claude -p`), running a cheaper/different model tier. It shells out to the `claude` binary
already logged into your Claude subscription — no separate Anthropic API key or billing
required. Nine tools: `delegate_task`, `delegate_submit`, `delegate_status`,
`delegate_history`, `delegate_models`, `delegate_cancel`, `delegate_replay`,
`delegate_metrics`, `delegate_snapshot`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the code layout.

## Setup

1. Make sure `claude` (Claude Code CLI) is installed and logged in (`claude /login`).
2. `npm install`
3. Add the server to `claude_desktop_config.json` — see [examples/desktop-config-snippet.json](examples/desktop-config-snippet.json).
4. Restart Claude Desktop.

## Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_DELEGATE_BIN` | path to `claude.exe` under the npm global dir | override if `claude` is installed elsewhere. Point this at the real executable, not the `.cmd`/`.bat` shim — spawning the shim needs a shell, which is what the default deliberately avoids (see Security note below). |
| `CLAUDE_DELEGATE_BASE_DIR` | process cwd | default working directory for delegated tasks |
| `CLAUDE_DELEGATE_WORKSPACE_DIR` | `<project>/workspace` | root for per-job on-disk artifacts — see Workspace below |
| `CLAUDE_DELEGATE_MAX_WORKSPACE_HISTORY` | `100` | oldest completed job workspaces beyond this are deleted |
| `CLAUDE_DELEGATE_JOB_STORE` | `memory` | `memory` or `file`. `file` switches to `FileJobStore`, which survives a process restart — see [ADR-0005](docs/adr/ADR-0005-persistent-job-store.md). |
| `CLAUDE_DELEGATE_JOB_STORE_DIR` | `<project>/job-store` | directory `FileJobStore` writes one JSON file per job to — only used when `CLAUDE_DELEGATE_JOB_STORE=file` |
| `CLAUDE_DELEGATE_EVENT_HISTORY` | `memory` | `memory` or `file`. `file` switches on `EventHistoryStore`, an append-only per-job durable event log that gives `ReplayEngine` a full-fidelity `"durable"` fallback tier surviving a process restart — see [ADR-0006](docs/adr/ADR-0006-persistent-event-history.md). |
| `CLAUDE_DELEGATE_EVENT_HISTORY_DIR` | `<project>/event-history` | directory `EventHistoryStore` writes one `<job-id>.jsonl` file per job to — only used when `CLAUDE_DELEGATE_EVENT_HISTORY=file` |
| `CLAUDE_DELEGATE_MAX_EVENT_HISTORY_FILES` | `100` | oldest-completed job event logs beyond this are deleted, oldest-completed-first (never an in-flight job's) |
| `DELEGATE_DEBUG` | unset (off) | `true` enables Debug Mode — see below. Anything else is treated as off. |

## Debug Mode (development only)

Set `DELEGATE_DEBUG=true` to run every delegated CLI call in a **visible terminal window**
instead of hidden — useful for watching a real session live while developing. Off by default;
when unset, behavior is byte-identical to every version before this existed.

- Opens Windows Terminal (falls back to `cmd.exe` if not installed), the detected Linux
  terminal emulator, or `Terminal.app` on macOS.
- The window shows a banner (exact command, working directory, model, tools, budget, job id),
  then the live CLI session, then pauses ("Press Enter to close...") once finished.
- Full logs at `workspace/jobs/<job-id>/logs/`: `prompt.txt`, `command.txt`, `stdout.log`,
  `stderr.log`, `stream.jsonl` (every stream-json event, timestamped, in order), `response.json`,
  `metadata.json`.
- `notifications/progress` still works the same as production — the server tails
  `stream.jsonl` to keep publishing live progress.
- **Security**: the prompt never appears on any terminal-launch command line — only job ids and
  paths this process constructs. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#debug-mode-development-only)
  for the full reasoning.
- `delegate_cancel` forcibly stops a Debug Mode job: the parent writes a `cancel.request`
  sentinel that the detached runner polls for and, on detecting it, kills its `claude`
  subprocess tree the same way production's cancellation path does.

## Tool: `delegate_task`

| Field | Default | Notes |
|---|---|---|
| `prompt` | — | required |
| `model` | `sonnet` | `haiku` \| `sonnet` \| `opus` \| `fable` |
| `effort` | `low` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `allowed_tools` | `Read Grep Glob WebSearch WebFetch` | pre-approved, read-only by default |
| `trust_all` | `false` | skips all permission checks — only for a sandboxed `cwd` |
| `cwd` | server base dir | working directory for the subagent |
| `max_budget_usd` | `1` | hard spend cap for the call, must be > 0 |

If `model` is `fable` or `opus` and unavailable, it automatically falls back to a cheaper
model (`fable → opus → sonnet`, `opus → sonnet`) via `claude`'s `--fallback-model`.

Every call is tracked as a `Job` (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
job manager internals) — that's what the tools below inspect and act on. The tool call
itself is still fully synchronous: it blocks until the job finishes and returns the same
response shape as before `delegate_submit`/`delegate_status`/etc. existed.

## Tool: `delegate_submit`

Same input as `delegate_task`, but **never blocks** — creates a job and returns immediately.

Response:

```json
{ "success": true, "job_id": "...", "status": "queued" }
```

(`status` reflects the job's actual state the instant `delegate_submit` returns — usually
`queued`, but it can already be `starting`/`running` if a worker slot was immediately free.
Either way, nothing has been awaited.)

Poll the result with `delegate_status`/`delegate_history`, or stop it with `delegate_cancel`.

## Job lifecycle

```
queued ──> starting ──> running ──> completed
   │           │           │
   │           │           └──> failed      (the CLI call itself failed)
   │           └──────────────> cancelled   (delegate_cancel while starting)
   └──────────────────────────> cancelled   (delegate_cancel while queued — never ran)
```

Every job (from either `delegate_task` or `delegate_submit`) exposes `phase`,
`progressMessage`, `started_at`/`startedAt`, and a continuously-live `runtimeMs` (computed
from `startedAt` while in flight, frozen once terminal) — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#job-lifecycle) for the full field list.
`progressMessage` is now genuinely live while a job runs (real `stream-json` content — see
Events & progress below), not just a static per-status label.

## Tool: `delegate_status`

Read-only. Look up one job by id.

| Field | Required | Notes |
|---|---|---|
| `job_id` | yes | id returned by `delegate_task`'s job or from `delegate_history` |

Returns a text summary (`[status] model=... runtime=...ms cost=$...`) plus the full `Job`
record as `structuredContent`. Errors (`isError: true`) if the id is unknown.

## Tool: `delegate_history`

Read-only. Lists recent jobs, most recent first.

| Field | Default | Notes |
|---|---|---|
| `limit` | `20` | max jobs to return |
| `status` | — | optional filter: `queued`\|`starting`\|`running`\|`completed`\|`failed`\|`cancelled` |

Returns one line per job (id, status, model, cost) plus a lean `{ jobs: [...] }` in
`structuredContent` (full CLI output is omitted here — use `delegate_status` for that).
Jobs beyond `CLAUDE_DELEGATE_MAX_JOB_HISTORY` (default 500) are evicted oldest-first, never
evicting a queued/running job.

## Tool: `delegate_models`

Read-only, no input. Lists the four model tiers, each one's automatic fallback chain, valid
effort levels, and the current defaults (model/effort/budget). Useful for an orchestrating
model deciding which tier to request without hardcoding the list.

## Tool: `delegate_cancel`

| Field | Required | Notes |
|---|---|---|
| `job_id` | yes | job to cancel |

Cancels a queued job immediately (it never runs) or aborts a starting/running one (kills its
`claude` subprocess). Errors if the id is unknown or the job has already finished —
completed/failed/cancelled jobs are immutable and cannot be cancelled again.

Now that `delegate_submit` exists, this is generally useful: submit a job, get its `job_id`
back immediately, and cancel it later in the same session while it's still in flight — the
limitation noted in earlier versions of this doc (that `delegate_task` blocks so there was no
window to cancel it) is resolved by using `delegate_submit` for anything you might want to
cancel.

## Tool: `delegate_replay`

Read-only. Reconstructs a `delegate_task`/`delegate_submit` job's event history for viewing —
never re-executes anything.

| Field | Required | Notes |
|---|---|---|
| `job_id` | yes | id returned by `delegate_task`'s job or from `delegate_history` |

Returns a human-readable summary plus `{ source, timeline }` as `structuredContent`, where
`source` is the richest available tier:

- `runtime` — the job's timeline is still live in `TimelineStore` (in-memory), full fidelity.
- `durable` — the live timeline was already evicted, but a full-fidelity on-disk log was found
  via `EventHistoryStore` — only possible if `CLAUDE_DELEGATE_EVENT_HISTORY=file` was enabled
  (see the Configuration table above and [ADR-0006](docs/adr/ADR-0006-persistent-event-history.md)).
- `workspace` — no live or durable data; a coarse lifecycle summary synthesized from the job's
  `workspace/jobs/<job-id>/metadata.json` mirror.
- `unavailable` — no data of any kind could be found for the given `job_id`; `timeline` is
  empty. Not treated as an error — a normal, informative response.

```json
{ "source": "runtime", "timeline": [{ "timestamp": "...", "type": "JobStateChanged", "payload": { "from": "starting", "to": "running" } }] }
```

Works even with no configuration at all (falls back to the coarse `workspace` tier), and gets
richer — full fidelity beyond `TimelineStore`'s retention window — once
`CLAUDE_DELEGATE_EVENT_HISTORY=file` is enabled. See
[ADR-0007](docs/adr/ADR-0007-mcp-replay-access.md) for the full design rationale.

## Tool: `delegate_metrics`

Read-only, no input. Returns `ObservabilityService.getMetrics()`'s current value
verbatim — never re-executes anything.

Returns a human-readable summary plus the `Metrics` object as `structuredContent`:

```json
{
  "queuedJobs": 0,
  "runningJobs": 0,
  "completedJobs": 3,
  "failedJobs": 0,
  "cancelledJobs": 0,
  "averageRuntimeMs": 4210,
  "maximumRuntimeMs": 5091,
  "averageQueueWaitMs": 12,
  "progressRate": 0.6,
  "streamingEvents": 45,
  "outputChunks": 12,
  "eventCount": 60,
  "workspaceSizeBytes": 20480,
  "artifactCount": 0
}
```

All job counts/counters are numbers; averages/max are `number|null` (null until at least one
sample exists); `workspaceSizeBytes`/`artifactCount` are `number|null` (null only when no
`config` was supplied to the collector). See
[docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md) for the full frozen shape and
[ADR-0008](docs/adr/ADR-0008-mcp-metrics-access.md) for the design rationale.

## Tool: `delegate_snapshot`

Read-only, no input. Returns `ObservabilityService.getSnapshot()`'s current value
verbatim — never re-executes anything.

Returns a human-readable summary plus the `Snapshot` object as `structuredContent`:

```json
{
  "takenAt": "2026-07-16T20:39:36.000Z",
  "metrics": {
    "queuedJobs": 0,
    "runningJobs": 1,
    "completedJobs": 3,
    "failedJobs": 0,
    "cancelledJobs": 0,
    "averageRuntimeMs": 4210,
    "maximumRuntimeMs": 5091,
    "averageQueueWaitMs": 12,
    "progressRate": 0.6,
    "streamingEvents": 45,
    "outputChunks": 12,
    "eventCount": 60,
    "workspaceSizeBytes": 20480,
    "artifactCount": 0
  },
  "activeJobs": [
    { "jobId": "...", "status": "running", "queuedAt": "...", "startedAt": "..." }
  ]
}
```

`metrics` is the same `Metrics` object `delegate_metrics` returns; `activeJobs` lists only
non-terminal jobs (`status` ∈ `"queued"|"starting"|"running"` — terminal jobs never appear),
sourced from `MetricsCollector.getActiveJobs()`. The whole object is deep-frozen
(`structuredClone()` + recursive `Object.freeze()`) — safe to hand to any consumer, mutating
it throws rather than silently no-opping. See
[docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md) for the full frozen shape and
[ADR-0009](docs/adr/ADR-0009-mcp-snapshot-access.md) for the design rationale.

## Workspace

Every job (from either `delegate_task` or `delegate_submit`) gets a durable on-disk record at
`<workspaceRoot>/jobs/<job-id>/`, independent of `JobManager`'s in-memory history (which is
capped and lost on restart):

```
metadata.json   # id, tool, status, timestamps, runtimeMs, exitCode, cost, error
context.json    # the ExecutionContext the job ran with (environment redacted — see below)
stdout.log      # raw CLI stdout
stderr.log      # raw CLI stderr
result.json     # parsed CLI JSON result (or null if unparseable)
artifacts/      # reserved for future job-produced files; unused today
```

This is a **mirror, not a second source of truth** — `JobManager`'s in-memory state is always
authoritative for anything currently running; workspace files are written once, after a job
settles. A write failure here is logged and otherwise ignored — it never affects a tool
response. `context.json` omits `ExecutionContext.environment` (`process.env`) since writing
it verbatim to disk would leak secrets. See
[docs/adr/ADR-0001-workspace-and-artifact-architecture.md](docs/adr/ADR-0001-workspace-and-artifact-architecture.md)
for the full design and [docs/FOUNDATION_FREEZE.md](docs/FOUNDATION_FREEZE.md) for what's
contractually frozen across this project.

## Events & progress (RuntimeEventBus)

Every job's lifecycle (queued/starting/running/completed/failed/cancelled) and CLI output
chunks are published on an in-process `RuntimeEventBus` — a `{publish, subscribe,
subscribeAll}` contract (default implementation: `node:events`, but that's an internal
detail; nothing else in the codebase imports it directly). Workspace persistence and the MCP
progress adapter are both bus subscribers, wired in `mcpServer.js`. Full event schema, the
real observed `stream-json` protocol, sequence diagrams, and the streaming-strategy rationale
are in [docs/adr/ADR-0002-streaming-and-event-architecture.md](docs/adr/ADR-0002-streaming-and-event-architecture.md).

`delegate_task`/`delegate_submit` run `claude -p` with `--output-format stream-json
--verbose` (activated in v1.7.0, verified against real captures) — CLI output is parsed
incrementally, publishing real `JobProgress` while the model is thinking
(`"Thinking… (~N tokens)"`) and as it responds, not synthesized placeholder text.

If you call `delegate_task` with a progress token (`_meta.progressToken`, per the MCP spec),
you'll receive `notifications/progress` pushes for the job's lifecycle while the call is
in flight — verified live: a real call produced 17 progress pushes end to end. `delegate_submit`
cannot do this — by the time anything happens, its tool call has already returned; keep
polling `delegate_status`/`delegate_history` for that path (this is a protocol constraint,
not a missing feature — see the ADR).

## Observability (metrics & timeline)

An internal `ObservabilityService` subscribes to the same `RuntimeEventBus` as workspace
persistence and the MCP progress adapter, but as an *observer*, not a pipeline participant —
it's strictly read-only and never touches `JobManager`, the CLI, or Workspace (see
[docs/adr/ADR-0003-observability-architecture.md](docs/adr/ADR-0003-observability-architecture.md)
for the Passive Observation Rule and dependency-direction guarantees). It maintains O(1)
incremental job metrics (queued/running/completed/failed/cancelled counts, average/maximum
runtime, average queue wait, event/output-chunk counters) and a per-job event timeline,
bounded the same way job/workspace history already are.

Beyond metrics/timeline (Phase 1), `ObservabilityService` also exposes:
- **`replay(jobId)`** — reconstructs a job's event history for viewing (read-only, never
  re-executes anything): full fidelity while the job's timeline is still in `TimelineStore`
  (`source: "runtime"`), full fidelity from a durable on-disk log if
  `CLAUDE_DELEGATE_EVENT_HISTORY=file` was enabled (`source: "durable"`, see
  [ADR-0006](docs/adr/ADR-0006-persistent-event-history.md)), a coarser reconstruction from the
  workspace mirror otherwise (`source: "workspace"`), or `"unavailable"`.
- **`getSnapshot()`** — an immutable, deep-frozen point-in-time view (`{takenAt, metrics,
  activeJobs}`), useful for polling (a future Dashboard, or the `delegate_snapshot` MCP tool
  documented above).
- **`registerConsumer()`/`unregisterConsumer()`/`getConsumerHealth()`/`getConsumerStatistics()`**
  — bookkeeping for future consumers (no transport layer of its own).

`replay()` now has its first external consumer — the `delegate_replay` MCP tool documented above
([ADR-0007](docs/adr/ADR-0007-mcp-replay-access.md)). `getMetrics()` now has its own external
consumer too — the `delegate_metrics` MCP tool documented above
([ADR-0008](docs/adr/ADR-0008-mcp-metrics-access.md)). `getSnapshot()` now has its own external
consumer too — the `delegate_snapshot` MCP tool documented above
([ADR-0009](docs/adr/ADR-0009-mcp-snapshot-access.md)). Everything else here
(`registerConsumer()`/`unregisterConsumer()`/`getConsumerHealth()`/`getConsumerStatistics()`,
`getTimeline()`, and `ConsumerRegistry` generally) is still not exposed through any MCP tool,
Dashboard, or other API — that's future work per ADR-0003's Extension Rules (Dashboard, REST API,
Prometheus/Grafana, future MCP tools all consume `ObservabilityService`, never the bus directly,
whenever they're built). Frozen public contracts: [docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md).

## Security note

`prompt` is arbitrary text (it may ultimately come from web content an orchestrating model
read). The CLI is spawned with `spawn`, no shell, directly against `claude.exe` — so
`prompt` is passed as one literal argv entry and is never parsed for shell metacharacters
(`&`, `|`, `` ` ``, etc.), regardless of what it contains. Do not change `CLAUDE_DELEGATE_BIN`
to point at the `.cmd`/`.bat` shim or add `shell: true` back into `claudeCliService.js` —
both reintroduce command injection on Windows.

## Development

```
npm test          # node:test unit + integration tests, no CLI/network required
npm start          # run the server directly (for manual stdio testing)
```

`tests/asyncExecution.integration.test.js` exercises the full submit → status → history →
cancel(queued) → cancel(running) → completed lifecycle end to end (plus workspace creation,
concurrent jobs, failed/cancelled jobs, and pruning), wiring the real handlers to a real
`JobManager` with a stubbed `claudeCliService` (so it runs without `claude` being installed
or logged in) and a temp `workspaceRoot` (never the project's own `workspace/` dir).
`tests/workspaceManager.test.js` covers the workspace layer in isolation, including path-
traversal rejection.

Tool-level smoke test with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```
npx @modelcontextprotocol/inspector --cli node server.js --method tools/list
```

## Project info

- **License**: [Apache-2.0](LICENSE)
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Support**: [SUPPORT.md](SUPPORT.md)
- **Security**: [SECURITY.md](SECURITY.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Roadmap**: [ROADMAP.md](ROADMAP.md)
- **Release notes**: [docs/releases/](docs/releases/)
