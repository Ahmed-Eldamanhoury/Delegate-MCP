# Recommendation — Observability Architecture Review

## The question this document must explicitly answer

*"Should the existing Observability architecture become the foundation of the upcoming
Dashboard, REST API, Replay, Timeline and Analytics capabilities, or should it be replaced?"*

## Answer: **Become the foundation. Extend it; do not replace it.**

## Evidence supporting this verdict

1. **It is deliberately-ahead-of-consumers infrastructure, not abandoned work.**
   `ADR-0003`'s Status line and Alternatives section state outright that it was built before any
   consumer exists, specifically to prevent every future consumer from re-deriving its own
   metrics/timeline/retention logic (`ARCHITECTURE_REVIEW.md`, "Is this 'ahead of time' by
   design"). This was reviewed and accepted, not overlooked.

2. **It is not dead code.** Every component's write path (`metrics.record()`/`timeline.record()`)
   executes on every real job today, confirmed by direct source reading, not inference. A
   repo-wide grep confirms zero read-path callers outside the subsystem's own files and its
   `mcpServer.js` construction call — this is "unconsumed," a data-availability gap, not
   "unreachable" (`ARCHITECTURE_REVIEW.md`).

3. **It is production-quality by every available measure.** 54 dedicated tests, all passing;
   structural (not conventional) enforcement of the Passive Observation Rule; bounded memory by
   design (O(1) metrics, oldest-terminal-first timeline eviction); zero known defects in the
   components' own logic. The one real defect found during this review — `ObservabilityService`'s
   `close()` never actually being wired into `entry.js`'s shutdown path, despite
   `OBSERVABILITY_FREEZE.md` claiming it is — is a small, isolated wiring gap with no observable
   runtime consequence today, not evidence of a broken architecture (`ARCHITECTURE_REVIEW.md`).

4. **Every documented future consumer (Dashboard, CLI Dashboard, VSCode extension, REST API,
   Prometheus, Grafana, a future `delegate_metrics` MCP tool) is already designed against this
   exact API**, per `ADR-0003`'s own Extension Rules table. None of them need a different or
   additional API shape — they need transport, which is out of scope for every wave including
   this one (`DASHBOARD_FOUNDATION.md`).

5. **The requested next wave (durable event history + replay) is not new architecture — it is
   the literal follow-on ADR-0003 already named and deferred**: *"a future ADR could add an
   append-only `events.jsonl` per job workspace if durable full-fidelity replay becomes a real
   requirement... Not designed here"* (`ADR-0003:245-246`, restated as a named Extension Point in
   `OBSERVABILITY_FREEZE.md:79-81`). This review's premise — "is the user asking to rebuild
   something that already exists?" — resolves to: no, the user is asking for the specific,
   already-anticipated next increment on top of what exists.

6. **The just-shipped `FileJobStore`/ADR-0005 pattern transfers directly** to this problem's
   write side (opt-in config flag, per-entity file, safe hydration, zero default-behavior
   change), and is in some respects an easier fit here than it was for job state, since an
   append-only event log needs no "recovery" mutation on restart the way crashed job state did
   (`REUSE_ANALYSIS.md`). There is no architectural reason to design a new persistence primitive
   from scratch.

7. **Replacing the architecture would recreate the exact coupling `ADR-0003` exists to prevent**
   — a Dashboard or REST API built directly against `RuntimeEventBus`, bypassing
   `ObservabilityService`, would duplicate metrics aggregation, timeline reconstruction, and the
   Passive Observation Rule's enforcement in a second place (`DASHBOARD_FOUNDATION.md`).

## What this recommendation does *not* say

- It does not say the subsystem is finished or beyond improvement — Phase D of
  `CONSOLIDATION_PLAN.md` names one real, fixable gap (`close()` wiring).
- It does not authorize building a Dashboard, REST API, or any new MCP tool now — those remain
  explicitly deferred, per the user's own instruction and `ADR-0003`'s own Extension Rules table.
- It does not claim `ObservabilityService`'s current API is permanently final — it claims it is
  the correct one to *extend* (additively, per `OBSERVABILITY_FREEZE.md`'s minor-version rule)
  rather than to abandon in favor of something new.

## Required next steps, in order (per the user's own stated process)

1. **Write ADR-0006** ("Persistent Event History"), scoping exactly the open design questions
   `CONSOLIDATION_PLAN.md` Phase A flags (event-type filtering, retention/rotation, directory
   placement) — this review recommends a decision but does not itself constitute the ADR.
2. Only after ADR-0006 is accepted: a task-by-task implementation plan (mirroring
   `docs/superpowers/plans/persistent-job-store.md`'s own structure), TDD execution, independent
   task review, a ponytail pass, whole-repository verification, and final certification — the
   same process this sprint just used, applied to the new wave.
3. Fix the `close()` wiring gap as part of that same wave (Phase D), since the code is already
   being touched.

## Constraints this recommendation is bound by, and confirms are satisfiable

- **Backward compatibility**: preserved — every change identified is additive (new config
  field defaulting off, a new `source` value, no existing method signature touched).
- **MCP schema unchanged**: preserved — no new MCP tool is proposed or required by this wave;
  `FOUNDATION_FREEZE.md`'s frozen six tools are untouched.
- **No production code deleted, no subsystem removed for having no consumers, frozen
  architecture respected**: this document's verdict is itself the mechanism by which those
  constraints are honored — extension was chosen specifically because it satisfies all three
  simultaneously, not despite them.
