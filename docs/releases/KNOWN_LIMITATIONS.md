# Known Limitations — v1.0.0

Verified limitations only — no speculation, no hypothetical issues. Full evidence for each is
in [docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md#known-limitations); this
document indexes them for a release audience rather than restating the evidence.

## Verified limitations (none block this release)

1. **Replay fidelity degrades to "coarse" once a job's timeline leaves `TimelineStore`'s
   retained window — unless the opt-in durable event log is enabled.** By default (and for any
   history predating this feature), fine-grained progress ticks aren't persisted to disk, only
   final aggregated state — a documented, accepted tradeoff (ADR-0003). Setting
   `CLAUDE_DELEGATE_EVENT_HISTORY=file` turns on `EventHistoryStore`, which persists every event
   to a per-job `<job-id>.jsonl`; once enabled, `replay()`'s new `"durable"` tier serves
   full-fidelity replay for jobs recorded after that point, even after they leave
   `TimelineStore`'s window or the process restarts (see "Resolved since v1.0.0" below and
   [ADR-0006](../adr/ADR-0006-persistent-event-history.md)). The coarse fallback still applies
   whenever the feature is off, or for any job whose events were never captured by it.
2. **Streaming's real-world verification is limited to 2 CLI captures** plus one live
   end-to-end run. Unobserved response shapes (`tool_use`/`tool_result`, multi-turn) are
   silently skipped rather than guessed at — graceful degradation, not a crash risk, but
   broader live-traffic coverage is unverified.
3. **The stdin-close self-shutdown fix (ADR-0004, implemented 2.2.2) is unverified against
   a real MCP host.** The mechanism itself now exists — see "Resolved since v1.0.0" below —
   but its unit tests prove it fires correctly against injected fakes, not that Claude
   Desktop's actual disconnect behavior triggers it as intended (deliberately out of this
   sprint's scope; a live-session-disrupting experiment, not one to run incidentally). Until
   that verification happens, the operating mitigation from prior sprints stays in force:
   avoid batching `delegate_*` MCP calls in a single message; issue them one at a time.
