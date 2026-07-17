# Stage 1b Design Package — DelegationService Refactor

**Scope:** implementation design for `ADR-0010`'s Stage 1b, following `ADR-0010_REVIEW_PACKAGE.md`'s
approval-with-minor-changes and Stage 1a's certified characterization suite (301/301 tests,
`24086b8`). **Design only — no production code, no refactoring, in this document or this sprint.**
Gated for implementation approval; nothing here authorizes writing code.

---

## 1. DelegationService Architecture Specification

### Responsibilities

`DelegationService` is the write-side counterpart to `ObservabilityService`: the single object
every transport adapter calls to submit, query, list, or cancel a job. It owns exactly two kinds
of logic, both additive and already decided in `ADR-0010` §2/§4 — nothing new is introduced here:
input validation (reusing the existing `DelegateTaskInputSchema`) and view/summary shaping
(reusing the existing `toJobView`/`summarizeJob` plus the filter/pagination logic moved out of
`delegateHistoryHandler.js`). It owns no business/domain logic, no state, and no bus coupling
beyond forwarding an existing reference.

### Public API

```js
// src/services/delegationService.js
export function createDelegationService({
  jobManager,
  config,
  logger,
  service = defaultClaudeCliService,      // same default submitDelegation() already has (delegationService.js:32)
  workspace = defaultWorkspaceManager,    // same default submitDelegation() already has (delegationService.js:33)
}) {
  return Object.freeze({
    submit(input, toolName) {
      DelegateTaskInputSchema.parse(input);           // new: validates, throws ZodError on failure
      const context = createExecutionContext(input, config);
      const jobId = jobManager.submit(
        (signal, markRunning, jobId) => service.invoke(input.prompt, context, config, { signal, onSpawn: markRunning, bus: jobManager.bus, jobId }),
        { tool: toolName, ...context.metadata }
      );
      workspace.createJobWorkspace(jobId, context, config, logger);
      return jobId;
    },
    getJob(jobId) {
      const job = jobManager.getJob(jobId);
      return job ? toJobView(job) : undefined;
    },
    listJobs({ status, limit = 20 } = {}) {
      let jobs = jobManager.listJobs();
      if (status) jobs = jobs.filter((j) => j.status === status);
      return jobs.slice(-limit).reverse().map(summarizeJob);
    },
    cancelJob(jobId) {
      return jobManager.cancelJob(jobId);
    },
  });
}
```

`submit`'s body is today's `submitDelegation()` verbatim (**including its `service`/`workspace`
default parameters** — production calls `createDelegateTaskHandler({config, logger, jobManager})`
and `createDelegateSubmitHandler({config, logger, jobManager})` with neither `service` nor
`workspace` supplied, `src/server/mcpServer.js:144,155`; omitting these defaults from the factory
would throw on every real `delegate_task`/`delegate_submit` call — an adversarial review pass on
this design caught an earlier draft that dropped them), plus one new line
(`DelegateTaskInputSchema.parse(input)`). `getJob` moves `toJobView` inside, exactly as `ADR-0010`
§2 decided. `cancelJob` is a one-line pass-through. `listJobs` moves
`delegateHistoryHandler.js`'s filter/slice/reverse/`summarizeJob` logic inside — **with one
deliberate, flagged addition, not present in today's handler code**: a `limit = 20` default.
Today, calling the bare handler function with `limit: undefined` returns *every* job uncapped
(`slice(-undefined)` coerces to `slice(0)`, the whole array) — this default never fires in
production because the MCP schema's own `limit.default(20)` (`src/server/mcpServer.js:178`)
always supplies a value before the handler runs, so this is **provably non-breaking for the one
consumer that exists today** (MCP), but is a real, additive behavior change for any future
non-MCP caller that omits `limit` — flagged here explicitly rather than folded silently into the
"verbatim" claim; see §5 (Architecture Risk Analysis) for the acceptance criterion this implies.
No method beyond these two deliberate, disclosed additions (input validation, this default)
contains a `switch`, a state machine, or any logic beyond what's shown above — this is the
literal implementation of the "pass-through, zero new orchestration" claim `ADR-0010` §10.3
already proved architecturally.

### Internal boundaries

- Never calls `bus.publish`/`bus.subscribe` — its only bus-shaped behavior is forwarding the
  pre-existing `jobManager.bus` reference into `service.invoke(...)`, identical to today.
