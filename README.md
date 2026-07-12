# claude-delegate-mcp

An MCP server for Claude Desktop that hands tasks off to a headless Claude Code CLI session
(`claude -p`), running a cheaper/different model tier. It shells out to the `claude` binary
already logged into your Claude subscription — no separate Anthropic API key or billing
required. Six tools: `delegate_task`, `delegate_submit`, `delegate_status`,
`delegate_history`, `delegate_models`, `delegate_cancel`.

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
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#job-lifecycle) for the full field list. No
streaming exists yet; these are static per-phase fields ready for a future incremental-
progress feature to update without a schema change.

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

## Security note

`prompt` is arbitrary text (it may ultimately come from web content an orchestrating model
read). The CLI is spawned with `execFile`, no shell, directly against `claude.exe` — so
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
