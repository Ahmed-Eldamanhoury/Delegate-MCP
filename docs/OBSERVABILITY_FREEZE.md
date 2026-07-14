# Observability Freeze

Status as of v1.9.0 (ADR-0003 accepted and fully implemented — Phase 1 in v1.8.0, Phase 2 in
v1.9.0). This document freezes Observability's **contracts**, not implementations —
`MetricsCollector`'s internal bookkeeping, `TimelineStore`'s eviction bookkeeping, etc. may
still be refactored freely as long as everything below stays true. Sibling to
`docs/FOUNDATION_FREEZE.md`, which this document does not restate or override.

## Frozen public API — `ObservabilityService`

Constructed once in `mcpServer.js` via `createObservabilityService({ bus, config, logger,
maxTimelineHistory })`. Its method set is frozen:

| Method | Returns |
|---|---|
| `getMetrics()` | `Metrics` (see below) |
| `getTimeline(jobId, {type?, since?})` | `TimelineEntry[]`, chronological |
| `replay(jobId)` | `{source: "runtime"\|"workspace"\|"unavailable", timeline: TimelineEntry[]}` |
| `getSnapshot()` | immutable `Snapshot` (see below) |
| `registerConsumer(name, metadata?)` | `{id, unregister(), touch()}` |
| `unregisterConsumer(id)` | `boolean` |
| `touchConsumer(id)` | `boolean` |
| `listConsumers()` | `ConsumerInfo[]` |
| `getConsumerHealth(id)` | `{id, active, registeredAt, lastSeenAt}` |
| `getConsumerStatistics()` | `{activeCount, totalRegistered}` |
| `close()` | unsubscribes from `RuntimeEventBus` |

No method accepts a mutation intent (no `cancelJob`, no `submitJob`, no `writeArtifact`) — this
is the Passive Observation Rule (ADR-0003) enforced structurally by the API surface itself, not
by convention. Adding a new read-only method here is additive/non-breaking; changing an
existing method's return shape or removing one is breaking.

## Frozen data shapes

**`Metrics`**: `{queuedJobs, runningJobs, completedJobs, failedJobs, cancelledJobs,
averageRuntimeMs, maximumRuntimeMs, averageQueueWaitMs, progressRate, streamingEvents,
outputChunks, eventCount, workspaceSizeBytes, artifactCount}`. All job counts/counters are
numbers; averages/max are `number|null` (null until at least one sample exists);
`workspaceSizeBytes`/`artifactCount` are `number|null` (null only when no `config` was
supplied to the collector). Adding a new field is non-breaking; removing/retyping one is.

**`TimelineEntry`**: `{eventId, timestamp, type, payload}` — a lean projection of a
`RuntimeEvent` (ADR-0002), scoped per job. `replay()`'s workspace-sourced entries additionally
carry `synthetic: true` and `eventId: null` — a caller can always tell a synthesized entry
apart from a real recorded one.

**`Snapshot`**: `{takenAt, metrics, activeJobs}` where `activeJobs` is
`{jobId, status, queuedAt, startedAt}[]` (status ∈ `"queued"|"starting"|"running"` — terminal
jobs never appear). Every level is `Object.freeze()`d after `structuredClone()` — a `Snapshot`
is safe to hand to any consumer; mutating it throws (strict mode) and never affects live state.

**`ConsumerInfo`**: `{id, name, metadata, registeredAt, lastSeenAt}` — `metadata` is
shallow-cloned on both `registerConsumer()` and `listConsumers()`, so neither the caller's
original object nor a `listConsumers()` result can be mutated to corrupt the registry.

## Compatibility guarantees

- `ObservabilityService` holds no reference to `JobManager`, `claudeCliService`, or
  `bus.publish` — verified structurally (`Object.keys(observability)` contains no mutator) and
  by regression test (`tests/observabilityService.test.js`). This guarantee does not change
  without a new ADR.
- `RuntimeEventBus`'s `subscribeAll()` contract is the only coupling point; Observability never
  becomes a second source of truth for job state (`JobManager` remains authoritative per
  `FOUNDATION_FREEZE.md`).
- Zero MCP schema impact: no tool currently exposes any Observability data. When one eventually
  does, that tool's schema is what `FOUNDATION_FREEZE.md` governs — this document governs only
  the internal `ObservabilityService` contract those future tools would call into.
- `TimelineStore`/`MetricsCollector` bookkeeping is bounded (oldest-terminal-first eviction,
  O(1) incremental aggregates) — a compatibility guarantee about *behavior* (never unbounded
  memory growth), not about specific internal data structures.

## Extension points

- **New metrics**: add one `case` in `MetricsCollector.record()`'s switch plus one field in
  `getMetrics()`'s return — the dispatch mechanism itself never changes (ADR-0003).
- **New consumers** (Dashboard, REST API, CLI Dashboard, VSCode extension, Prometheus/Grafana,
  future MCP tools): call `ObservabilityService`'s existing methods; never subscribe to
  `RuntimeEventBus` directly (Dependency Direction, ADR-0003). None are implemented yet.
- **Durable full-fidelity replay**: if a future need arises, a per-job `events.jsonl` append
  log is the documented option (ADR-0003) — not built, since nothing currently requires it and
  it would duplicate `TimelineStore`'s data while a job's timeline is still retained.
- **Consumer TTL/auto-expiry**: `ConsumerRegistry` currently relies on callers calling
  `unregister()`; `touch()`/`getHealth().lastSeenAt` exist so a future consumer of the registry
  could implement staleness detection itself. A `pruneStale(maxAgeMs)` primitive was added in
  2.2.0, but no scheduled sweep is wired to it yet — still no *automatic* eviction, deliberately
  not built speculatively (see `docs/releases/KNOWN_LIMITATIONS.md`).

## Non-goals

Observability is not, and this freeze does not commit it to becoming, responsible for:
execution, orchestration, scheduling, retries, job mutation, workspace mutation, policy
enforcement, or plugin execution (ADR-0003's Non-Goals section, restated here as frozen).

## Versioning policy

Semver against this document, mirroring `FOUNDATION_FREEZE.md`'s policy:
- **patch**: internal refactor (e.g. `MetricsCollector`'s `jobMeta` bookkeeping), doc
  correction, non-behavioral change.
- **minor**: new `ObservabilityService` method, new `Metrics`/`Snapshot` field with a safe
  default, new consumer type documented in Extension points.
- **major**: anything that breaks a guarantee in this document — most sensitively, any change
  that gives `ObservabilityService` a mutation path (would violate the Passive Observation
  Rule) or exposes a non-frozen `Snapshot`.

## Breaking-change policy

No entry above changes without an ADR amendment (ADR-0003 or a successor) and a version bump
reflecting it. The Passive Observation Rule and Dependency Direction are the
highest-scrutiny surfaces — any change there requires explicit user sign-off, same precedent
`FOUNDATION_FREEZE.md` established for `delegate_task`'s blocking behavior.

## Deprecation policy

No `ObservabilityService` method has been deprecated yet. When one is: it stays functional for
at least one minor version, is marked deprecated in its JSDoc, and its removal is itself a
major version / breaking change requiring an ADR.
