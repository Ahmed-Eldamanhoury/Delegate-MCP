# Known Limitations — v1.0.0

Verified limitations only — no speculation, no hypothetical issues. Full evidence for each is
in [docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md#known-limitations); this
document indexes them for a release audience rather than restating the evidence.

## Verified limitations (none block this release)

1. **Replay fidelity degrades to "coarse" once a job's timeline leaves `TimelineStore`'s
   retained window** — fine-grained progress ticks aren't persisted to disk, only final
   aggregated state. Documented, accepted tradeoff (ADR-0003).
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

## Resolved since v1.0.0

- **`ConsumerRegistry` had no auto-expiry** (fixed 2.2.0): `pruneStale(maxAgeMs)` now removes
  consumers whose `lastSeenAt` is older than a caller-supplied age. The primitive is in place;
  no consumer calls it yet, since `ObservabilityService` still has no external consumer (see
  Current scope boundaries below) — wiring it into a scheduled sweep is still future work.
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
  (fixed in this sprint): `FileJobStore` implements the same interface, opt-in via
  config, default behavior unchanged. See `CHANGELOG.md`'s entry and
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md).

## Current scope boundaries

- Single-process, single-machine deployment — no distributed job execution, no clustering.
- In-memory job store by default; a file-backed alternative (`FileJobStore`) now exists
  and is opt-in via `CLAUDE_DELEGATE_JOB_STORE=file` (see
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md)). Still single-process/single-
  machine — no distributed store, no compaction beyond `JobManager`'s own history
  eviction.
- `ObservabilityService` has no external consumer — no Dashboard, REST API, or MCP tool
  currently reads from it.
- Windows-focused process-tree cleanup (`taskkill /t /f`) — the codebase runs cross-platform
  in principle, but this specific cleanup path is Windows-specific by design (POSIX process
  groups aren't used).

## Non-goals

Per [ADR-0003](../adr/ADR-0003-observability-architecture.md#non-goals), Observability is
explicitly not responsible for: execution, orchestration, scheduling, retries, job mutation,
workspace mutation, policy enforcement, or plugin execution. These remain `JobManager`'s,
`delegationService`'s, or a future component's responsibility — never Observability's.

## Deferred capabilities

Durable full-fidelity replay (`events.jsonl`), a scheduled `ConsumerRegistry.pruneStale()`
sweep wired to a real consumer — see [SUPPORTED_FEATURES.md](SUPPORTED_FEATURES.md)'s
Deferred row for each. (Persistent job store is no longer deferred — see "Resolved since
v1.0.0" above.)

## Future extensions

Web Dashboard, REST API, CLI Dashboard, VS Code Extension, Prometheus Exporter, Grafana
Adapter, Plugin SDK, future MCP tools — all contract-designed in ADR-0003, none implemented.
See [ROADMAP_v1.1.md](ROADMAP_v1.1.md).
