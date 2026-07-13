# Roadmap — v1.1 and beyond

Initiatives below are the ones already anticipated and approved at the architecture level in
[ADR-0003's Extension Rules](../adr/ADR-0003-observability-architecture.md#extension-rules) —
nothing here is newly proposed by this document, and nothing here is implemented by it. Each
item still requires its own dedicated ADR before implementation, per this project's
established discipline (every prior capability — Workspace, Streaming, Observability — shipped
architecture-first, then implementation, in separate waves).

All items consume `ObservabilityService` only — never `RuntimeEventBus` directly (Dependency
Direction, ADR-0003) — and none may introduce a control path back into `JobManager` or the
execution engine (Passive Observation Rule).

## Dashboard
A UI (web or otherwise) polling `ObservabilityService.getSnapshot()`/`getTimeline()`. No
transport decided yet.

## REST API
HTTP endpoints mapping to `ObservabilityService`'s existing methods. Framework choice
(Express/Fastify/other) deliberately deferred to its own ADR — a new production dependency is
a real decision, not a default.

## Plugin SDK
No design exists beyond "future plugins depend only on `ObservabilityService`." Needs its own
ADR defining a plugin contract/lifecycle before any code.

## VS Code Extension
Either an in-process `require` (if colocated with the server) or a local HTTP bridge (if the
REST API above exists first). Transport choice depends on which ships first.

## Prometheus Exporter
A scrape endpoint translating `getMetrics()` into the Prometheus text exposition format.

## Grafana Adapter
Consumes the Prometheus Exporter (or the REST API) — Grafana itself only speaks HTTP, so this
is a consumer of one of the above, not a direct `ObservabilityService` integration.

## Future transports
None chosen. Every consumer above is transport-agnostic by design at the
`ObservabilityService` layer specifically so the transport decision can be made independently,
per consumer, without touching Observability's internals.

## Future consumers
Any consumer type not listed above (e.g. a future MCP tool like `delegate_metrics`) follows
the same rule: call `ObservabilityService` internally, exactly as `delegate_status` already
calls `JobManager` — never a new MCP schema change without its own review.

## Also deferred (not part of this roadmap's scope, tracked in KNOWN_LIMITATIONS.md)
Persistent job store, durable full-fidelity replay (`events.jsonl`), `ConsumerRegistry`
TTL/auto-expiry — these are internal hardening items, not new consumer-facing capabilities;
they'd be scoped as their own small waves if a real need for them materializes.