4. **REST's `getMetrics()`/`getSnapshot()` are process-scoped** ([ADR-0011](../adr/ADR-0011-rest-api-foundation.md#compatibility-with-observability)).
   A REST `GET /v1/metrics`/`GET /v1/snapshot` call reports only that REST process's own
   accumulated counters since its own boot — a different, independent counter set from a
   concurrently running MCP session's `delegate_metrics`/`delegate_snapshot`, `jobStore=file`
   or not. `MetricsCollector`/`TimelineStore` are constructed fresh per process, never
   persisted anywhere. This is disclosed, not fixed, because fixing it would require a new
   cross-process metrics-aggregation persistence mechanism that does not exist today in any
   form, and no concrete consumer has asked for it (`ADR-0011`'s own chosen resolution:
   document the limitation, don't build aggregation speculatively).
5. **REST's request body-size limit has no MCP mirror** ([ADR-0011](../adr/ADR-0011-rest-api-foundation.md#security)).
   `POST /v1/jobs` rejects a body over 1 MiB (`413 PAYLOAD_TOO_LARGE`); the identical `prompt`
   submitted via `delegate_task`/`delegate_submit` has no length limit at all —
   `DelegateTaskInputShape.prompt` (`src/models/schemas.js`) is a bare `z.string()`. A
   real, disclosed REST/MCP divergence for an identical oversized prompt, not an oversight.
6. **REST's ungraceful shutdown (`kill -9`, crash) is honestly, not optimistically, described**
   ([ADR-0011](../adr/ADR-0011-rest-api-foundation.md#shutdown-semantics)). Windows has no POSIX
   process groups — the same platform limit `docs/ARCHITECTURE.md`'s "Security: Windows
   process-tree cleanup" section already discloses for MCP's own subprocess cleanup applies
   identically to REST; no new mitigation was built or claimed for REST specifically.
7. **REST has no per-job ownership/caller-identity scoping in v1**
   ([ADR-0011](../adr/ADR-0011-rest-api-foundation.md#authorization)). Any caller holding the
   valid shared-secret token may `get`/`list`/`cancel` **any** job by id — matching the existing
   MCP trust model exactly (today's single stdio pipe already lets its one caller see/cancel
   every job regardless of which tool/session created it). A definitive v1 decision, not an
   open-ended deferral: ownership scoping must be (re-)decided before any future version ever
   issues more than one distinct REST credential.
8. **`FileJobStore`'s hydrate-once staleness applies to REST exactly as it already did to MCP**
   ([ADR-0011](../adr/ADR-0011-rest-api-foundation.md#mcp-coexistence)). A REST process that
   boots after an MCP session has already been running only ever sees jobs that existed on disk
   *at REST's own startup* — any job the MCP session submits afterward is invisible to REST (a
   `404` on `GET /v1/jobs/:id`) until REST restarts, `jobStore=file` or not. Not a REST-specific
   gap to fix — `ADR-0005` already disclaims this as a single-process assumption "unchanged from
   every other component in this codebase."

## Resolved since v1.0.0

- **`ConsumerRegistry` had no auto-expiry** (fixed 2.2.0): `pruneStale(maxAgeMs)` now removes
  consumers whose `lastSeenAt` is older than a caller-supplied age. The primitive is in place;
  no consumer calls it yet — `delegate_replay` (ADR-0007) only calls `replay()`, never
  `ConsumerRegistry`'s API, so this remains unused — wiring it into a scheduled sweep is still
  future work.
- **`MetricsCollector`'s artifact-count walk didn't filter directory names by `isValidJobId()`**
  (fixed 2.2.0): now reuses `isValidJobId()` exactly as `pruneWorkspaces()` does, so a
  non-UUID directory manually placed under `workspace/jobs/` no longer has its contents
  miscounted as artifacts. `workspaceSizeBytes` is unaffected by design — it still sums the
  whole `jobs/` tree.
- **`delegate_cancel` couldn't forcibly stop a Debug Mode job** (fixed 2.2.0): see
  [docs/ARCHITECTURE.md](../ARCHITECTURE.md#debug-mode-development-only)'s Cancellation section.
- **Debug Mode's terminal launcher could crash the entire MCP server** on a spawn failure
  (fixed 2.2.1): reproduced on a real machine, then fixed by attaching an `"error"`
  listener to the spawned terminal process instead of leaving it unhandled. See
  `CHANGELOG.md`'s 2.2.1 entry.
- **A stale/orphaned `server.js` instance could silently split job-tracking state from a
  live one** (mechanism implemented 2.2.2): the server now treats its own `stdin` ending
  as a third graceful-shutdown trigger alongside `SIGINT`/`SIGTERM`. See `CHANGELOG.md`'s
  2.2.2 entry and limitation 3 above for what remains unverified.
- **`JobManager({store})`'s extension point had no shipped persistent implementation**
  (fixed in the Persistent Job Store Sprint): `FileJobStore` implements the same interface,
  opt-in via config, default behavior unchanged. See `CHANGELOG.md`'s 2.3.0 entry and
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md).
- **No durable full-fidelity replay existed — `replay()` fell straight to the coarse workspace
  synthesis once a job's timeline left `TimelineStore`'s window** (fixed in this sprint):
  `EventHistoryStore` now persists every job's events to a per-job `<job-id>.jsonl`, opt-in via
  `CLAUDE_DELEGATE_EVENT_HISTORY=file`, and `replay()` gained a `"durable"` tier that reads from
  it before falling back to the coarse synthesis. Default behavior unchanged (off unless
  explicitly enabled). See `CHANGELOG.md`'s 2.4.0 entry and
  [ADR-0006](../adr/ADR-0006-persistent-event-history.md).
- **`ObservabilityService.replay()` had no external consumer — two sprints of Observability work
  (`ADR-0003`, `ADR-0006`) were entirely unreachable by this server's actual users** (fixed in
  this sprint): `delegate_replay`, a new MCP tool, is `replay()`'s first external consumer —
  a thin transport adapter with no replay/filtering/persistence logic of its own. See
  `CHANGELOG.md`'s 2.5.0 entry and
  [ADR-0007](../adr/ADR-0007-mcp-replay-access.md).

## Current scope boundaries

- Single-process, single-machine deployment — no distributed job execution, no clustering.
- In-memory job store by default; a file-backed alternative (`FileJobStore`) now exists
  and is opt-in via `CLAUDE_DELEGATE_JOB_STORE=file` (see
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md)). Still single-process/single-
  machine — no distributed store, no compaction beyond `JobManager`'s own history
  eviction.
- Three MCP tools read from `ObservabilityService`: `delegate_replay`
  ([ADR-0007](../adr/ADR-0007-mcp-replay-access.md)) reads `replay()` specifically,
  `delegate_metrics` ([ADR-0008](../adr/ADR-0008-mcp-metrics-access.md)) reads `getMetrics()`
  specifically, and `delegate_snapshot` ([ADR-0009](../adr/ADR-0009-mcp-snapshot-access.md))
  reads `getSnapshot()` specifically. As of `ADR-0011`, REST (`GET /v1/jobs/:id/replay`,
  `/v1/metrics`, `/v1/snapshot`) reads the same three methods, plus `getTimeline()`'s first
  ever consumer (`GET /v1/jobs/:id/timeline`, REST-only, no MCP mirror). `ConsumerRegistry`
  remains the one piece of `ObservabilityService`'s surface with no external consumer —
  deliberately deferred to Stage 3 (Dashboard).
- Windows-focused process-tree cleanup (`taskkill /t /f`) — the codebase runs cross-platform
  in principle, but this specific cleanup path is Windows-specific by design (POSIX process
  groups aren't used).

## Non-goals

Per [ADR-0003](../adr/ADR-0003-observability-architecture.md#non-goals), Observability is
explicitly not responsible for: execution, orchestration, scheduling, retries, job mutation,
workspace mutation, policy enforcement, or plugin execution. These remain `JobManager`'s,
`delegationService`'s, or a future component's responsibility — never Observability's.

## Deferred capabilities

A scheduled `ConsumerRegistry.pruneStale()` sweep wired to a real consumer — see
[SUPPORTED_FEATURES.md](SUPPORTED_FEATURES.md)'s Deferred row. (Persistent job store and
durable full-fidelity replay are no longer deferred — see "Resolved since v1.0.0" above.)

## Future extensions

Web Dashboard, CLI Dashboard, VS Code Extension, Prometheus Exporter, Grafana Adapter, Plugin
SDK — all contract-designed in ADR-0003, none implemented. (`delegate_replay`, the first
`ObservabilityService`-backed MCP tool, is no longer future work — see "Resolved since v1.0.0"
above and [ADR-0007](../adr/ADR-0007-mcp-replay-access.md). `delegate_metrics`, the second, is
no longer future work either — see [ADR-0008](../adr/ADR-0008-mcp-metrics-access.md). **REST
API is no longer future work** — see [ADR-0011](../adr/ADR-0011-rest-api-foundation.md) and
[REST_FREEZE.md](../REST_FREEZE.md); Web Dashboard is explicitly designed to build on top of it
as a thin UI, not colocated in-process (`ADR-0010` §6, `ADR-0011` Future Dashboard
compatibility). Additional future MCP tools remain unimplemented.)
See [ROADMAP_v1.1.md](ROADMAP_v1.1.md).
