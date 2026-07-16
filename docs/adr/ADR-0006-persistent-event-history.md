# ADR-0006: Persistent Event History

## Status

**Proposed — pending user sign-off before implementation.** Written per the recommendation
in `RECOMMENDATION.md` (Observability Architecture Review): extend the existing
`ObservabilityService`/`ReplayEngine` stack rather than replace it. Two verification rounds
performed before this document is put forward for sign-off: an initial Architectural
Verification (below) performed before the Decision was drafted, and a Final Pre-Implementation
Verification (below, dated after the Decision/Testing plan were written) answering five
specific technical questions — ordering, crash recovery, performance, future-consumer fit, and
long-term stability — with one concrete amendment resulting (a measured, not estimated,
performance benchmark added to the Testing plan and to the implementation plan's Task 5,
matching `ADR-0005`'s own discipline).

## Final Pre-Implementation Verification (Round 2)

Performed after the Decision, Retention, Testing plan, and Alternatives sections below were
already written, in response to five specific questions requiring repository evidence.

### Q1 — Event ordering across `TimelineStore`, `ReplayEngine`, `EventHistoryStore`

**Claim: ordering is a structural guarantee, not an algorithm that sorts anything.** No two
sources are ever merged — `replay()` returns exactly one source's already-ordered list,
verbatim:

```
function replay(jobId):
    if timelineStore.has(jobId):
        return { source: "runtime", timeline: timelineStore.getTimeline(jobId) }
    if eventHistoryStore.has(jobId):
        events = eventHistoryStore.readAll(jobId)        # file lines, top-to-bottom = append order
        return { source: "durable", timeline: events.map(projectToTimelineEntry) }  # no re-sort
    if config:
        timeline = replayFromWorkspace(jobId, config)    # 3 points, pushed in fixed chronological order
        if timeline.length > 0: return { source: "workspace", timeline }
    return { source: "unavailable", timeline: [] }
```

**Why each source is independently correct, by construction:**

- **`runtime` (`TimelineStore`)**: `RuntimeEventBus.publish()` is fully synchronous —
  `emitter.emit(event.type, event); emitter.emit(WILDCARD, event);` (`runtimeEventBus.js:33-34`),
  no `await`, no `setImmediate`. `TimelineStore.record()`'s own docstring states the resulting
  guarantee directly: *"ordering is deterministic by construction: `RuntimeEventBus.publish()`
  dispatches synchronously and Node is single-threaded, so events land in exactly the order they
  were published — `record()` never reorders"* (`timelineStore.js:6-8`). `record()` simply
  `list.push(...)`s (`timelineStore.js:43`) — no sort step exists.
- **`durable` (`EventHistoryStore`)**: `EventHistoryBridge`'s `append()` call is a WILDCARD
  subscriber on the *same* bus, invoked from the *same* synchronous `emit()` call as
  `TimelineStore.record()` — EventEmitter invokes every registered listener for an event
  synchronously, in registration order, before `publish()` returns. Since JS is single-threaded,
  no second `publish()` call can begin until the first one (and everything it synchronously
  triggers) has finished — so consecutive `append()` calls for the same job happen in exactly
  bus-emission order, for the identical reason `TimelineStore.record()` does. `readAll()` reads
  the file with one `readFileSync` + `split("\n")` (top-to-bottom, no re-ordering possible for a
  single-writer, sequentially-appended local file) and performs no sort.
- **`workspace` (coarse fallback)**: `replayFromWorkspace()` pushes its three synthesized points
  in fixed source-order (queued → running → terminal, `replayEngine.js:26-47`) directly from
  `metadata.json`'s own timestamp fields — correct because that literal push order matches the
  job lifecycle's real order, not because anything is sorted afterward.
- **Cross-source**: never interleaved. This is the deliberate design choice that eliminates the
  hard version of this problem — a merge-sort of two independently-timestamped streams is never
  required because exactly one tier is chosen per call.

**One additional structural guarantee worth stating explicitly**: the `durable` tier can only
ever be reached for a job that is **already fully terminal or from a prior process**.
`TimelineStore` never evicts an in-flight job (`timelineStore.js:26`, *"never evict in-flight
jobs"*), so `timelineStore.has(jobId)` is true for any job still running in the *same* process —
meaning `durable` is only consulted once a job's event stream can no longer receive new writes
(either it settled and was later evicted, or the whole process — and therefore `TimelineStore`
itself — restarted). There is therefore no possibility of reading a durable log while it is
still being appended to.

### Q2 — Crash recovery (contrasted explicitly with `ADR-0005`)

| | `FileJobStore` (`ADR-0005`) | `EventHistoryStore` (this ADR) |
|---|---|---|
| Write primitive | temp-file `writeFileSync` + `renameSync` (whole-record rewrite) | single `appendFileSync` (grow-only, no rewrite) |
| What a mid-write crash can affect | only the record currently being rewritten | only the single most-recent, in-flight append |
| What can *never* corrupt | any file not mid-rename at crash time (rename is atomic on POSIX/NTFS) | **every previously-appended line, unconditionally** — there is no code path that ever rewrites a prior line |
| Recovery needed at startup? | **Yes** — Task 3's deterministic non-terminal→`failed` rewrite, because a "current status" can be observably stale/wrong after a crash | **No** — see below |

**What is guaranteed:** every event for which `append()` returned without throwing is durably
appended (at minimum to the OS page cache, which survives a killed *process* — as distinct from
an OS crash/power loss, which is out of scope here exactly as `ADR-0005`'s own testing plan
scoped "a real, uncontrolled process kill" as a separate, deliberately-scheduled concern rather
than something to guess at). Every line written before the crash is never touched again by any
later `append()` call, since appends only ever add to the end of the file.

**What can be lost:** at most one event — the single one being written at the exact instant of
the crash. Every earlier event for that job is unaffected.

**What can never become corrupted:** any event that was durably appended *before* the crash.
Because writes are append-only, there is no "current record" for a crash to tear — contrast
`FileJobStore`, where (absent the atomic rename `ADR-0005` added) a crash mid-`write` could have
corrupted the *only* copy of a job's entire current state.

**How startup recovery behaves: there is none, by design.** `EventHistoryStore` has no
construction-time hydration step at all — no `_hydrate()` equivalent, no eager
`readdirSync`/`readFileSync` pass. This is not an oversight; it follows directly from there
being nothing to fix: a past event doesn't have a "current status" that can become stale the way
a job's `status` field can. If the crash left a torn trailing line, the *next* time (if ever)
`readAll(jobId)` is called for that specific job, the per-line `try/catch` (Decision, above)
silently skips that one unparseable line, logs it, and returns every event that did parse — no
eager pass is needed because nothing needs fixing before that read happens, unlike
`FileJobStore`'s non-terminal-job rewrite, which must happen at construction time specifically
because an unfixed `status: "running"` would be an observably false, permanently-stuck value if
some caller queried it before any read-triggered fix could run. `EventHistoryStore` has no
equivalent "observably wrong until fixed" state to protect against.

### Q3 — Performance (estimates, evidence-anchored, one benchmark task added as a result)

The Persistent Job Store Sprint's own testing plan for `FileJobStore` was **explicit that
performance must be measured, not estimated** (`docs/superpowers/plans/persistent-job-store.md`
Task 5: *"a measured (not estimated) performance comparison"*). Answering this question honestly
means giving reasoned estimates *and* flagging that this ADR's Testing plan is missing the
equivalent measured-benchmark step `FileJobStore` had — **that gap is fixed below, in this same
round, as this question's one concrete amendment.**

Real measured data available to reason from — `FileJobStore`'s own benchmark
(`scripts/benchmark-job-store.js`), independently re-run by the controller during the prior
sprint's final gate: 200 jobs × (`create` + `update`, the only two disk-touching calls in that
script — `for (const id of ids) store.create(...); for (const id of ids) store.update(...)`,
`scripts/benchmark-job-store.js:14-15`) = 400 `writeFileSync`+`renameSync` pairs in 391.51ms ≈
**~0.98ms per write-and-rename pair** on the actual dev machine this project runs on.

- **Synchronous write cost**: `EventHistoryStore.append()` is one `appendFileSync` call — no
  `renameSync` step at all, so it should cost *less* than the ~0.98ms/write figure above (one
  syscall sequence instead of two). This is an estimate, not yet measured for this exact
  primitive on this machine.
- **Expected throughput**: per-job disk-write *count* could plausibly exceed `FileJobStore`'s
  (which writes ~2 times per job: create + one update per transition) — a job with several
  `JobStateChanged`/`JobProgress` ticks appends once per tick (real captures showed up to ~15
  `thinking_tokens`-driven progress events for one moderately complex task, `ADR-0002`'s
  "Observed protocol" section) — but each individual write is cheaper (no rename). Net
  throughput impact is a genuine open question, not asserted here as a single number.
- **Startup hydration cost: zero.** `EventHistoryStore` has no construction-time read at all
  (see Q2) — a real, measurable *advantage* over `FileJobStore`, whose `_hydrate()` pays an
  O(job count) `readdirSync`+`readFileSync`-per-file cost once at every process start.
- **Replay complexity**: O(n) in the number of non-`OutputChunk` events for the *one* job being
  replayed — one `readFileSync` (whole file) + `split("\n")` + one `JSON.parse` per line. This is
  a cold, rare path (only invoked when `replay()` is called for a specific job), never on the hot
  path (`getMetrics`/`getTimeline`/normal job execution).
- **Memory impact (steady-state)**: **zero additional resident memory.** Unlike `TimelineStore`
  (a bounded in-memory `Map`) or `FileJobStore` (a full in-memory cache of every job), this
  design holds no cache at all — memory is only touched transiently, during an actual `replay()`
  call, proportional to that one job's event count.
- **Disk growth**: unbounded without the Retention section's cap; with `maxEventHistoryFiles`
  (default 100, matching `maxWorkspaceHistory`), bounded to at most 100 jobs' `.jsonl` files.
  Rough estimate per typical job (lifecycle events: ~4 fixed + `JobProgress`: up to ~15 observed
  in a real capture, each line perhaps 100-300 bytes): on the order of a few KB per job, so
  roughly hundreds of KB total at the retention cap — small relative to `stdout.log`/`stderr.log`,
  which capture full raw CLI output. **Estimate, not measured.**

**Amendment made as a direct result of this question**: the Testing plan (below) and the
implementation plan's Task 5 are both updated to require a real, measured benchmark script
(`scripts/benchmark-event-history-store.js`, mirroring `scripts/benchmark-job-store.js`'s
existing shape) before this wave can be certified complete — every number above is explicitly
an estimate pending that measurement, consistent with this project's own "measured, not
estimated" standard.

### Q4 — Future consumers: Dashboard, REST API, Replay Viewer, Timeline UI, Analytics, Cost Explorer, Session Viewer, Search

Every one of these is a **presentation/transport layer over data two components already durably
own** — `Workspace` (`ADR-0001`, unchanged) and `ObservabilityService`/`ReplayEngine`
(`ADR-0003` + this ADR) — via `ObservabilityService`'s existing, frozen method set:

```
                    ┌─────────────────────────────────────────────────────┐
                    │              ObservabilityService (frozen API)       │
                    │  getMetrics() getTimeline() replay() getSnapshot()   │
                    │  registerConsumer()/listConsumers()/etc.             │
                    └───────────────────────┬───────────────────────────────┘
                                             │  every consumer below calls ONLY this API
        ┌──────────────┬──────────────┬─────┴──────┬──────────────┬───────────────┬────────────┐
        ▼              ▼              ▼            ▼              ▼               ▼            ▼
    Dashboard      REST API      Replay Viewer  Timeline UI    Analytics*    Cost Explorer**  Session   Search***
  getSnapshot()  1:1 endpoint   replay(jobId)  getTimeline()  (future new    (metadata.json/   Viewer    (future new
  getMetrics()   wrappers over  --gains the    (unchanged;    additive       JobCompleted's    replay()+ read-only
  (polling)      every method   new "durable"  same signature can also use  costUsd field,     workspace/ index over
                                tier for free)  it gains)      replay()'s    already durable     metadata.json/  workspace/
                                                                event data   today via           context.json/  event-history,
                                                                as raw input) ADR-0001's         stdout.log      same Extension
                                                                              metadata.json)                    Rules pattern
```

\* **Analytics** (cross-job trends, e.g. "average cost over 30 days"): the two currently-existing
durable sources (`workspace/jobs/*/metadata.json`, already storing `cost`/`runtimeMs` per
`ADR-0001:58`, and — once this ADR ships — `event-history/*.jsonl`) are exactly the raw data
such a feature would aggregate over. A cross-job aggregation method is a plausible **future**,
purely additive `ObservabilityService` method (e.g. `getHistoricalMetrics({since, until})`) —
not built by this ADR, but the durable data it would read already exists once this ADR ships,
with no redesign required to add that method later.

\*\* **Cost Explorer**: notably, basic historical cost-over-time **does not even require this
ADR** — `metadata.json` already durably persists `cost` per job today (`ADR-0001:58`). This ADR
adds event-level granularity (the exact `JobCompleted` event and its full payload) on top of
what `Workspace` already provides, strengthening rather than being a prerequisite for this
capability.

\*\*\* **Search**: a future read-only indexer over the same two durable sources — itself just
another `ObservabilityService`-adjacent, read-only consumer, following the identical Extension
Rules pattern `ADR-0003` already established for every other named future consumer
(`ADR-0003:280-294`) — never a redesign, never a second architecture.

**None of the eight require a new backend capability beyond what `ObservabilityService`'s
existing (or additively-extended) method set already provides** — confirming
`DASHBOARD_FOUNDATION.md`'s verdict extends cleanly to this fuller list.

### Q5 — Long-term architecture: is another migration ever required?

**For the five listed additions (this ADR, Dashboard, REST API, Plugin consumers, Analytics):
no contract-level migration is required.** Every one of them is designed as a pure additive
consumer of interfaces already frozen and explicitly designed for exactly this kind of
extension:

- `RuntimeEventBus`'s `{publish, subscribe, subscribeAll}` contract (`ADR-0002`) already states
  *"a future implementation (`MessageChannel`, RxJS, Redis, NATS, RabbitMQ) only has to satisfy
  this same three-function shape"* — the contract, not the `EventEmitter` internals, is what
  every consumer (including this ADR's new subscriber) depends on.
- `JobStore`'s 5-method interface (`ADR-0005`/`FOUNDATION_FREEZE.md`) already anticipates a
  future backend swap (*"a persistent store swaps in via `new JobManager({store})` without
  touching `JobManager` itself"*).
- `ObservabilityService`'s method-based facade (`ADR-0003`) is exactly what insulates every
  future consumer (Q4's table) from ever needing to know how data is stored underneath it.

**The one honest exception, explicitly out of current scope**: if a future requirement emerged
for genuinely distributed/multi-process/multi-tenant operation — beyond this project's own
repeatedly-stated scope boundary (`docs/releases/KNOWN_LIMITATIONS.md`: *"Single-process,
single-machine deployment — no distributed job execution, no clustering"*) — the *backing
implementations* behind these contracts (the in-process `EventEmitter`, flat per-job files) would
need to change to something concurrency-safe across processes (a real message broker, a real
database). This is a genuine future migration *of implementation*, not of *architecture* — every
contract above was deliberately designed so that swap would not require touching any consumer
built against it (Dashboard, REST API, this ADR's own `ReplayEngine` integration, etc.). No
evidence in this repository suggests that requirement is imminent or currently in scope; noted
here only for honesty, not as a prediction.

**Conclusion**: the architecture is stable for every capability currently named or reasonably
foreseeable within this project's stated single-process scope. It is not claimed to be
"permanently final" in the sense of never changing internals — only that its *consumer-facing
contracts* do not require another redesign for the five listed additions.

### Amendments made as a direct result of this round

1. **Testing plan** (below) and **implementation plan Task 5**
   (`docs/superpowers/plans/persistent-event-history.md`) both updated to require a real,
   measured `scripts/benchmark-event-history-store.js`, mirroring `FileJobStore`'s own
   measured-benchmark precedent — resulting from Q3.

No other question revealed a change to the Decision, Retention, or Compatibility sections below
— those stand as originally written.

**ADR-0006 is architecture-complete and implementation may begin**, once this document and the
amended implementation plan are approved.

## Architectural Verification (Round 1 — performed before drafting the Decision below)

### Documents re-read together as one architecture

`ADR-0001` (Workspace), `ADR-0002` (Event Bus), `ADR-0003` (Observability), `ADR-0005`
(Persistent Job Store), `ARCHITECTURE_REVIEW.md`, `REUSE_ANALYSIS.md`,
`CONSOLIDATION_PLAN.md`, `DASHBOARD_FOUNDATION.md`, `RECOMMENDATION.md`, plus both freeze
documents (`FOUNDATION_FREEZE.md`, `OBSERVABILITY_FREEZE.md`).

### Every existing component this ADR touches or deliberately does not

| Component | Touched? | How |
|---|---|---|
| `FileJobStore` | **No code reuse, pattern reuse only** | Not imported, not called. Its *shape* (opt-in config flag, atomic-enough write, safe hydration, reuse of `isValidJobId`) is the template this ADR's new module follows — see Decision. |
| `ObservabilityService` | **No** | Public method set, `replay(jobId)`'s call signature, and its internal `bus.subscribeAll()` fan-out (`metrics.record`/`timeline.record`) are all unchanged. It benefits indirectly (richer `replay()` results) with zero code change to this file. |
| `ReplayEngine` | **Yes — additive only** | Gains one new internal fallback tier function; `replay()`'s return shape (`{source, timeline}`) is unchanged, `source` gains one new possible value. See Decision. |
| `TimelineStore` | **No** | Remains exactly the volatile, bounded, in-memory "runtime" tier it already is. Not merged with, not replaced by, the new durable tier — see "No duplicated timeline implementation" below. |
| `SnapshotBuilder` | **No** | Unrelated to replay/history; concerns only live metrics/active-job snapshots. |
| `MetricsCollector` | **No** | A metric counting durable event-history writes would be a natural *future* addition (one `case`, per `ADR-0003`'s own extension mechanism) but is explicitly out of scope for this wave — no Dashboard/metrics surface is being built now, per the user's instruction. |
| `ConsumerRegistry` | **No** | No new consumer-facing surface is built this wave. |
| `RuntimeEventBus` | **No** | The new module is a fourth independent `bus.subscribeAll()` subscriber, exactly the extensibility `ADR-0002`'s own diagram already names (*"a new MCP-progress adapter, and anything added later"*) — the bus's contract does not change to support this. |
| `workspaceManager.js` | **No code change, function reuse** | `isValidJobId()` is imported and reused (already the established convention — `metricsCollector.js:4`, `replayEngine.js:4` do the same), no new path-construction logic written. |

### No duplicated persistence

The new module is the *only* thing that durably writes event data. `FileJobStore` persists job
*state* (current status/result — mutable-until-terminal); this ADR persists event *history*
(immutable, append-only facts). These are different data with different owners
(`FOUNDATION_FREEZE.md`: `JobManager`/its store owns state; `ADR-0003`'s Data Ownership table:
Observability owns *derived* views) — writing both is not duplication, it's two components each
owning what they already owned, per `ADR-0003`'s existing Data Ownership split. Within event
history itself: `OutputChunk` events are **excluded** from the durable log (see Decision) because
their content — raw stdout/stderr — is already durably owned by `workspaceManager.js`'s
`stdout.log`/`stderr.log` (`ADR-0001`). Logging `OutputChunk` again would violate `ADR-0003`'s
own rule: *"No component may duplicate another's ownership."*

### No duplicated event model

The new module writes `RuntimeEvent` objects (`src/models/runtimeEvent.js`) verbatim, one JSON
line per event — the same frozen shape `ADR-0002` already established
(`{eventId, timestamp, jobId, type, version, payload}`), the same `EVENT_SCHEMA_VERSION`. No new
event type, no new schema, no parallel event representation is introduced.

### No duplicated replay logic

`ObservabilityService.replay(jobId)` remains the single replay entry point. The new durable tier
is inserted *inside* `ReplayEngine.replay()`'s existing three-step priority chain (see Decision)
— there is no second `replay()`-like function anywhere else in the codebase.

### No duplicated timeline implementation

`TimelineStore` is not touched, extended, or reimplemented. The new module is not a second
`Map<jobId, TimelineEntry[]>` — it is a flat, append-only file per job with a much narrower
interface (`append(event)`, `readAll(jobId)`). It deliberately does **not** reimplement
`TimelineStore`'s bounded, oldest-terminal-first in-memory eviction logic; disk-backed history
has a different resource concern (total file count/disk usage, not RAM), addressed separately
(see Retention below) using the same *shape* of eviction policy as a convention, not shared code.

### Does this require changing any previously-approved ADR? No — and here is why, explicitly

- **`ADR-0001` (Workspace): untouched.** The new module's files live under their own
  independent root directory (`eventHistoryDir`, a new config field — see Decision), not inside
  `workspace/jobs/<id>/`. This was a deliberate design choice specifically to avoid touching
  `ADR-0001`'s frozen Directory layout section — mirroring exactly how `ADR-0005` already gave
  `FileJobStore` its own `jobStoreDir` rather than writing into the workspace directory, for the
  identical reason (*"Writing `FileJobStore`'s files into the same directory would blur that
  distinction,"* `ADR-0005`).
- **`ADR-0002` (Event Bus): untouched.** `RuntimeEventBus`'s `{publish, subscribe, subscribeAll}`
  contract does not change; a new subscriber requires no change to the bus itself — this is the
  bus's designed purpose.
- **`ADR-0003` (Observability): not amended — fulfilled.** `ADR-0003` itself names this exact
  extension and pre-authorizes a successor ADR to build it: *"a future ADR could add an
  append-only `events.jsonl` per job workspace if durable full-fidelity replay becomes a real
  requirement... Not designed here"* (`ADR-0003:245-246`). This ADR **is** that named successor.
  `ReplayEngine`'s change is additive (`source` gains a value) — per `OBSERVABILITY_FREEZE.md`'s
  own versioning policy, a new field/value with a safe default is **minor**, not the kind of
  change requiring "explicit user sign-off" reserved specifically for changes to the Passive
  Observation Rule or Dependency Direction (`OBSERVABILITY_FREEZE.md:108-110`) — neither of which
  this ADR touches (the new module still never calls `JobManager`, still never publishes to the
  bus, still only reads via `ReplayEngine`).
- **`ADR-0005` (Persistent Job Store): untouched.** Referenced only as a design pattern; no
  code or contract of `FileJobStore`/`JobStore` changes.
- **`FOUNDATION_FREEZE.md`: untouched.** No MCP schema change, no new tool, no `JobManager`
  method signature change.

**Conclusion of this section: no previously-approved ADR requires amendment.** Per the
governance gate's own instruction, this means the stop-and-request-approval trigger does not
fire — this ADR proceeds to a normal Decision, still gated on the user's sign-off on this
document as a whole (see Status).

### Dependency graph

```
                              RuntimeEventBus (ADR-0002, unchanged)
                                       │
        ┌──────────────────┬──────────┼──────────────────┬─────────────────────┐
        ▼                  ▼          ▼                  ▼                     ▼
workspaceEventBridge  mcpProgressAdapter  ObservabilityService        EventHistoryBridge (NEW)
 (execution pipeline)  (execution pipeline)  (observation, unchanged)   (durable event log writer)
        │                                       │                              │
        ▼                                       │                              ▼
  workspace/jobs/<id>/                           │                    <eventHistoryDir>/<id>.jsonl
  metadata.json, stdout.log,                     │                    (append-only, one line per
  stderr.log, result.json                        │                     RuntimeEvent, excludes
  (ADR-0001, unchanged)                           │                     OutputChunk)
        ▲                                         │                              │
        │                                         ▼                              │
        │                              ┌─────────────────────┐                   │
        │                              │  MetricsCollector    │                   │
        │                              │  TimelineStore       │                   │
        │                              │  (unchanged)         │                   │
        │                              └──────────┬───────────┘                   │
        │                                         ▼                              │
        │                              ┌─────────────────────┐                   │
        └──────────────read (coarse)───┤    ReplayEngine      ├───read (full)─────┘
                                       │  runtime > durable >  │
                                       │  workspace > unavail. │
                                       │  (MODIFIED: +1 tier)  │
                                       └──────────┬───────────┘
                                                  ▼
                                    ObservabilityService.replay(jobId)
                                       (signature unchanged, richer result)
```

`EventHistoryBridge` is a peer of `workspaceEventBridge`/`mcpProgressAdapter` — an
execution-pipeline-adjacent bus subscriber that durably persists, not an Observability-internal
component — matching `ADR-0003`'s own distinction between the two kinds of bus subscriber
(`ADR-0003:137-152`). `ReplayEngine` is the only Observability-side file that changes.

## Context

`ADR-0003`'s own Known Limitation, stated plainly: *"full-fidelity replay is only possible while
a job's timeline is still in `TimelineStore`'s retained window"* — `TimelineStore` is in-memory,
bounded (`maxTimelineHistory`, oldest-terminal-first eviction), and lost entirely on restart.
Today, once a job's timeline is evicted or the process restarts, `ReplayEngine` falls back to a
**coarse** reconstruction from `workspace/jobs/<id>/metadata.json` — three synthesized points
(queued, started, terminal), never the fine-grained `JobProgress` ticks a live job actually
produced. This ADR closes that gap the way `ADR-0003` itself already named: a durable,
append-only per-job event log, consulted by `ReplayEngine` as a new tier between the volatile
in-memory copy and the coarse workspace fallback.

## Goals

- `replay(jobId)` returns full-fidelity history (not the coarse 3-point reconstruction) for any
  job whose event history was durably logged, even after `TimelineStore` has evicted or lost it.
- Zero change to `ObservabilityService`'s public method set or any MCP tool schema.
- Zero change to default behavior — opt-in via a new config flag, exactly `ADR-0005`'s precedent.
- No duplicated data: `OutputChunk` (already durably in `stdout.log`/`stderr.log`) is excluded.
- No new production dependency — synchronous `node:fs` append, matching `FileJobStore`'s and
  `workspaceManager.js`'s established pattern.
- Simpler than `FileJobStore`'s persistence problem, not harder: append-only historical facts
  need no non-terminal-job "recovery" mutation on restart (see Decision).

## Decision

New module `src/services/eventHistoryStore.js` plus a thin bus-wiring function (co-located,
mirroring `workspaceEventBridge.js`'s file shape):

```js
export function createEventHistoryStore({ dir, logger }) {
  function append(event) { ... }        // fs.appendFileSync(<dir>/<jobId>.jsonl, JSON.stringify(event) + "\n")
  function readAll(jobId) { ... }       // fs.readFileSync + split lines + JSON.parse each, skip unparseable lines (logged, never thrown)
  function has(jobId) { ... }           // fs.existsSync(<dir>/<jobId>.jsonl)
  return Object.freeze({ append, readAll, has });
}

export function wireEventHistoryToEventBus({ bus, eventHistoryStore, logger }) {
  return bus.subscribeAll((event) => {
    if (event.type === EVENT_TYPES.OUTPUT_CHUNK) return; // already durable via stdout.log/stderr.log
    eventHistoryStore.append(event);
  });
}
```

**Append, not atomic-rewrite.** Unlike `FileJobStore` (which rewrites a whole small object per
transition), event history only ever grows — `fs.appendFileSync` is the correct primitive, not
temp-file+rename. A crash mid-append can leave a torn **final line only** (never corrupts prior
lines, since each prior `append()` call already returned/flushed before the next one starts —
`jobManager.js`'s bus publishes are synchronous and Node is single-threaded, matching
`TimelineStore`'s own ordering guarantee, `timelineStore.js:6-8`). `readAll()` must tolerate one
trailing unparseable line: skip it, log it, return every line that did parse — the same
fail-safe discipline `FileJobStore._hydrate()` established for whole-file corruption, applied
here to a single line instead of a single file.

**No non-terminal-job recovery mutation needed — a real simplification vs. `FileJobStore`.**
An event log records what already, immutably happened; there is nothing to "fix" about a
recorded `JobStateChanged{to:"running"}` event after a crash — it remains a true historical fact
forever. This eliminates `FileJobStore`'s single hardest piece of logic (Task 3's non-terminal
recovery, `ADR-0005`) entirely; `EventHistoryStore` needs no equivalent.

**Own directory, own config flag — opt-in, default unchanged.** New config fields
`eventHistoryDir` (env `CLAUDE_DELEGATE_EVENT_HISTORY_DIR`, default
`<project>/event-history`) and `eventHistory` (env `CLAUDE_DELEGATE_EVENT_HISTORY`, default
`"memory"` — i.e. off, matching `TimelineStore`-only behavior today — accepts `"memory"` or
`"file"`, same naming discipline `ADR-0005` established for `jobStore`). `mcpServer.js` wires
`wireEventHistoryToEventBus` only when `config.eventHistory === "file"`; otherwise nothing new
runs, byte-identical to today.

**`ReplayEngine` gains one new tier.** `replay(jobId)`'s priority becomes:
1. `runtime` — `TimelineStore.has(jobId)` (unchanged, full fidelity, volatile).
2. **`durable`** (new) — `eventHistoryStore.has(jobId)`: read every logged event via
   `readAll(jobId)`, project to the same `TimelineEntry` shape (`{eventId, timestamp, type,
   payload}`) `getTimeline()` already returns — full fidelity, survives restart, missing only
   whatever `OutputChunk` events were deliberately excluded.
3. `workspace` — unchanged, coarse, the existing fallback for jobs with no durable log (e.g.
   history from before this feature was enabled, or `eventHistory` left off).
4. `unavailable` — unchanged.

`ObservabilityService.replay()`'s call signature is untouched; only `replayEngine.js`'s internal
function gains a branch, matching `ADR-0003`'s statement that `source` may grow new values
additively.

## Retention

Mirrors the oldest-terminal-first eviction shape already used three times in this codebase
(`JobManager._trimHistory()`, `workspaceManager.pruneWorkspaces()`, `TimelineStore`'s own
eviction, `ADR-0003:209-213` — which already flagged this as "worth a shared `boundedEvict()`
utility... not mandated" for a *future* refactor, not required now). A new
`maxEventHistoryFiles` config field (default matching `maxWorkspaceHistory`'s `100`, for
consistency) triggers deletion of the oldest **completed** job's `.jsonl` file once the cap is
exceeded — a job's own directory-listing timestamp (file mtime) or a lightweight manifest is
sufficient; no new component-wide index is required. An in-flight job's log file is never
evicted, matching every prior instance of this pattern in this codebase.

## Explicitly out of scope this wave

- Any Dashboard, REST API, CLI Dashboard, VSCode extension, Prometheus/Grafana adapter, or new
  MCP tool (e.g. `delegate_metrics`) — per the user's explicit instruction and `ADR-0003`'s own
  Extension Rules table, all remain future waves, unaffected by this ADR.
- A `MetricsCollector` field counting event-history writes/file sizes — a natural, small future
  addition (one `case`, per `ADR-0003`'s dispatch-map mechanism), not built now.
- Fixing `ObservabilityService`'s `close()`-not-actually-wired-to-shutdown gap
  (`ARCHITECTURE_REVIEW.md`) — unrelated to event history specifically, but flagged as a small,
  isolated fix worth bundling into this wave's implementation plan since related files
  (`mcpServer.js`) are already being touched.
- Any backend other than flat append-only files — no SQLite, no external log shipping.
- Compaction/rotation *within* a single job's growing `.jsonl` file (e.g. splitting a
  long-running job's log) — `maxEventHistoryFiles` caps file *count*, not per-file growth; no
  evidence yet that any job produces enough non-`OutputChunk` events to make this a real
  problem (lifecycle events are a handful per job; only `JobProgress` repeats, and observed
  real captures show on the order of tens per task, `ADR-0002`'s "Observed protocol" section).
- Live verification against an actual uncontrolled process kill — same deliberate deferral
  `ADR-0005` already applied to its own atomic-write guarantee, for the same reason (a
  controlled-restart test proves the mechanism; a fuzzed kill-signal experiment is a separate,
  deliberately-scheduled concern).

## Testing plan

Unit (`eventHistoryStore.js` in isolation, real temp directory, not mocked `fs`, matching
`FileJobStore`'s/`workspaceManager.js`'s established style): `append()` writes one JSON line per
call; `readAll()` returns every appended event in order for a job with no writes; a corrupted
trailing line is skipped and logged, prior lines still returned; `has()` reflects whether any
file exists for a job id; `isValidJobId()` rejected before any path is constructed (security
regression, mirroring `FileJobStore`'s own equivalent test). Integration: a real
`RuntimeEventBus` + `wireEventHistoryToEventBus` + a full job lifecycle, then a **second**
`EventHistoryStore` instance over the same directory reads back the exact same events — the
actual "survives a restart" property, proven. `ReplayEngine` gains new tests: a job whose
`TimelineStore` entry was evicted (or a fresh instance simulating restart) but has a durable log
returns `source: "durable"` with full fidelity; a job with neither durable log nor `TimelineStore`
entry still falls back to `source: "workspace"`, unchanged; `OutputChunk` events are confirmed
absent from a durable log even when the original job produced them.

**Performance: measured, not estimated** (added per this ADR's Final Pre-Implementation
Verification, Q3). `scripts/benchmark-event-history-store.js`, mirroring
`scripts/benchmark-job-store.js`'s exact shape: append N events for a job, measure real
wall-clock `appendFileSync` cost per call; compare against `FileJobStore`'s own already-measured
per-write cost as a reference point. The actual printed output goes into the implementation
report verbatim, not rounded or guessed — same discipline `ADR-0005`'s Task 5 established.

## Compatibility impact

None on `FOUNDATION_FREEZE.md` or `OBSERVABILITY_FREEZE.md`'s existing guarantees. Zero MCP
schema change. Two new optional config fields (`eventHistory`, `eventHistoryDir`, plus
`maxEventHistoryFiles`), all defaulting to today's exact behavior. `ReplayEngine`'s `source`
return value gains one new possible value (`"durable"`) — additive per
`OBSERVABILITY_FREEZE.md`'s own minor-version policy.

## Alternatives considered

- **Store durable event history inside `workspace/jobs/<id>/`, alongside `metadata.json`**:
  rejected — would require amending `ADR-0001`'s frozen Directory layout section, triggering
  this review's own stop-and-ask gate unnecessarily, when an independent directory (mirroring
  `ADR-0005`'s `jobStoreDir` precedent exactly) achieves the same goal without touching any
  previously-approved ADR.
- **Store raw `RuntimeEvent` objects verbatim and project to `TimelineEntry` only at read
  time** (vs. projecting at write time): accepted as designed — `readAll()` stores the
  event's own bus-published shape and projects to `TimelineEntry` on read, keeping full
  fidelity (nothing is discarded at write time) while still returning the exact shape
  `getTimeline()`'s callers already expect.
- **Logging `OutputChunk` events too, for true 1:1 completeness**: rejected — duplicates data
  `stdout.log`/`stderr.log` already durably own, violating `ADR-0003`'s Data Ownership rule for
  no benefit (a replay consumer wanting raw output already has `workspace/jobs/<id>/stdout.log`).
- **Merging this into `TimelineStore` itself (make it disk-backed instead of in-memory)**:
  rejected — `TimelineStore`'s whole design point is being the *fast*, bounded, in-memory tier;
  making it disk-backed would slow down `getTimeline()`'s hot path for every live job and blur
  the "runtime vs. durable" distinction `ReplayEngine`'s tiered fallback already models cleanly.
  Two separate, simple components (one fast+volatile, one durable+append-only) are easier to
  reason about and test than one component doing both jobs.
- **A single shared `boundedEvict()` utility for `TimelineStore`/`workspaceManager`/
  `EventHistoryStore`** (per `ADR-0003`'s own noted-but-not-mandated idea): rejected for this
  ADR specifically — refactoring already-shipped eviction code is out of scope for a wave whose
  goal is adding a new capability, not restructuring existing ones; noted again here as a
  legitimate future cleanup, still not mandated.