- Never reimplements `JobManager`'s state machine, concurrency queue, or eviction policy.
- Never imports anything from `@modelcontextprotocol/sdk` or any MCP-specific type.
- Returns `JobView`/`JobSummary` shapes (already-shaped, per `ADR-0010` §2's placement decision),
  never raw `Job`.

### Interaction with `JobManager`

Calls exactly four methods: `submit`, `getJob`, `listJobs`, `cancelJob`. Never touches
`waitForCompletion` or `jobManager.bus` directly outside the one line inside `submit()` that
forwards the existing bus reference into `service.invoke(...)` — identical to what
`submitDelegation()` already does today. `JobManager` itself is not modified in any way.

### Interaction with `ObservabilityService`

None. The two services are constructed independently in `mcpServer.js` and never reference each
other, preserving `ADR-0010`'s "two facades, composed side by side, never merged" decision.

### Interaction with MCP handlers

Five handlers change their dependency from `{jobManager}` (or a bare `submitDelegation` import)
to `{delegationService}`:

| Handler | Before | After |
|---|---|---|
| `delegateStatusHandler.js` | `jobManager.getJob(job_id)` + `toJobView(...)` | `delegationService.getJob(job_id)` |
| `delegateHistoryHandler.js` | `jobManager.listJobs()` + handler-resident filter/slice/reverse + `summarizeJob` | `delegationService.listJobs({status, limit})` |
| `delegateCancelHandler.js` | `jobManager.getJob`/`cancelJob`/`getJob` + `toJobView` | `delegationService.getJob`/`cancelJob`/`getJob` (same 3-call shape, §8 R8 of the review package — not collapsed in this stage) |
| `delegateSubmitHandler.js` | `submitDelegation({input, config, jobManager, logger, service, toolName})` + `jobManager.getJob` | `delegationService.submit(input, "delegate_submit")` + `delegationService.getJob` |
| `delegateTaskHandler.js` | `submitDelegation(...)` + `jobManager.waitForCompletion`/`jobManager.bus` | `delegationService.submit(input, "delegate_task")` for the submit call; **keeps** `jobManager.waitForCompletion`/`jobManager.bus` directly (the one documented exception, `ADR-0010` §4/§6) |

Four handlers are untouched: `delegate_models` (no backend dependency), `delegate_replay`/
`delegate_metrics`/`delegate_snapshot` (already call `ObservabilityService`, unaffected).

### Future REST compatibility

A REST route handler (Stage 2, not built here) calls the identical
`delegationService.submit(input, toolName)`/`getJob(id)`/`listJobs({status, limit})`/
`cancelJob(id)` — no new method, no new shape. `submit`'s blocking behavior is never invoked by
REST; a REST `POST /jobs` returns immediately (mirrors `delegate_submit`, not `delegate_task`) and
a client polls `GET /jobs/:id` (`getJob`) or a future subscription mechanism — `ADR-0010` §4/§6
already declines to design that mechanism ahead of a concrete second consumer, unchanged here.

### Future Dashboard compatibility

Per `ADR-0010` §6 Stage 3 (explicitly not built here): a Dashboard consumes REST only, never
`DelegationService` directly, even if colocated in-process — no design obligation on
`DelegationService` beyond what REST already requires.

### Extension rules

A future fifth method (if one is ever needed) must: wrap exactly one existing `JobManager`
method, add no branching beyond input validation/view-shaping, and be justified by a concrete
consumer at the time it's added (mirroring the "no speculative capability" discipline
`ADR-0003`/`ADR-0009`/`ADR-0010` already apply elsewhere). Any method touching
`waitForCompletion`, `bus`, or a push/notification primitive requires its own ADR, per `ADR-0010`
§4's explicit deferral of `subscribeToJob()`.

### Non-goals

Authorization/ownership scoping (`ADR-0010_REVIEW_PACKAGE.md` §11 Open Question 12 — unresolved,
not addressed by this design), renaming `job.metadata.tool` (reversed, `ADR-0010` §2),
`ConsumerRegistry` exposure (`ADR-0009` finding, unchanged), a formal `subscribeToJob()` primitive
(deferred, `ADR-0010` §4), REST/Dashboard/Plugin implementation (Stages 2/3/4, separate ADRs).

---

## 2. Migration Strategy

**Current architecture:** 5 of 9 MCP handlers call `JobManager`/`submitDelegation()` directly, no
shared boundary object; 3 already call `ObservabilityService` (`delegate_replay`/`delegate_metrics`/
`delegate_snapshot`); the 9th (`delegate_models`) has no backend service dependency at all.

