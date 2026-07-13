# ADR-0003: Observability Architecture

## Status
**Proposed** — design only, nothing in this document is implemented. Per this wave's own
Phase 0 instruction ("No code until ADR approval is complete"), no source file changes
accompany this ADR. Not reflected in `docs/FOUNDATION_FREEZE.md` until accepted and built.

## Context
`RuntimeEventBus` (ADR-0002) currently has exactly two subscriber categories, both part of
the core execution pipeline itself: `workspaceEventBridge.js` (persists terminal job state to
disk) and `mcpProgressAdapter.js` (forwards progress to an in-flight `delegate_task` call).
Both are tightly coupled to the pipeline by design — they exist to *drive* behavior (write a
file, send a protocol notification), not to *observe* it.

A Dashboard, a plugin, or a future REST API is a fundamentally different kind of consumer: it
*watches* the system without participating in it. Today, building any of those would mean
subscribing directly to `RuntimeEventBus` — which means every future consumer re-derives its
own metrics, its own timeline reconstruction, its own retention policy, from raw
`RuntimeEvent`s. That's the coupling this ADR removes: one component (`ObservabilityService`)
owns "watching," everything else consumes *it*.

## Goals
- `ObservabilityService` is the single gateway for all **monitoring/observation** consumers
  (Dashboard, plugins, future HTTP APIs, future MCP tools). It is *not* a replacement for the
  execution-pipeline subscribers (`workspaceEventBridge`, `mcpProgressAdapter`) — those stay
  exactly as they are; this ADR does not touch them (**do not redesign completed work**).
- A consumer built against `ObservabilityService` never imports or references
  `RuntimeEventBus`, `JobManager`, or any `RuntimeEvent` shape directly.
- Read-only by construction: nothing in this layer can mutate job state, cancel a job, or
  trigger execution. It answers "what happened / what's happening," never "make something
  happen."
- Bounded memory: same fail-safe eviction discipline `JobManager._trimHistory()` and
  `workspaceManager.pruneWorkspaces()` already established — no new unbounded growth.
- Zero impact on `FOUNDATION_FREEZE.md`, MCP schemas, or `RuntimeEventBus`'s contract. This is
  purely a new subscriber sitting alongside the existing two.

## Two kinds of bus subscriber (the key distinction this ADR draws)

```
RuntimeEventBus
  ├── workspaceEventBridge.js   (execution pipeline — drives disk persistence)  [existing, ADR-0002]
  ├── mcpProgressAdapter.js     (execution pipeline — drives protocol notifications) [existing, ADR-0002]
  └── ObservabilityService      (observation — answers queries, drives nothing)  [this ADR]
        ├── MetricsCollector
        ├── TimelineStore
        ├── SnapshotBuilder
        ├── ReplayEngine
        └── ConsumerRegistry
              ├── Dashboard        (future — API consumer, never sees the bus)
              ├── Plugins          (future — API consumer, never sees the bus)
              └── Future HTTP/MCP  (future — API consumer, never sees the bus)
```

`ObservabilityService` subscribes to `RuntimeEventBus` via `bus.subscribeAll()` — one
subscription, same fail-safe per-listener isolation every other subscriber already gets from
`runtimeEventBus.js`. Everything downstream of it talks to *its* API, never the bus.

## Components

### `ObservabilityService`
The façade and the only thing anything downstream imports.

```
ObservabilityService = {
  getMetrics(): Metrics
  getSnapshot(): Snapshot
  getTimeline(jobId, {type?, since?}?): TimelineEntry[]
  getJobSummary(jobId): JobSummary | null
  replay(jobId): { source: "runtime" | "workspace" | "unavailable", timeline: TimelineEntry[] }
  registerConsumer(name): ConsumerHandle
}
```

Internally: one `bus.subscribeAll()` callback fans each `RuntimeEvent` out to
`MetricsCollector.record(event)` and `TimelineStore.record(event)`. `SnapshotBuilder` and
`ReplayEngine` are pull-only — they read from `MetricsCollector`/`TimelineStore`/`workspace`
on demand, they don't subscribe to anything themselves. This keeps exactly one write path
into observability state (the fan-out callback), mirroring how `JobManager` keeps exactly one
write path into job state (`_transition()`).

### `MetricsCollector`
Running aggregates, updated incrementally per event — **no stored history arrays**, to keep
memory O(1) regardless of job volume:

