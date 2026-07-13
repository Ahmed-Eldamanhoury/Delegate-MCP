# Known Limitations — v1.0.0

Verified limitations only — no speculation, no hypothetical issues. Full evidence for each is
in [docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md#known-limitations); this
document indexes them for a release audience rather than restating the evidence.

## Verified limitations (none block this release)

1. **`ConsumerRegistry` has no auto-expiry.** A consumer that registers and never calls
   `unregister()` lingers indefinitely. Zero current risk — no consumer exists yet (Observability
   has no external consumer in v1.0.0).
2. **`MetricsCollector`'s artifact-count walk doesn't filter directory names by `isValidJobId()`**
   the way `pruneWorkspaces()` does. Not a security issue (directory names are sourced from
   `readdirSync()` itself, never externally supplied) — a cosmetic accuracy gap in an
   informational metric only.
3. **Replay fidelity degrades to "coarse" once a job's timeline leaves `TimelineStore`'s
   retained window** — fine-grained progress ticks aren't persisted to disk, only final
   aggregated state. Documented, accepted tradeoff (ADR-0003).
4. **Streaming's real-world verification is limited to 2 CLI captures** plus one live
   end-to-end run. Unobserved response shapes (`tool_use`/`tool_result`, multi-turn) are
   silently skipped rather than guessed at — graceful degradation, not a crash risk, but
   broader live-traffic coverage is unverified.

## Current scope boundaries

- Single-process, single-machine deployment — no distributed job execution, no clustering.
- In-memory job store by default (`JobManager({store})` extension point exists but has no
  shipped persistent implementation).
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

Persistent job store, durable full-fidelity replay (`events.jsonl`), `ConsumerRegistry`
TTL/auto-expiry — see [SUPPORTED_FEATURES.md](SUPPORTED_FEATURES.md)'s Deferred row for each.

## Future extensions

Web Dashboard, REST API, CLI Dashboard, VS Code Extension, Prometheus Exporter, Grafana
Adapter, Plugin SDK, future MCP tools — all contract-designed in ADR-0003, none implemented.
See [ROADMAP_v1.1.md](ROADMAP_v1.1.md).