**Target architecture:** all 9 handlers are thin adapters over exactly two constructed-once
service objects (`ObservabilityService`, `DelegationService`); no handler imports
`src/models/job.js` or touches `JobManager` directly except `delegateTaskHandler.js`'s one
documented exception.

**Migration phases** (this document designs, does not execute, any of these):
1. **WP1** — implement `DelegationService` in isolation, unit-tested against a mocked/stub
   `JobManager`, zero handler changes yet. Fully additive; `delegationService.js`'s existing
   export can coexist during this phase if needed (see Implementation Sequence, §3).
2. **WP2–WP6** — reroute each of the 5 handlers, one at a time, each independently verifiable
   against Stage 1a's characterization suite.
3. **WP7** — update `FOUNDATION_FREEZE.md`'s one sentence naming the single path into
   `JobManager`.
4. **WP8** — whole-suite verification + live Inspector `tools/list` diff.

**Backward compatibility:** zero MCP schema change (§5 of `ADR-0010_REVIEW_PACKAGE.md`, unchanged
by this design). Every response shape reused verbatim.

**Risk mitigation:** Stage 1a's 301-test suite is the objective baseline; every work package is
verified against it before proceeding to the next. See §5 below for implementation-level risks
not already covered by the architecture-level risk register.

**Rollback strategy:** unchanged from `ADR-0010_REVIEW_PACKAGE.md` §9 — worktree-isolated
implementation, `git revert` of a single merge commit if a post-merge defect surfaces, zero data
migration since no persisted format or external contract changes.

---

## 3. Implementation Sequence

| WP | Work | Depends on | Certification point | Safe stopping point? |
|---|---|---|---|---|
| WP1 | Implement `createDelegationService` in `src/services/delegationService.js` (new factory alongside or replacing the bare `submitDelegation` export — see note below); unit tests mirroring `observabilityService.test.js`'s style, using a stub `jobManager` | Stage 1a (done) | New unit tests green; existing `schemas.test.js`/`asyncExecution.integration.test.js` untouched and still green (proves WP1 is purely additive) | **Yes** — `DelegationService` exists, unused, zero behavior change anywhere |
| WP2 | Reroute `delegateStatusHandler.js` | WP1 | `tests/handlerGaps.characterization.test.js`'s status tests + Inspector diff on `delegate_status` only | Yes |
| WP3 | Reroute `delegateHistoryHandler.js` | WP1 | `tests/handlerGaps.characterization.test.js`'s history tests (filter/limit/ordering/empty) | Yes |
| WP4 | Reroute `delegateCancelHandler.js` | WP1 | `tests/handlerGaps.characterization.test.js`'s cancel tests + `asyncExecution.integration.test.js`'s lifecycle test | Yes |
| WP5 | Reroute `delegateSubmitHandler.js` | WP1 | `asyncExecution.integration.test.js`'s submit tests | Yes |
| WP6 | Reroute `delegateTaskHandler.js`'s `submit()` call only; keep `jobManager.waitForCompletion`/`.bus` | WP1 | `asyncExecution.integration.test.js`'s task/progress tests | Yes |
| WP7 | Update `FOUNDATION_FREEZE.md`'s one sentence | WP2–WP6 merged | Doc-only; no test | Yes |
| WP8 | Full suite + live Inspector `tools/list` diff across all 9 tools | WP1–WP7 | 301/301 (or more, if WP1 adds unit tests) green; zero schema diff | **Certification gate — sprint end** |

**Dependency graph:** WP1 blocks WP2–WP6; WP2–WP6 are mutually independent (could be done in any
order, or in parallel across isolated worktrees) since each handler file is touched by exactly one
work package; WP7 depends on all five reroutes landing (it changes one sentence describing the
*collective* single path); WP8 is the final gate.

**Note on `delegationService.js`'s existing export:** `submitDelegation()` is currently imported
by `delegateSubmitHandler.js` and `delegateTaskHandler.js`. WP1 should decide (an implementation
detail, not an architecture decision — already bounded by `ADR-0010`): either evolve the same
file/export in place (breaking those two imports until WP5/WP6 land, meaning WP1 cannot be merged
alone without WP5/WP6 in the same PR) or add the new factory alongside the old export temporarily
and remove `submitDelegation()` only once WP5/WP6 both land (true one-WP-at-a-time
independence). The second option better satisfies "every WP is a safe stopping point" and is the
recommended default; either is compatible with `ADR-0010`.

