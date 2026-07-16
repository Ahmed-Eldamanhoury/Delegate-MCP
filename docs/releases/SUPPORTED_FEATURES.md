# Supported Feature Matrix — v1.0.0

Classification is evidence-based (test coverage + real-world verification), not aspirational.
See linked docs for the underlying evidence.

| Feature | Classification | Notes |
|---|---|---|
| `delegate_task` (blocking) | **Stable** | Frozen contract ([FOUNDATION_FREEZE.md](../FOUNDATION_FREEZE.md)), tested since v1.0-era Sprint 1 |
| `delegate_submit` (non-blocking) | **Stable** | Frozen contract, same test/verification depth as `delegate_task` |
| `delegate_status` / `delegate_history` / `delegate_cancel` | **Stable** | Frozen contracts, fully tested |
| `delegate_models` | **Stable** | Pure config introspection, no execution path |
| `delegate_replay` | **Stable** | Thin MCP wrapper over `ObservabilityService.replay()`, tested; see [ADR-0007](../adr/ADR-0007-mcp-replay-access.md) |
| `delegate_metrics` | **Stable** | Thin MCP wrapper over `ObservabilityService.getMetrics()`, tested; see [ADR-0008](../adr/ADR-0008-mcp-metrics-access.md) |
| Job lifecycle & `JobManager` (queueing, concurrency, cancellation) | **Stable** | Frozen ([FOUNDATION_FREEZE.md](../FOUNDATION_FREEZE.md)), extensively tested including concurrency |
| Workspace persistence (`metadata.json`/`context.json`/logs/`result.json`) | **Stable** | Frozen ([ADR-0001](../adr/ADR-0001-workspace-and-artifact-architecture.md)), redaction and pruning tested |
| `RuntimeEventBus` | **Stable** | Frozen contract ([ADR-0002](../adr/ADR-0002-streaming-and-event-architecture.md)), fail-safe subscriber isolation tested |
| Streaming (`stream-json` progress) | **Stable**, real-world verification limited | Frozen response contract; real-CLI verification is 2 captures + 1 live 17-push end-to-end run (ADR-0002's "Observed protocol" section). Unobserved shapes (`tool_use`/`tool_result`, multi-turn) are silently skipped, never guessed at — not a defect, but broader live coverage is unverified |
| `ObservabilityService` (metrics/timeline/replay/snapshot/consumer registry) | **Stable** | Frozen contract ([OBSERVABILITY_FREEZE.md](../OBSERVABILITY_FREEZE.md)), fully unit/integration tested. Two MCP tools now expose it: `delegate_replay` ([ADR-0007](../adr/ADR-0007-mcp-replay-access.md)) exposes `replay()`, `delegate_metrics` ([ADR-0008](../adr/ADR-0008-mcp-metrics-access.md)) exposes `getMetrics()` — the rest of the surface (`getSnapshot()`/`getTimeline()`/`ConsumerRegistry`) still has zero external consumers and zero external exposure |
| Web Dashboard | **Future** | Contract designed (ADR-0003 Extension Rules), not implemented |
| REST API | **Future** | Contract designed, not implemented — framework choice deliberately deferred |
| CLI Dashboard | **Future** | Contract designed, not implemented |
| VS Code Extension | **Future** | Contract designed, not implemented |
| Prometheus Exporter | **Future** | Contract designed, not implemented |
| Grafana Adapter | **Future** | Contract designed, not implemented |
| Plugin SDK | **Future** | No design exists yet beyond "future consumers depend only on `ObservabilityService`" |
| Future MCP tools (e.g. `delegate_metrics`) | **Future** | Contract pattern designed (mirrors `delegate_status`'s relationship to `JobManager`), not implemented |
| Persistent job store (non-in-memory) | **Stable, opt-in** | `FileJobStore` implements the `JobStore` interface; default remains in-memory, opt in via `CLAUDE_DELEGATE_JOB_STORE=file`. See [ADR-0005](../adr/ADR-0005-persistent-job-store.md). |
| Durable full-fidelity replay (`<job-id>.jsonl`) | **Stable, opt-in** | `EventHistoryStore` persists every job's events to a per-job `<job-id>.jsonl`; `ReplayEngine` gained a `"durable"` tier that reads it; default remains off, opt in via `CLAUDE_DELEGATE_EVENT_HISTORY=file`. See [ADR-0006](../adr/ADR-0006-persistent-event-history.md). |
| `ConsumerRegistry` auto-expiry/TTL | **Deferred** | `touch()`/health fields exist to support it later; not built speculatively (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)) |

**Experimental**: none. Every shipped feature above is either Stable or explicitly Deferred/Future — nothing in the current surface is flagged experimental/unstable.
