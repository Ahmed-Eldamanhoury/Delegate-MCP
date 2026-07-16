# Dashboard Foundation Assessment

**Question this document answers:** should the *existing* `ObservabilityService` API become
the thing every future Dashboard/REST API/Analytics feature is built against, or would those
future waves need something different? **No Dashboard is designed or built here** — this is
solely an assessment of whether the existing contract is fit to be depended on later.

## The contract as it stands today (frozen, `OBSERVABILITY_FREEZE.md:9-31`)

```
getMetrics(): Metrics
getTimeline(jobId, {type?, since?}): TimelineEntry[]
replay(jobId): {source, timeline}
getSnapshot(): immutable Snapshot
registerConsumer(name, metadata?) / unregisterConsumer(id) / touchConsumer(id)
listConsumers() / getConsumerHealth(id) / getConsumerStatistics()
close()
```

No method accepts a mutation argument. This is enforced structurally (the object literal
returned by `createObservabilityService` — `observabilityService.js:87-99` — contains no
function that reaches `JobManager`, `bus.publish`, or `claudeCliService`), not by convention
that a future Dashboard implementer could accidentally violate.

## Every documented future consumer already targets this exact API

`ADR-0003`'s Extension Rules table (`ADR-0003:280-294`) is not aspirational prose — it is a
per-consumer checklist, and every entry names `ObservabilityService`'s existing methods, not a
hypothetical future one:

| Consumer | Targets |
|---|---|
| Web Dashboard | `getSnapshot()`/`getTimeline()` via a thin HTTP/WebSocket adapter |
| CLI Dashboard | Polls `getSnapshot()` on an interval |
| VS Code Extension | In-process `require` or local HTTP bridge to the same methods |
| REST API | Endpoints mapping 1:1 onto `ObservabilityService`'s methods |
| Prometheus Exporter | Translates `getMetrics()` into exposition format |
| Grafana Adapter | Consumes the Prometheus Exporter, never `ObservabilityService` directly |
| AI Consumers (a future `delegate_metrics` MCP tool) | Handler calls `ObservabilityService` internally, same pattern `delegate_status` already uses for `JobManager` |

None of these require a new capability from `ObservabilityService` that doesn't already exist
in some form — they require **transport** (HTTP server, WebSocket, Prometheus text format, MCP
tool registration), which is explicitly deferred to each one's own future ADR
(`ADR-0003:288-294`, "Deferred" in every row). The gap this review's requested wave closes —
durable event history — is a *data availability* gap (can `replay()` return full-fidelity
history after a restart), not an *API shape* gap. Closing it makes every consumer in the table
above strictly more capable (richer `replay()` results) without any of them needing to change
how they call it.

## Why replacing this API would be strictly worse than extending it

Building a separate, parallel read-model for a future Dashboard (bypassing
`ObservabilityService`) would recreate exactly the coupling `ADR-0003` was written to prevent:
*"every future consumer re-derives its own metrics, its own timeline reconstruction, its own
retention policy, from raw `RuntimeEvent`s"* (`ADR-0003:29-31`). It would also require
duplicating the Passive Observation Rule's enforcement (no path back into `JobManager`) in a
second place, doubling the surface that has to be re-verified for the same security property
`OBSERVABILITY_FREEZE.md` already freezes once.

## Verdict for this document

`ObservabilityService`'s existing, frozen API is fit to be the Dashboard/REST API/Analytics
foundation as-is. The durable-event-history wave (`CONSOLIDATION_PLAN.md`) should preserve this
API's shape exactly (`replay()`'s new `source` value is additive per
`OBSERVABILITY_FREEZE.md`'s own minor-version rule) so that whichever future wave finally builds
a Dashboard inherits richer data for free, with zero rearchitecture required on either side.
See `RECOMMENDATION.md` for the consolidated final answer.