**Risk flagged by adversarial review, applies only to the second (recommended) option:** during
the WP1→WP4 window, `submitDelegation()` and `DelegationService.submit()` are two independent
implementations of near-identical submission logic coexisting in the same file. This is a
transitional violation of the target architecture's "single mutation path" property (`ADR-0010`
§10.3), not a permanent one — but a fix applied to one during this window (e.g. a bug found in
input handling) will not automatically propagate to the other. Mitigation: keep the transitional
window as short as practically possible (WP5/WP6 should follow WP1 immediately, not be deferred),
and if any change to submission logic is needed *during* the transition, apply it to both
implementations in the same commit, verified by the same test.

---

## 4. Testing Strategy

- **Characterization preservation:** all 301 tests from Stage 1a (`24086b8`) must stay green,
  unmodified, throughout every work package — they are the acceptance baseline, not a suite to be
  edited to fit the refactor.
- **Unit tests (new, WP1):** `tests/delegationService.test.js` — one file, mirroring
  `observabilityService.test.js`'s conventions: construct `createDelegationService` with a stub
  `jobManager`, assert `submit`/`getJob`/`listJobs`/`cancelJob` each make exactly the one
  underlying call they're specified to make, assert input validation rejects the same invalid
  inputs `schemas.test.js` already pins, assert `getJob`/`listJobs` return `JobView`/`JobSummary`
  shapes matching `toJobView`/`summarizeJob` byte-for-byte.
- **Integration tests (updated, WP2–WP6):** `tests/asyncExecution.integration.test.js`'s
  `buildHandlers()` helper is updated to construct a `delegationService` and pass it to the
  rerouted handler factories instead of raw `jobManager` — the existing 18 integration tests in
  that file continue to exercise the same scenarios (full lifecycle, workspace persistence,
  concurrent jobs, progress notifications) against the new wiring, proving behavioral equivalence
  without rewriting test intent.
- **Regression tests:** `tests/jobManagerEvents.test.js` re-run unmodified — since
  `DelegationService` never touches the bus beyond forwarding the existing reference, event
  publication ordering must be provably unaffected (this file passing unchanged, byte-for-byte,
  is itself the regression proof).