| Metric | Derivation |
|---|---|
| Running Jobs | gauge, incremented on `JobStateChanged{to:"running"}`, decremented on any terminal event |
| Queued Jobs | gauge, incremented on `JobQueued`, decremented on `JobStateChanged{to:"starting"}` or `JobCancelled` (queued→cancelled) |
| Completed / Failed / Cancelled Jobs | counters, incremented on their respective terminal event |
| Average Runtime | incremental mean over `JobCompleted`/`JobFailed`/`JobCancelled`'s `runtimeMs` |
| Maximum Runtime | running max, same source |
| Average Queue Wait | incremental mean of (first `JobStateChanged{to:"starting"}` timestamp − `JobQueued` timestamp) per job, tracked via a small transient `Map<jobId, queuedAt>` cleared once consumed |
| Progress Rate | count of `JobProgress` events / elapsed seconds since collector start (rolling) |
| Streaming Events | cumulative count of `JobProgress` events |
| Output Chunks | cumulative count of `OutputChunk` events |
| Workspace Size | **not event-derived** — computed on demand by walking `workspaceManager.getWorkspaceRoot()` when requested, not tracked continuously (avoids maintaining a second, driftable byte-count) |
| Artifact Count | same: on-demand `fs.readdir` count under `workspace/jobs/*/artifacts/` |

"Future metrics must be easy to add": each metric is one small handler keyed by event
`type`(+`subtype`/payload field) in a single dispatch map inside `MetricsCollector` — adding a
metric means adding one handler entry, not touching the dispatch mechanism itself.

### `TimelineStore`
Per-job, append-only list of lean `TimelineEntry` (`{eventId, timestamp, type, payload}`) —
ordering is deterministic by construction: `RuntimeEventBus.publish()` dispatches
synchronously and Node is single-threaded, so events are recorded in the exact order they
were published, no reordering possible.

Bounded via the same shape as `JobManager._trimHistory()`/`workspaceManager.pruneWorkspaces()`:
`maxTimelineHistory` (job-count cap), oldest **terminal** job's timeline evicted first, an
in-flight job's timeline is never evicted. (Three components now share this identical
eviction shape — worth a shared `boundedEvict()` utility at implementation time, noted here,
not mandated: extracting it is a refactor of already-shipped code, out of this ADR's scope.)

`getTimeline(jobId, {type, since})`: filters by event type and/or timestamp, always returns
in recorded (chronological) order.

### `ReplayEngine`
"Replay" means **reconstructing a job's event history for viewing** — it never re-executes
anything, has zero side effects. Source selection, in priority order:
1. **Runtime** (`TimelineStore`): if the job's timeline is still retained in memory, return it
   directly — full fidelity (every `JobProgress`/`OutputChunk` tick), zero duplication (it *is*
   the stored data, not a copy of it).
2. **Workspace**: if evicted from `TimelineStore` (or after a server restart — `TimelineStore`
   is in-memory, lost on restart, exactly like `JobManager`'s own history), reconstruct a
   **coarse** timeline from `workspace/jobs/<id>/metadata.json`
   (`queuedAt`/`startedAt`/`finishedAt`/`status`/`error`) — lifecycle transitions with
   timestamps, but **not** the fine-grained progress ticks, since those aren't currently
   persisted to disk (only the final aggregated state is — see Known limitation below).
3. **Artifacts**: `artifacts/` is reserved and empty today (ADR-0001) — nothing to replay from
   yet; returns `source: "unavailable"` until a future wave populates it.

**Known limitation, stated plainly**: full-fidelity replay is only possible while a job's
timeline is still in `TimelineStore`'s retained window. This ADR does not propose persisting
the full event stream to disk (that would duplicate `TimelineStore`'s data, which the spec
explicitly says not to do) — a future ADR could add an append-only `events.jsonl` per job
workspace if durable full-fidelity replay becomes a real requirement. Not designed here.

### `SnapshotBuilder`
```
Snapshot = {
  takenAt: ISO-8601 string,
  metrics: Metrics,
  activeJobs: JobSummary[],  // queued/starting/running only
}
```
Built via `structuredClone()` (Node stdlib, no new dependency) of the assembled data plus a
top-level `Object.freeze()` — a snapshot can never be used to mutate `MetricsCollector`'s or
`TimelineStore`'s live internal state, satisfying "must not expose mutable runtime objects."
Pull-only, built on demand when `getSnapshot()` is called — no background interval, no timer,
nothing running when nobody's asking (matches "support future Dashboard **polling**," which
is explicitly pull-based, not push).

### `ConsumerRegistry`
Tracks who has registered as an `ObservabilityService` consumer — `registerConsumer(name)`
returns a handle with an `unregister()` method. V1 scope is bookkeeping/introspection only
(list active consumers, know when one disconnects) — **not** a second pub/sub layer on top of
the bus. Nothing in this wave's requirements asks for push semantics beyond what
`RuntimeEventBus` itself already provides to the pipeline subscribers; inventing one now for
consumers that don't exist yet would be speculative. If a future concrete consumer genuinely
needs push (not poll), that's a scoped addition to `ConsumerRegistry` at that time, not now.

## Dashboard contract

