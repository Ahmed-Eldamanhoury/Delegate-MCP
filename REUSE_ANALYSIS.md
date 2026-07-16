# Reuse Analysis — FileJobStore/ADR-0005 vs. TimelineStore/ReplayEngine

**Purpose:** determine whether the Persistent Job Store Sprint's pattern (just shipped,
`docs/adr/ADR-0005-persistent-job-store.md`, `src/services/fileJobStore.js`) can be reused for
the requested "Persistent Event History + Replay Engine" wave, rather than inventing a new
persistence design from scratch.

## The parallel, stated precisely

| | Job state (before ADR-0005) | Event history (today) |
|---|---|---|
| Lives in | `InMemoryJobStore` (`src/services/jobStore.js`) | `TimelineStore` (`src/services/timelineStore.js`) |
| Storage | `Map<jobId, Job>` | `Map<jobId, TimelineEntry[]>` |
| Survives restart? | No (fixed by `FileJobStore`) | **No** — in-memory only, and additionally bounded/evictable even within one process run (`timelineStore.js:23-31`) |
| Consumed via | `JobManager.get/list` → `delegate_status`/`delegate_history` | `ObservabilityService.getTimeline`/`.replay` → **no consumer yet** |
| Interface swapped via | `new JobManager({ store })` — a documented extension point (`FOUNDATION_FREEZE.md:57-59`) | `ObservabilityService`'s internal construction of `TimelineStore`/`ReplayEngine` — **not yet an injectable extension point**, but the same shape (see below) |

The structural shape is nearly identical: a `Map`-backed, in-memory, restart-fragile store,
with a documented extension mechanism for a future durable implementation. ADR-0003 said this
outright before ADR-0005 existed to point back to: *"a future ADR could add an append-only
`events.jsonl` per job workspace if durable full-fidelity replay becomes a real requirement...
Not designed here"* (`ADR-0003:245-246`, repeated in `OBSERVABILITY_FREEZE.md:79-81` as a named
Extension Point). ADR-0005 is the proof this exact pattern (in-memory Map → opt-in file-backed
persistence, zero default-behavior change) works in this codebase, shipped, tested, reviewed,
merged.

## What FileJobStore's design directly reuses

1. **Opt-in via config flag, default unchanged.** `CLAUDE_DELEGATE_JOB_STORE=file` /
   `CLAUDE_DELEGATE_JOB_STORE_DIR` (`src/config/index.js:290-291`), validated by
   `validateConfig` (`src/validation/configValidation.js:27-32`). An event-history durability
   flag should follow the identical shape: e.g. `CLAUDE_DELEGATE_EVENT_HISTORY=file` /
   `CLAUDE_DELEGATE_EVENT_HISTORY_DIR`, same validation pattern, same "byte-identical when
   unset" guarantee `ADR-0005` and `FOUNDATION_FREEZE.md` both require.
2. **One file per entity, atomic writes.** `FileJobStore._write()` uses temp-file +
   `renameSync` (`fileJobStore.js:80-89`) so a crash mid-write never corrupts the readable
   file. An event-history writer doing `appendFileSync` per event doesn't need the same
   temp+rename dance (appends are not full-file rewrites), but the *directory-per-entity, one
   physical file per job* layout is directly reusable.
3. **Hydration at construction, never throws on one bad file.** `FileJobStore._hydrate()`
   (`fileJobStore.js:37-77`) skips corrupted/unparseable files (logged, not thrown) and — after
   this sprint's own final-gate fix (`1ac99d9`) — trusts the filename-derived id over untrusted
   file content. Both properties transfer directly: an event-log reader must not crash the
   server over one malformed `events.jsonl` line, and must trust the filename (job id), never
   content, for path construction.
