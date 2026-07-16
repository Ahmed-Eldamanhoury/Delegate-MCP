# Consolidation Plan — Observability Stack + Persistent Event History

**Framing:** this is a migration/extension strategy, not a deletion proposal, per this
review's explicit constraint. Nothing here removes a component; every phase adds durability
underneath the existing, frozen `ObservabilityService` API. This document is a high-level
phase outline for the architecture decision — the detailed, task-by-task TDD plan (exact code,
exact test bodies, per this project's established process) is a separate deliverable to be
written *after* a new ADR is accepted, matching how `ADR-0005`'s own implementation plan
(`docs/superpowers/plans/persistent-job-store.md`) followed its ADR rather than preceding it.

## Precondition: a new ADR, not a silent change

`OBSERVABILITY_FREEZE.md:105-110` states plainly: *"No entry above changes without an ADR
amendment (ADR-0003 or a successor)... The Passive Observation Rule and Dependency Direction
are the highest-scrutiny surfaces — any change there requires explicit user sign-off."* Adding
durable storage touches this document's "Extension points" section (`OBSERVABILITY_FREEZE.md:79-81`,
"Durable full-fidelity replay... not built") and `ReplayEngine`'s documented source-priority
contract. **A new ADR (proposed: ADR-0006, "Persistent Event History") is required before any
implementation begins**, per both this repo's own freeze-document policy and the user's
explicit process requirement. This plan does not substitute for that ADR — it is the shape that
ADR's Decision section would take, offered here as evidence for `RECOMMENDATION.md`'s verdict.

## Phase outline

### Phase A — `EventHistoryStore` module (new, isolated, unit-tested alone)

A new `src/services/eventHistoryStore.js`, following `FileJobStore`'s proven shape
(`REUSE_ANALYSIS.md`): one append-only file per job under a configurable directory (e.g.
`<jobStoreDir-sibling>/event-history/<job-id>.jsonl`), one JSON line per `RuntimeEvent`. No
wiring into the bus yet — built and tested standalone first, exactly how `FileJobStore` itself
was Task 1 of its own plan before any wiring happened in Task 2.

Key design questions an ADR must resolve before this phase starts (flagged, not decided here):
- Does it log every event type, or exclude high-frequency `OutputChunk` (per `ADR-0002`'s own
  flagged risk, `ADR-0002:328`)? `REUSE_ANALYSIS.md`'s point 2 explains why this matters more
  here than it did for job-state persistence.
- Retention/rotation policy for a long-lived job's growing `.jsonl` file, and for old jobs'
  files in general (mirroring `JobManager._trimHistory()`/`workspaceManager.pruneWorkspaces()`'s
  existing bounded-eviction precedent — `ADR-0003:209-213` already names this as a shared shape
  worth a common utility).
- Where the directory lives: a sibling of `jobStoreDir` (its own config field, matching
  `ADR-0005`'s independent-cap precedent: *"in-memory job records and on-disk artifact
  directories are different resources with potentially different useful retention windows... kept
  as a separate, independently configurable cap"*, `ADR-0001:108-111`) vs. inside each job's
  existing `workspace/jobs/<id>/` directory (`ADR-0001`'s layout already reserves room for
  exactly this kind of addition via its Extension points, `ADR-0001:66-68`). The workspace
  directory is the more consistent home: it already holds `metadata.json` (which `ReplayEngine`'s
  workspace tier reads today), so an `events.jsonl` living alongside it keeps one job's durable
  record in one place, and reuses `getWorkspaceRoot()`/`isValidJobId()` directly rather than
  introducing a second root directory concept.

### Phase B — Wire as a bus subscriber, opt-in, default unchanged

Exactly `ObservabilityService`'s own pattern: a `bus.subscribeAll()` call, gated by a new config
flag (default off, matching `ADR-0005`'s "byte-for-byte unchanged at every default" discipline).
This is additive-only to `mcpServer.js` — no existing subscriber, no existing method signature,
touched.

### Phase C — Extend `ReplayEngine`'s fallback chain

Insert a new tier between `runtime` and `workspace`:
`runtime (TimelineStore, full fidelity, volatile)` → **`durable (events.jsonl, full fidelity,
survives restart)`** → `workspace (coarse, metadata.json only)` → `unavailable`. This changes
`replayEngine.js`'s internal logic only — `ObservabilityService.replay(jobId)`'s signature and
return shape (`{source, timeline}`) are unchanged; `source` simply gains a fourth possible
value alongside the three already documented in `OBSERVABILITY_FREEZE.md:18`. This is additive
per that document's own versioning policy ("new... field with a safe default" = **minor**, not
**major** — `OBSERVABILITY_FREEZE.md:99-100`).

### Phase D — Fix the discovered `close()` wiring gap

Independent of the durability feature itself: `mcpServer.js` should retain the
`ObservabilityService` instance it constructs and `entry.js`'s shutdown path should call its
`close()`, making `OBSERVABILITY_FREEZE.md`'s existing "Resource cleanup" claim (`:310`) true
rather than aspirational. Small, isolated, no behavior change under normal operation (the
process exit already reclaims the subscription) — worth bundling into this wave since the code
is being touched anyway, not a reason to delay the wave on its own.

### Phase E — Docs

`OBSERVABILITY_FREEZE.md`'s Extension Points section (currently: *"not built, since nothing
currently requires it"*) updated to reflect the shipped durability tier; `CHANGELOG.md`/
`docs/releases/KNOWN_LIMITATIONS.md`/`SUPPORTED_FEATURES.md` reconciled, following exactly the
Task 6 pattern this sprint just used for `FileJobStore`.

### Explicitly out of scope for this wave (per the user's own instruction)

No Dashboard, REST API, CLI Dashboard, VSCode extension, Prometheus/Grafana adapter, or new MCP
tool (e.g. `delegate_metrics`) is designed or built in this wave. `ObservabilityService`'s
public method set and `RECOMMENDATION.md`'s verdict on its role as foundation are unaffected by
deferring these — they remain future waves exactly as `ADR-0003`'s Extension Rules table
already states, now with a durable read tier underneath them once this wave ships.

## Why this is consolidation, not the two systems staying parallel forever

Without this wave, `claude-delegate-mcp` would have **two** independent "make history durable"
answers evolving separately: `FileJobStore` for job *state*, and nothing yet for event
*history* — with `ReplayEngine`'s own coarse workspace fallback silently standing in as a
partial, undocumented answer to the same question `ADR-0003` explicitly deferred. This plan
converges them onto one coherent story: `JobManager`/`FileJobStore` remain the single source of
truth for *current* job state (`FOUNDATION_FREEZE.md:46-48`, unchanged by this plan);
`ObservabilityService`/`ReplayEngine` remain the single source of truth for *derived, read-only,
historical* views (`ADR-0003`'s Data Ownership table, unchanged by this plan) — durability is
added *underneath* the second, without either one absorbing the other's responsibility.
