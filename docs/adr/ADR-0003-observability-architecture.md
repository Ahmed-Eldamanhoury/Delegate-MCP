# ADR-0003: Observability Architecture

## Status
**Accepted and fully implemented** (v1.9.0). Amended and approved in the ADR-0003 Approval &
Implementation Wave 1 review; verified against every guarantee in
`docs/FOUNDATION_FREEZE.md` (see Amendment Log below). Phase 1
(`ObservabilityService` + `MetricsCollector` + `TimelineStore`) shipped in v1.8.0; Phase 2
(`ReplayEngine` + `SnapshotBuilder` + `ConsumerRegistry`) shipped in v1.9.0. Contracts frozen
in [docs/OBSERVABILITY_FREEZE.md](../OBSERVABILITY_FREEZE.md). No Dashboard, REST API,
plugin, or new MCP tool consumes `ObservabilityService` yet — those remain future waves.

## Amendment Log
- **Passive Observation Rule**, **Dependency Direction**, **Non-Goals**, **Data Ownership**,
  and **Extension Rules** sections added below during the approval review, at the reviewer's
  explicit request, to close a gap in the original Proposed draft: the draft *implied*
  read-only/one-directional behavior through component descriptions but never stated it as a
  standalone, checkable rule. These sections make that rule explicit and independently
  verifiable rather than inferred.

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

## Passive Observation Rule

Observability is strictly read-only. `ObservabilityService` and every component beneath it
(`MetricsCollector`, `TimelineStore`, `ReplayEngine`, `SnapshotBuilder`, `ConsumerRegistry`)
must never:

- modify `JobManager` state (no calls into `submit`/`cancelJob`/`_transition`/any mutator)
- change `RuntimeEventBus` state (no `publish` calls — Observability only `subscribe`s)
- execute commands (no `claudeCliService` calls, no subprocess spawning)
- cancel or restart jobs
- mutate Workspace data (no writes under `workspaceRoot`; size/artifact-count queries are
  read-only `fs.stat`/`fs.readdir` calls, never `fs.write*`/`fs.rm*`)

Enforced structurally, not just by convention: `ObservabilityService`'s only interaction with
`RuntimeEventBus` is one `bus.subscribeAll()` call at construction time — it holds no
reference to `JobManager`, `claudeCliService`, or any mutator, so there is nothing to call
even if a future change tried to. It consumes runtime information and derives read-only views
from it; that is the entirety of its responsibility.

## Dependency Direction

The dependency graph is strictly one-directional:

```
RuntimeEventBus
      │
      ▼
 Observability
      │
      ▼
  Dashboard
      │
      ▼
Future Consumers
```

This must never invert into a control path:

```
   Dashboard
      │
      ▼          ✗ NEVER — no control path may exist through Observability
 Observability
      │
      ▼
Execution Engine
```

Concretely: `ObservabilityService`'s public API (`getMetrics`/`getSnapshot`/`getTimeline`/
`getJobSummary`/`replay`/`registerConsumer`) contains no method that accepts a mutation intent
(no `cancelJob`, no `submitJob`, no `writeArtifact`). A Dashboard (or any consumer) built
against this API has no path back into `JobManager`, `RuntimeEventBus`, or the execution
engine — the API surface itself is the enforcement mechanism, not a documented convention a
future implementer could accidentally violate.

## Non-Goals

Observability is **not** responsible for:

- execution
- orchestration
- scheduling
- retries
- job mutation
- workspace mutation
- policy enforcement
- plugin execution

Its responsibility is observation only — deriving read-only views (metrics, timelines,
snapshots, replays) from runtime information already owned elsewhere. Any future requirement
that falls into the list above belongs in `JobManager`, `delegationService`, or a new
component of its own — never bolted onto Observability.

## Data Ownership

No component may duplicate another's ownership:

| Owner | Owns |
|---|---|
| `JobManager` | execution state — the authoritative status/result of every job (per `FOUNDATION_FREEZE.md`: "`JobManager` is the single source of truth for job state — no other component may claim authority over a job's status/result") |
| `Workspace` (`workspaceManager.js`) | persisted artifacts — the on-disk mirror written once at settle time |
| `RuntimeEventBus` | runtime notifications — the event stream itself, in flight |
| `Observability` | derived read-only views — `MetricsCollector`'s aggregates, `TimelineStore`'s per-job event lists, `SnapshotBuilder`'s point-in-time snapshots. These are *derived*, not authoritative: if `Observability` restarts, it can rebuild its view from the bus and workspace; nothing downstream of it can lose data that only Observability held. |