4. **`isValidJobId`/`getWorkspaceRoot` reuse, not re-derivation.** `metricsCollector.js:4,40`
   and `replayEngine.js:4,15` already import these from `workspaceManager.js` rather than
   reinventing path validation — this is the established convention
   (`ADR-0003`'s own Security section: "Workspace isolation: ... no new path-construction
   logic, no new attack surface," `ADR-0003:308`). Any new persistence code must do the same.
5. **`RuntimeEventBus.subscribeAll()` as the single write-triggering hook.** `ObservabilityService`
   already demonstrates the exact subscription shape (`observabilityService.js:32-35`) a
   durable event writer would use — no new bus contract needed, `ADR-0002`'s bus is already the
   correct integration point.
6. **Independent verification discipline.** ADR-0005's task-by-task TDD process (RED before
   GREEN, full-suite-green after every task, a dedicated task reviewer, a final whole-branch
   review, a ponytail pass) is the same process this review's own required workflow calls for —
   directly transferable, not something to redesign.

## Where the two problems genuinely differ (do not force-fit)

1. **Mutable current-state vs. immutable append log.** `FileJobStore` stores a job's *latest*
   state — every `update()` overwrites the previous on-disk record (hence temp+rename). An
   event history is *append-only by nature* — every `RuntimeEvent` is an immutable historical
   fact, never revised. This means:
   - No "cache pollution on error" class of bug (the one real defect `FileJobStore` had,
     `1f181cc`) — there's no update-then-invalid-id path to protect, since appends don't
     mutate prior lines.
   - **No non-terminal-job "recovery" mutation is needed.** `FileJobStore`'s hardest piece of
     logic (Task 3, `3163492`) was rewriting a crashed-mid-flight job's status to `failed`
     deterministically. An event log has nothing analogous to fix on restart — a past event is
     simply true forever; there is no "was this event left in an invalid state by a crash"
     question to answer. **This makes durable event history a strictly simpler persistence
     problem than durable job state was**, not a harder one.
   - Atomicity risk is smaller in kind, not absent: an `appendFileSync` interrupted mid-write
     (e.g. process killed mid-flush) can leave a torn *final line*, not a torn *entire file* —
     a reader must tolerate one trailing unparseable line (skip it, log it, same as
     `FileJobStore`'s corrupted-file handling), not lose the whole job's history the way a torn
     `metadata.json` would.
2. **One entity per file vs. many events per file.** `FileJobStore` performs full-file
   overwrites of small, bounded objects (one `Job`). Event history is unboundedly growing
   *within* a job's lifetime (every `JobProgress`/`OutputChunk` tick). File size, not file
   count, is the governing resource question — `ADR-0002`'s own Risk table already flags
   `OutputChunk` as high-frequency (`ADR-0002:328`), a risk that didn't exist for job-state
   persistence at all. Any implementation plan must address this explicitly (e.g. whether
   `OutputChunk` is durably logged at all, or only the lower-frequency lifecycle/`JobProgress`
   types — a design decision for the ADR, not assumed here).
3. **Replay's fallback chain already exists — this is an insertion, not new plumbing.**
   `ReplayEngine.replay()` (`replayEngine.js:64-79`) already implements the exact `runtime >
   ??? > unavailable` priority chain a durable log would slot into as a new middle tier: today
   it's `runtime (TimelineStore) → workspace (coarse, metadata.json) → unavailable`; a durable
   `events.jsonl` tier would sit between `runtime` and `workspace`, upgrading the fallback from
   *coarse* to *full-fidelity* once TimelineStore's in-memory copy is gone (evicted or a
   restart). This is additive to an existing, tested function — not a redesign of it.

## Conclusion

Reuse the `FileJobStore`/ADR-0005 pattern's *shape* (opt-in config flag, per-job directory,
atomic-enough writes, safe hydration, zero default-behavior change, reuse of
`isValidJobId`/`getWorkspaceRoot`) for the write side, and reuse `ObservabilityService`/
`ReplayEngine`'s *existing frozen API* for the read side — insert a new tier into
`ReplayEngine.replay()`'s fallback chain rather than replacing any of it. No component in the
Observability stack needs to be rewritten; a new, small event-history-writer module is the only
new production code this implies, following an already-proven pattern. See
`CONSOLIDATION_PLAN.md` for the phased strategy.
