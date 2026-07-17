# ADR-0010 Formal Architecture Review Package

**Subject:** `docs/adr/ADR-0010-unified-access-layer.md`, currently `main` at `4bf2f4e`
(3 commits ahead of `origin/main`, not pushed). **Status: awaiting architecture approval.** No
production code changed by ADR-0010 or this package; no implementation plan exists yet.

---

## 1. Executive summary

**Problem.** `ObservabilityService` (reads) is a clean, transport-agnostic façade — three MCP
tools (`delegate_replay`/`delegate_metrics`/`delegate_snapshot`) already prove it as two-line
wrappers. The write/query-by-id side has no equivalent: `delegate_task`/`delegate_submit`/
`delegate_status`/`delegate_history`/`delegate_cancel` all call `JobManager` directly, and
`submitDelegation()` is a bare function, not a service with its own boundary. Any future REST
API, Dashboard, or Plugin wanting to submit/query/cancel a job today would have to reach directly
into `JobManager` — the exact "every transport coupled to internal state" anti-pattern `ADR-0003`
already eliminated on the read side.

**Decision.** Introduce `DelegationService` (evolving today's `delegationService.js`) as a second
constructed-once, stable internal-API object, held alongside `ObservabilityService` — never
merged into it, to preserve the Passive Observation Rule's structural guarantee. It wraps exactly
four operations (`submit`, `getJob`, `listJobs`, `cancelJob`); `waitForCompletion`/`jobManager.bus`
stay a single documented exception on `delegateTaskHandler.js` (its frozen synchronous contract).
Every transport — MCP now, REST/Dashboard/Plugin later — becomes a thin adapter over these two
objects, never over `JobManager`/`MetricsCollector`/`TimelineStore`/etc. directly.

**Scope of this ADR: design only.** Zero MCP schema change. One sentence in
`FOUNDATION_FREEZE.md` updates (naming the new service). Classified **patch**, not minor — no new
tool, no new schema field, no new response shape.

**Process to date.** Drafted from four independent research passes; adversarially reviewed twice
(once by a fresh agent after an initial "fail" verdict was fixed, once specifically targeting
this package's §9 proof obligation), catching and fixing three real issues along the way — see
§6 and §9. Nothing in this package is asserted without a corresponding direct code read cited
by file:line.

**What's being asked of you now:** approve or reject the architecture below. Nothing pushes to
`origin`, no implementation plan is written, and Stage 1a does not start until you do.

---

## 2. Responsibility matrix

| Responsibility | `DelegationService` | `ObservabilityService` | MCP handlers (all 9) | Future REST adapter | Future Dashboard adapter |
|---|---|---|---|---|---|
| Mutate job state | Pass-through only (calls `JobManager.submit`/`cancelJob`) | **Never** (Passive Observation Rule) | **Never** | **Never** | **Never** |
| Own authoritative job state | No (`JobManager` does) | No | No | No | No |
| Derive read-only views (metrics/timeline/snapshot/replay) | No | Yes, exclusively | No | No | No |
| Business/domain validation, state-transition rules | No — stays in `JobManager` (`cancelJob` branching, `TERMINAL_STATUSES`) | N/A (nothing to validate, read-only) | **Never** | **Never** | **Never** |
| Input schema validation | Yes (`DelegateTaskInputSchema.parse` inside `submit()`) | N/A | No (delegates to MCP SDK today; SDK validation stays, redundant-safe with service-layer check) | Own request validation (JSON schema/etc.), then calls the shared service | Own form validation, then calls the shared service |
| Data-shape ownership (`toJobView`/`summarizeJob`) | Yes, internal to `getJob`/`listJobs` | N/A (`OBSERVABILITY_FREEZE.md`'s own shapes) | **Never** (post-refactor: stop importing `models/job.js` entirely) | Reuses `DelegationService`'s shaped output verbatim | Same |
| Retry/eviction/bounding/concurrency policy | No — stays in `JobManager`/`TimelineStore`/`MetricsCollector` | No — stays in its substrate | **Never** | **Never** | **Never** |
| Protocol request parsing | No | No | Yes (zod, `mcpServer.js` only) | Yes (its own shape) | Yes (its own shape) |
| Protocol response envelope/formatting | No | No | Yes (`{content, structuredContent}`) | Yes (JSON body) | Yes (its own view layer) |
| Protocol error shaping | No | No | Yes (`toToolErrorContent`) | Yes (HTTP status + JSON) | Yes (its own error UI) |
| Push/notification mechanism | No (bus-free by design, §4) | No (pull-only, `ADR-0003`) | Yes, MCP-specific (`mcpProgressAdapter.js`, `delegate_task` only) | Its own (SSE/webhook) — **not built yet** | Its own (WebSocket) — **not built yet** |
| Auth/session handling | No | No | Whatever the MCP SDK transport does | Its own | Its own |
| Registration/route metadata | No | No | Yes (`registerTool`'s title/description/annotations) | Its own route table | N/A (consumes REST) |
| `RuntimeEventBus` coupling | Forwards existing `jobManager.bus` reference only (no new coupling) | One `bus.subscribeAll()` at construction, pull-only | No direct coupling (uses services) | No direct coupling | No direct coupling |

---

## 3. Dependency graph

```
                     RuntimeEventBus
                    /                \
                   ▼                  ▼
             JobManager          (subscribeAll, pull-only)
              │      │                  │
   (submit/   │      │ (bus ref,        ▼
   getJob/    │      │  exception  ObservabilityService
   listJobs/  │      │  only —      (MetricsCollector,
   cancelJob) │      │  §4)          TimelineStore,
              ▼      │                ReplayEngine,
       DelegationService              SnapshotBuilder,
              │       └───────┐       ConsumerRegistry)
              │               │              │
              ▼               ▼              ▼
     ┌────────────────────────────────────────────┐
     │      MCP handlers (transport adapters)      │
     │  9 tools: task/submit/status/history/cancel │
     │  /models/replay/metrics/snapshot             │
     └────────────────────────────────────────────┘
              │               │              │
              ▼               ▼              ▼
        Future REST     Future Dashboard  Future Plugin
        (Stage 2)       (Stage 3, thin    (Stage 4, parked
                        UI over REST      — no consumer yet)
                        only — NOT
                        in-process)
```

**Invariant carried forward from `ADR-0003`, extended symmetrically:** the graph is
one-directional. `RuntimeEventBus → JobManager → DelegationService → transports` (write) runs
alongside `RuntimeEventBus → ObservabilityService → transports` (read); neither ever inverts into
a control path back through a service into the bus or `JobManager` from a transport. The one
documented exception (`delegateTaskHandler.js` holding a direct `jobManager` reference for
`waitForCompletion`/`bus`) is a leaf-level shortcut *within* the MCP transport layer, not a
reversal of the graph's direction — it still only reads/awaits, never mutates beyond what
`DelegationService.submit()` already triggered.

---

## 4. Public contracts introduced or changed

**New — `DelegationService` (`src/services/delegationService.js`, factory
`createDelegationService({jobManager, config, logger, service, workspace})`):**

```js
DelegationService = {
  submit(input, toolName): jobId              // validates via DelegateTaskInputSchema.parse, then today's submitDelegation() body verbatim
  getJob(jobId): JobView | undefined           // toJobView(jobManager.getJob(jobId)) applied internally
  listJobs({status?, limit?}?): JobSummary[]   // filter+slice+reverse+summarizeJob applied internally
  cancelJob(jobId): boolean                    // jobManager.cancelJob(jobId) verbatim
}
```

Not wrapped, deliberately: `waitForCompletion`, `jobManager.bus`, `forwardJobProgressToMcp` —
stay on `delegateTaskHandler.js` directly (§4/§6 of the ADR).

**Changed — one sentence in `docs/FOUNDATION_FREEZE.md`'s frozen execution-contract section**,
during Stage 1b only (not by this ADR itself): the text currently naming `submitDelegation()` as
"the single path into `JobManager`" is updated to name `DelegationService`. Done via ADR per that
document's own rule ("no entry in Frozen sections changes without an ADR documenting why") — not
a silent edit.

**Unchanged:** all 9 MCP tool schemas (`FOUNDATION_FREEZE.md`), `ObservabilityService`'s full
method set (`OBSERVABILITY_FREEZE.md`), `job.metadata.tool`/`JobQueued`'s `payload.tool`
(rename proposed and reversed — see §6), `ADR-0002`'s `EVENT_SCHEMA_VERSION` (stays `1`).

---

## 5. Backward compatibility analysis

| Surface | Impact | Evidence |
|---|---|---|
| MCP tool schemas (9 tools) | **None** | `registerTool()` calls are unchanged by construction — swapping a handler factory's injected dependency (`{jobManager}` → `{delegationService}`) touches zero characters of any `inputSchema`/`title`/`description`/`annotations` block. Same zero-diff pattern already proven 3× (`ADR-0007`/`0008`/`0009`, each verified via Inspector `tools/list` byte-diff). |
| Request/response shapes observed by an MCP client | **None** | `toJobView`/`summarizeJob`'s output shape is reused verbatim; `{success, job_id, status}` and `{content, structuredContent}` envelopes are untouched. |
| `JobQueued` event payload (`ADR-0002`) | **None** | Rename considered and explicitly reversed (§6) after checking `ADR-0002`'s `EVENT_SCHEMA_VERSION` rule and finding two existing tests construct jobs on the `tool` key directly. `EVENT_SCHEMA_VERSION` stays `1`. |
| `FOUNDATION_FREEZE.md` prose | **One sentence changes, by design, in Stage 1b** | The "single path into `JobManager`" sentence names the file/function today; it will name `DelegationService` instead. The underlying guarantee (one single path) is preserved, not broken — this is the freeze document's own definition of a change requiring an ADR, not a compatibility break. |
| `ADR-0003`'s "Components"/"Dependency Direction" prose | **One corrective note recommended, not yet applied** | `getJobSummary(jobId)` is listed there but was never implemented (confirmed absent from `src/` and from `OBSERVABILITY_FREEZE.md`'s actual frozen table) — stale drift in the original narrative, not the frozen contract. ADR-0010 flags this; it does not edit `ADR-0003` itself (confirmed: `git show --stat` across every ADR-0010 commit touches only the one new file). |
| External callers (Claude Desktop, any MCP client) | **None observable** | Every claim above is about internal call routing, not wire behavior. |

**Overall classification: patch**, per `FOUNDATION_FREEZE.md`'s own versioning policy — "internal
fix, doc correction, dead-code removal, non-behavioral refactor" is the exact shape of Stage 1b.

---

## 6. `ADR-0002` / `ADR-0003` compliance analysis

**`ADR-0003` (Observability architecture) — compliant, extended symmetrically, not restated.**
The **Passive Observation Rule** is mirrored by a new, explicitly named **Single Mutation Path
Rule**: `DelegationService` adds no mutation logic of its own, it is a pass-through to
`JobManager`'s existing methods, exactly as `ObservabilityService` adds no read-derivation logic
beyond what its substrate already computes. The **Dependency Direction** diagram is extended
(not merged) with a parallel write-side arrow (§3 above), preserving the original's "no control
path back through a service" invariant. Verified directly against the two facades' actual code:
`DelegationService` never calls `bus.publish`/`bus.subscribe` — its only bus-shaped behavior is
forwarding the existing `jobManager.bus` reference into `claudeCliService.invoke()`, unchanged
from today's `submitDelegation()`. Two facades are kept **separate, composed side by side, never
merged** — a merge would dilute the Passive Observation Rule's structural guarantee
(`Object.keys(observability)` contains no mutator, per `OBSERVABILITY_FREEZE.md`) into something
re-verified by convention instead of construction.

**`ADR-0002` (Streaming & Event architecture) — compliant, after one real defect was found and
fixed.** The first draft proposed renaming `job.metadata.tool` → `.source` and the mirrored
`JobQueued` event `payload.tool` → `.source`, classifying it as a non-breaking **patch** without
ever citing `ADR-0002`. An independent adversarial review caught this: `ADR-0002`'s Event
contract table freezes `JobQueued`'s payload as `{tool, model, effort, metadata}` verbatim, under
an explicit `EVENT_SCHEMA_VERSION` breaking-change rule, and two existing tests
(`tests/fileJobStore.test.js:23`, `tests/workspaceManager.test.js:76`/`:98`) construct jobs on the
`tool` key directly — making the proposed rename observably breaking, not byte-identical as
originally claimed. **Resolution: the rename is reversed.** `metadata.tool`/`payload.tool` stay
unchanged; `EVENT_SCHEMA_VERSION` stays `1`; the generic-naming improvement is deferred to its own
future ADR (one that would also amend `ADR-0002` and bump the schema version), not folded
silently into this patch. A second, independent re-review confirmed the reversal is complete and
consistent across every section that referenced it (Decision, §2, §5's reuse table, §6's
versioning justification, Explicitly-out-of-scope, Alternatives, Compatibility impact).

---

## 7. Migration strategy

| Stage | Content | Code touched | Gate |
|---|---|---|---|
| **0** (current) | This ADR + this review package | None | **You are here — awaiting your approval** |
| **1a** | Characterization tests only: Inspector `tools/list` snapshot for all 9 tools; e2e assertions pinning today's exact request/response shapes and job-lifecycle transitions for the 5 write-side tools | None (test files only) | Recommended next sprint — see §8 for why this is deliberately narrower than "the refactor" |
| **1b** | Evolve `delegationService.js` into `createDelegationService(...)`; reroute the 5 write-side handlers; update `FOUNDATION_FREEZE.md`'s one sentence | `src/services/delegationService.js`, 5 handler files, `src/server/mcpServer.js` wiring | Stage 1a's full suite must pass unchanged against the refactored code; live Inspector diff must show zero schema changes across all 9 tools |
| **2** | REST API Foundation ADR + build — thin HTTP adapter over both services, no new business logic | New (out of this ADR's scope) | Its own ADR + implementation plan |
| **3** | Dashboard as a thin UI **over REST only** — in-process shortcut explicitly rejected (recreates the redundant-parallel-path problem Stage 1 exists to eliminate, one layer up) | New | Its own ADR |
| **4** | Plugin API (parked, no concrete consumer) / Analytics layer (rides along later as a REST endpoint, not its own tool) | New | Parked until a concrete need exists |

---

## 8. Risks and rollback plan

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stage 1b's refactor surface (5 handlers + `delegationService.js` + a bus-access decision) is wider than any single prior `ADR-0007`/`0008`/`0009` sprint — easy to undersize | Medium | Medium (schema-invisible bugs slip through if under-tested) | Stage 1a is a **mandatory, separate** gate before Stage 1b — characterization tests must exist and pass against *today's* code first, so Stage 1b has an objective, pre-existing baseline to prove "byte-identical" against, not a claim made from reading source |
| Moving input validation (`DelegateTaskInputSchema.parse`) inside `DelegationService.submit()` exercises a code path the MCP transport doesn't currently rely on (MCP SDK already validates pre-handler) | Low | Low for MCP (redundant, defense-in-depth only); would be load-bearing for a future non-MCP caller | Stage 1a's characterization tests include the validation-rejection path (invalid `model`, non-positive `max_budget_usd`) so any behavioral drift is caught before Stage 1b merges |
| `FOUNDATION_FREEZE.md`'s "single path into `JobManager`" sentence is forgotten during Stage 1b, leaving the freeze doc stale relative to code | Medium (this exact class of miss cost 6 review cycles on `ADR-0007` before the lesson was applied) | Low (doc-only) | Stage 1b's task brief names the exact sentence/file to update, mirroring the pre-identified-location discipline that cut `ADR-0009`'s doc-fix cycles from 6 to 1 |
| `ConsumerRegistry`'s in-memory-only state (no persistence across restarts) surfaces as a real limitation once a REST/Dashboard backend process relies on it for ops/admin stats | Low, and not until Stage 2/3 | Low | Out of this ADR's scope; explicitly flagged in §5 of the ADR for whichever future ADR designs that deployment shape |
| `getTimeline()`'s `{type, since}` filtering re-opened as a live question, not resolved here | N/A (deliberate deferral) | None to this ADR | Explicitly deferred to the REST API Foundation ADR (Stage 2), not left ambiguous |
| Documentation drift between this ADR's prose and the eventual Stage 1b implementation | Medium (already happened twice during drafting — see §6 and the view-shaping/listJobs fixes) | Low, self-correcting | This is precisely why Stage 1a exists as executable proof rather than trusting prose; two independent adversarial reviews already caught and fixed three such gaps before this package was written |

**Rollback plan, per stage:**
- **Stage 1a**: trivially reversible — test files only, no production code; revert = delete the new test file(s).
- **Stage 1b**: isolated to a single worktree branch per this project's established pattern; if Stage 1a's tests fail against the refactor, the change is caught **before** merge (never reaches `main`). If a defect is found *after* merge, rollback = revert the single Stage 1b commit — zero schema/data migration involved, since Stage 1b touches no persisted format (`FileJobStore`/`EventHistoryStore` untouched) and no external contract (§5) — a plain `git revert` restores byte-identical prior behavior.
- **Stage 2+**: each stage is its own ADR and its own sprint; none is started until the preceding stage is merged and certified, so rollback of a later stage never implicates an earlier one.

---

## 9. Explicit proof that no transport contains business logic after the refactor

Verified by two independent passes reading actual source, not by trusting the ADR's own prose.

**A. Already-shipped thin wrappers — PASS, no changes needed.** `delegateReplayHandler.js`,
`delegateMetricsHandler.js`, `delegateSnapshotHandler.js` each contain exactly: one call into
`observabilityService.*`, presentation formatting, and the response envelope — nothing else.
`delegateModelsHandler.js` makes no service call at all (by design — it reflects a static
config-derived constant), contains no conditional business logic beyond a display fallback.

**B. The 5 handlers this ADR plans to refactor — verified line-by-line, gaps found and fixed:**

| Handler | Business logic found today? | Resolution |
|---|---|---|
| `delegateStatusHandler.js` | No (existence branch translates an already-decided `Job \| undefined` into MCP's error shape — sanctioned presentation, §3) | — |
| `delegateHistoryHandler.js` | **Yes** — `if (status) jobs = jobs.filter(...)` and `jobs.slice(-limit).reverse()` are handler-resident filtering/pagination today; `jobManager.listJobs()` itself takes no arguments | **Fixed**: ADR-0010 now explicitly assigns this logic to `DelegationService.listJobs({status, limit})` (§2), not left implicit in a type signature as the first draft did |
| `delegateCancelHandler.js` | No (a 3-call sequence with no domain decision between them — orchestration, not policy) | — |
| `delegateSubmitHandler.js` | No (a hardcoded `{success: true, ...}` literal, not computed) | — |
| `delegateTaskHandler.js` (documented exception) | No new logic beyond the documented `waitForCompletion`/`bus` exception; the exception itself is justified (unique to `delegate_task`'s frozen synchronous contract) and matches the ADR's own scoping exactly | — |

**Cross-cutting gap found and fixed:** the first draft left ambiguous whether `getJob`/`listJobs`
return raw `Job` (handler still shapes it) or the already-shaped `JobView`/`JobSummary` (service
shapes it) — its own §4 already claimed the latter while its type signature implied the former.
**Fixed**: `DelegationService.getJob()`/`listJobs()` now explicitly shape their output internally
(§2); post-refactor, no write-side handler imports `src/models/job.js` at all.

**C. `mcpServer.js`'s 9 `registerTool` blocks — PASS.** Contain only `title`/`description`/
`inputSchema`/`annotations` plus a handler-factory call. Zero per-request logic.

**D. Structural enforcement, not just a prose claim.** A concrete, implementable test is proposed
for the Stage 1b implementation plan — `tests/transportBoundary.test.js`, asserting per-handler
which `src/services/*` files may be imported (`delegationService.js`/`job.js` for four handlers;
`delegationService.js` + `jobManager.js` + `mcpProgressAdapter.js` for the one documented
exception), failing loudly and specifically the moment a future edit reintroduces direct
`JobManager` coupling. This is the direct write-side analog of how `OBSERVABILITY_FREEZE.md`
already structurally verifies the Passive Observation Rule (`Object.keys(observability)` contains
no mutator) — a real, CI-gateable check, not an aspiration.

**Conclusion:** the claim holds **after** two gaps found during this review's own verification
were fixed in the ADR text (§2, committed `4bf2f4e`). The claim is currently a sound design
target; Stage 1a/1b is what makes it empirically true of the shipped code, verified by the
structural test in (D).

---

## Confirmation

This package proposes no code changes and modifies no production file. It exists solely to
support your approval decision on `ADR-0010`. Pending your review: approve, request changes, or
reject. No push to `origin`, no implementation plan, no Stage 1a work begins until you respond.