- **Acceptance criteria (WP8 gate):**
  1. `npm test` reports the same test count or more (any WP1 unit tests added), zero failures.
  2. Live Inspector `tools/list` diff (`server._registeredTools`, per
     `tests/toolRegistry.characterization.test.js`'s established technique) shows zero change
     across all 9 tools' title/description/annotations/inputSchema.
  3. The structural boundary test proposed in `ADR-0010_REVIEW_PACKAGE.md` §10.4 is implemented
     and green: each of the 5 rerouted handler files imports only `delegationService.js` (plus
     `jobManager.js`/`mcpProgressAdapter.js` for `delegateTaskHandler.js`'s documented exception)
     from `src/services/`, never `jobManager.js` directly, never `src/models/job.js`.
  4. `FOUNDATION_FREEZE.md`'s updated sentence is the only change to that file; a repo-wide grep
     for the old wording (`submitDelegation()` as "the single path") finds no other stale
     reference.
  5. `DelegationService.listJobs()`'s new `limit = 20` default (§1) is covered by a WP1 unit test
     asserting the MCP-observed behavior is unaffected (the schema's own default already supplies
     20 before any handler runs) and by an explicit test asserting the service-level default
     itself (calling `listJobs({})`/`listJobs()` with no `limit` returns at most 20) — this is a
     deliberate, disclosed addition, not a silent one, and must be demonstrated, not just claimed.

---

## 5. Architecture Risk Analysis (implementation-level)

- **Performance:** one additional function-call layer per operation (handler → service →
  JobManager) — negligible, no new I/O, no new async boundary beyond what already exists.
  `DelegateTaskInputSchema.parse()` inside `submit()` adds one zod validation pass already paid
  for once by the MCP SDK for MCP callers — redundant-but-cheap, already flagged as Open Question
  6 in the review package, not re-litigated here.
- **Coupling:** strictly reduced, not increased — 5 handlers currently import `jobManager.js`
  directly (a service-internal module); post-refactor they import only `delegationService.js`,
  matching the same reduced-coupling shape the 4 `ObservabilityService`-backed handlers already
  have.
- **Future maintainability:** a single choke point for the write side makes Stage 2 (REST) and
  Stage 3 (Dashboard, via REST) strictly easier — both already-planned consumers get one stable
  object to depend on instead of reimplementing `JobManager` access.
- **Compatibility:** zero MCP schema change (proven architecturally in `ADR-0010_REVIEW_PACKAGE.md`
  §5; this design introduces no new claim, only an execution plan for the already-approved,
  schema-invisible change).
- **Failure modes — one implementation-level question this design surfaces, not yet resolved:**
  today, `delegate_task`/`delegate_submit`'s only input validation happens at the MCP SDK layer,
  before the handler runs — a malformed call never reaches `submitDelegation()`. Post-refactor,
  `DelegationService.submit()` calls `DelegateTaskInputSchema.parse(input)` itself. For MCP
  callers this is provably unreachable in practice (the SDK already rejected anything `.parse()`
  would reject) — **but WP1's unit tests must still assert what `submit()` does if `.parse()`
  ever throws** (propagate the `ZodError` uncaught, since no handler wraps `submit()` in a
  try/catch today) so this is a deliberate, tested behavior rather than an unconsidered one.
- **Operational risks:** none — no new process, no new port, no new dependency, no new
  configuration surface.

---

## 6. Independent Adversarial Design Review

One independent review pass (fresh agent, no memory of this document's drafting) found 5 concrete
issues, all fixed in this document before finalization:

1. **Hidden coupling (serious):** the original `createDelegationService` code block omitted the
   `service = defaultClaudeCliService, workspace = defaultWorkspaceManager` default parameters
   that `submitDelegation()` (`src/services/delegationService.js:32-33`) actually has. Production
   never supplies these (`mcpServer.js:144,155`) — as originally written, this design would have
   broken every real `delegate_task`/`delegate_submit` call. **Fixed** — §1's code block now
   includes both defaults, with the evidence trail documented inline.
2. **Documentation error:** §2 originally claimed "4 already call `ObservabilityService`"; the
   correct count (matching §1 and source) is 3, plus a 4th tool (`delegate_models`) with no
   backend dependency at all. **Fixed.**
3. **Documentation error:** §4 originally claimed "~30 integration tests" in
   `tests/asyncExecution.integration.test.js`; the actual count is 18. **Fixed.**
4. **Unacknowledged risk:** the WP1→WP4 transitional window (old `submitDelegation()` and new
   `DelegationService.submit()` coexisting) is a temporary violation of the single-mutation-path
   target property, with no mitigation originally stated. **Fixed** — §3 now names this risk
   explicitly and states a mitigation (keep the window short; any mid-transition fix applied to
   both implementations together).
5. **Under-disclosed behavior change:** `listJobs`'s new `limit = 20` default (not present in
   today's bare handler function, which returns everything uncapped when called with
   `limit: undefined`) was described as part of a "verbatim" move — accurate for the one real
   consumer (MCP, whose schema already supplies 20), but a real, undisclosed addition for any
   future non-MCP caller. **Fixed** — §1 now names this explicitly as a deliberate, disclosed
   addition, and §4 adds an explicit acceptance criterion requiring it to be tested, not just
   claimed.

No finding required an architecture change — every fix was a documentation/design-precision
correction, consistent with governance ("fix documentation only, never change architecture
without governance approval"). A second review pass after these fixes found no further issues
(re-verified directly against the same source files cited above).

---

## 7. Cross-Document Verification

Verified consistent with: `ADR-0002` (no event payload shape touched by this design — `submit()`
forwards `jobManager.submit()` unchanged, same `JobQueued` payload), `ADR-0003` (Single Mutation
Path Rule/Dependency Direction extension unchanged from `ADR-0010`), `ADR-0005` (`JobStore`
interface never touched — `DelegationService` calls only `JobManager`'s public methods, two
layers removed from persistence), `ADR-0006` (`EventHistoryStore` subscribes independently,
unaffected), `ADR-0007`/`ADR-0008`/`ADR-0009` (their three tools/handlers are explicitly untouched
by every work package above), `FOUNDATION_FREEZE.md` (WP7 is the only planned edit, and only to
the one sentence `ADR-0010`'s Compatibility impact section already names), `OBSERVABILITY_FREEZE.md`
(no `ObservabilityService` method touched), `CAPABILITY_ROADMAP_REBASELINE.md` (Stage 1b remains
the approved next step; REST/Dashboard sequencing unchanged). No contradiction found requiring a
fix in this pass beyond what §6 records.

---

## 8. Documentation

Repo: this file (new). Obsidian and Mem0 updates recorded in the final response per governance
(durable facts only — milestone, status, next milestone — no temporary work-package detail).