**No UI is designed or built here.** The entire contract is `ObservabilityService`'s public
API above. A future Dashboard (in any form) calls `getSnapshot()`/`getTimeline()`/`replay()`
and renders the result — it has no reference to `RuntimeEventBus`, `JobManager`, or any
`RuntimeEvent`, satisfying "the Dashboard should never know RuntimeEventBus exists" by
construction, not by convention.

## Future API contracts (design intent only, none implemented)

| Consumer | How it would use `ObservabilityService` | Transport decision |
|---|---|---|
| Web Dashboard | Thin HTTP/WebSocket adapter translating `getSnapshot()`/`getTimeline()` into responses | Deferred — its own future ADR |
| CLI Dashboard | Polls `getSnapshot()` on an interval, renders to terminal | Deferred |
| VSCode Extension | Either an in-process `require` (if colocated) or a local HTTP bridge | Deferred |
| REST API | Endpoints mapping 1:1 to `ObservabilityService`'s methods | Deferred — framework choice is a real dependency decision, not made here |
| Future MCP Tools (e.g. `delegate_metrics`) | Handler calls `ObservabilityService` internally, same pattern `delegate_status` already uses for `JobManager` | Deferred — **no MCP schema change in this ADR** |

None of these are scoped, sized, or committed to by this document — the point is that
`ObservabilityService`'s contract is transport-agnostic by design, so each can wrap it
identically whenever it's actually built.

## Security

| Area | Design |
|---|---|
| Event retention | `TimelineStore` bounded by `maxTimelineHistory`, oldest-terminal-first eviction — same pattern as `JobManager`/`workspaceManager` |
| Memory growth | `MetricsCollector` is O(1) — incremental aggregates, no stored history arrays |
| Snapshot safety | `structuredClone()` + `Object.freeze()` — no live-object references ever returned |
| Workspace isolation | Size/artifact-count queries reuse `workspaceManager.getWorkspaceRoot()`/`isValidJobId()` — no new path-construction logic, no new attack surface |
| Event replay | Read-only reconstruction of already-stored data; **never** re-executes a job or triggers any side effect — the word "replay" here is explicitly about viewing history, not re-running work |
| Resource cleanup | `ObservabilityService`'s `bus.subscribeAll()` returns an unsubscribe function, called during the same graceful-shutdown path `cli/entry.js` already uses for `SIGINT`/`SIGTERM` |

## Testing plan (for the implementation wave, not written here)
Unit: `MetricsCollector`'s incremental math, `TimelineStore`'s ordering/eviction,
`SnapshotBuilder`'s immutability (attempt-to-mutate-and-fail), `ConsumerRegistry`
register/unregister. Integration: `ObservabilityService` wired to a real bus + `JobManager`
across a full job lifecycle. Concurrency: multiple jobs updating metrics simultaneously (JS's
single-threaded execution makes lost updates structurally impossible, but the test proves it,
not just asserts it). Timeline ordering, snapshot consistency (a snapshot taken mid-update
never sees partial state, since it's built synchronously from already-settled aggregates),
replay-source-selection (runtime vs. workspace vs. unavailable), regression tests for every
verified defect found along the way — same discipline every prior wave in this project used.

## Compatibility impact
None. `ObservabilityService` is a new, additive `bus.subscribeAll()` subscriber — it does not
touch `JobManager`, `claudeCliService`, `workspaceManager`, `workspaceEventBridge`,
`mcpProgressAdapter`, or any MCP tool schema. Zero schema changes are introduced by this ADR
itself (no new MCP tools — that's explicitly deferred future work per the table above).

## Migration plan (future waves — sequencing only, nothing here is scheduled)
1. `ObservabilityService` + `MetricsCollector` + `TimelineStore` core — subscribe, track,
   query. No consumers exist yet; this alone is independently testable and shippable.
2. `SnapshotBuilder` + `ReplayEngine` on top of the stores from phase 1.
3. `ConsumerRegistry` + one trivial in-process test consumer proving the full contract.
4. (Separate future ADRs, not this one): Web Dashboard, REST API, CLI Dashboard, VSCode
   extension, MCP tools — each is its own transport/framework decision.

## Alternatives considered
- **Let Dashboard/plugins subscribe to `RuntimeEventBus` directly**: rejected — this is
  exactly the coupling the wave's objective calls out; every consumer would reinvent metrics
  aggregation, retention, and replay independently.
- **Push-based `ConsumerRegistry` (a second event bus)**: rejected for V1 — no concrete
  consumer needs push yet, "support Dashboard polling" is explicitly pull-based, and building
  a speculative second pub/sub layer before anything consumes it is exactly the kind of
  premature abstraction this project has avoided in every prior wave.
- **Persist full event streams to workspace now** (to make replay always full-fidelity):
  rejected — the spec explicitly says "do not duplicate stored data," and no concrete
  consumer has asked for durable full-fidelity replay yet; noted as a clearly-scoped future
  ADR if that need materializes.