This is why `TimelineStore` is explicitly allowed to be lossy/bounded (Data Ownership backs
the Passive Observation Rule and the Compatibility impact section below: evicting a timeline
entry never loses the underlying fact, since `JobManager`/`Workspace` still own it).

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

**Clarification (Phase 2 implementation)**: since `artifacts/` remains empty/reserved, the
implemented `ReplayEngine` collapses sources 2 and 3 into a single `"workspace"` source (a
job's whole workspace directory, of which `artifacts/` is a subdirectory) — there was nothing
distinct to source from `artifacts/` yet to justify a separate code path. This is a
clarification of an already-approved design detail, not an architecture change: the priority
order and semantics (runtime full-fidelity, workspace coarse fallback, otherwise unavailable)
are unchanged. Revisit as a real ADR update if a future wave populates `artifacts/` with data
meaningfully different from `metadata.json`.

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

## Extension Rules

All future consumers depend only on `ObservabilityService` — never directly on
`RuntimeEventBus`. This is the same rule as Dependency Direction above, restated per-consumer
so each future wave that adds one has an explicit checklist item to verify against:

| Consumer | How it would use `ObservabilityService` | Transport decision |
|---|---|---|
| Dashboard | Thin HTTP/WebSocket adapter translating `getSnapshot()`/`getTimeline()` into responses | Deferred — its own future ADR |
| CLI Dashboard | Polls `getSnapshot()` on an interval, renders to terminal | Deferred |
| VSCode Extension | Either an in-process `require` (if colocated) or a local HTTP bridge | Deferred |
| REST API | Endpoints mapping 1:1 to `ObservabilityService`'s methods | Deferred — framework choice is a real dependency decision, not made here |
| Prometheus Exporter | Scrape endpoint translating `getMetrics()` into the Prometheus text exposition format | Deferred — no scrape server exists in this repo today |
| Grafana Adapter | Consumes the Prometheus Exporter (or a REST endpoint) — does not talk to `ObservabilityService` directly, since Grafana itself only speaks HTTP/Prometheus, not JS | Deferred |
| AI Consumers (e.g. an orchestrating model asking "what's running right now") | A future MCP tool (e.g. `delegate_metrics`) whose handler calls `ObservabilityService` internally, same pattern `delegate_status` already uses for `JobManager` | Deferred — **no MCP schema change in this ADR** |

None of these are scoped, sized, or committed to by this document — the point is that
`ObservabilityService`'s contract is transport-agnostic by design, so each can wrap it
identically whenever it's actually built, and none of them may reach past Observability to
the bus, `JobManager`, or the execution engine (Dependency Direction).

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

## Migration plan
1. ✅ **Implemented (v1.8.0)**: `ObservabilityService` (`src/services/observabilityService.js`)
   + `MetricsCollector` (`src/services/metricsCollector.js`) + `TimelineStore`
   (`src/services/timelineStore.js`) — subscribe, track, query. Wired in `mcpServer.js`. No
   consumers exist yet (no MCP tool exposes it) — this phase is independently shippable and
   was verified via 27 new tests plus a full Inspector `tools/list` diff (byte-identical, zero
   schema change).
2. ✅ **Implemented (v1.9.0)**: `SnapshotBuilder` (`src/services/snapshotBuilder.js`) +
   `ReplayEngine` (`src/services/replayEngine.js`) on top of the phase-1 stores. Snapshots are
   `structuredClone()` + recursively `Object.freeze()`d. Replay collapsed the original
   Workspace/Artifacts split into one `"workspace"` source (see the Clarification above);
   priority is runtime > workspace > unavailable.
3. ✅ **Implemented (v1.9.0)**: `ConsumerRegistry` (`src/services/consumerRegistry.js`) —
   registration/unregistration/health/statistics/consumer metadata, no transport layer.
   Caller-supplied metadata is shallow-cloned on both register() and list() to prevent
   aliasing (found and fixed during this wave's review — see CHANGELOG).
4. (Separate future ADRs, not this one): Web Dashboard, REST API, CLI Dashboard, VSCode
   extension, Prometheus/Grafana, future MCP tools — each is its own transport/framework
   decision. No consumer of `ObservabilityService` exists yet.

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
