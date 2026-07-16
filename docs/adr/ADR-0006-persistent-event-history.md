# ADR-0006: Persistent Event History

## Status

**Proposed — pending user sign-off before implementation.** Written per the recommendation
in `RECOMMENDATION.md` (Observability Architecture Review): extend the existing
`ObservabilityService`/`ReplayEngine` stack rather than replace it. This ADR includes an
Architectural Verification section (below) performed before this document was written, per
an explicit governance gate: confirm this design extends existing architecture, touches no
previously-approved ADR's frozen guarantees, and introduces no duplicated persistence, event
model, replay logic, or timeline implementation.

## Architectural Verification (performed before drafting the Decision below)

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
