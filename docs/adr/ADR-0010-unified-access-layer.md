# ADR-0010: Unified Access Layer Architecture

## Status

**Proposed — design only. No code changes in this ADR.** Named as the required next
architecture wave by `ADR-0009`'s "Last tool in this family" section (v2.7.0): *"The next wave
that touches `ObservabilityService`'s external surface is a unified Access Layer Architecture
ADR (`ADR-0010`, not yet written) ... superseding the REST-API-first framing in
`CAPABILITY_ROADMAP_REBASELINE.md`'s original 'Recommended next sprint' section."*
`PUSH_REPORT.md` (v2.7.0) states the standing gate explicitly: *"No production code until
ADR-0010 is reviewed and approved."* This document is that review artifact — it proposes an
architecture, not an implementation, and remains gated for the user's separate review and
approval before any implementation plan or TDD sprint begins. Synthesizes four independent
research passes (write-side service boundary, read-side formalization, transport/service
boundary, migration strategy), each grounded in direct reads of the source files named
throughout.

## Context

Three MCP tools now exist as proven thin wrappers over `ObservabilityService`:
`delegate_replay` (`ADR-0007`) → `replay()`, `delegate_metrics` (`ADR-0008`) → `getMetrics()`,
`delegate_snapshot` (`ADR-0009`) → `getSnapshot()`. Each is a two-line handler; zero lines
changed in `ObservabilityService` or anything beneath it to add any of the three. That proves a
real architectural property, not just a convenient pattern: `ObservabilityService`
(`src/services/observabilityService.js`) is a genuinely transport-agnostic façade, exactly as
`ADR-0003` designed it — its only `RuntimeEventBus` coupling is one `bus.subscribeAll()` call at
construction, it holds no reference to `JobManager`/`claudeCliService`/any mutator, and this is
enforced structurally (`OBSERVABILITY_FREEZE.md`: *"verified structurally
(`Object.keys(observability)` contains no mutator) and by regression test"*), not by convention.

**No equivalent exists on the write/query-by-id side.** Read directly:

- `src/handlers/delegateStatusHandler.js` calls `jobManager.getJob(job_id)` directly.
- `src/handlers/delegateHistoryHandler.js` calls `jobManager.listJobs()` directly.
- `src/handlers/delegateCancelHandler.js` calls `jobManager.cancelJob(job_id)` directly.
- `src/handlers/delegateSubmitHandler.js` and `src/handlers/delegateTaskHandler.js` both call
  `submitDelegation()` from `src/services/delegationService.js` — a bare exported function, not
  an object with its own stable boundary, that itself takes `jobManager` as a raw parameter and
  calls `jobManager.submit(...)` directly. `delegateTaskHandler.js` additionally calls
  `jobManager.waitForCompletion(jobId)` and reads `jobManager.bus` directly, wiring
  `src/services/mcpProgressAdapter.js`'s `forwardJobProgressToMcp()` — a helper coupled by its
  own doc comment to MCP's `notifications/progress` protocol specifically.
- `src/services/jobManager.js`'s `JobManager` class exposes `submit`/`getJob`/`listJobs`/
  `waitForCompletion`/`cancelJob` directly to whatever calls it — no wrapper, no structural
  enforcement of a single-path guarantee, unlike `ObservabilityService`'s Passive Observation
  Rule.
- `src/models/job.js`'s `toJobView()`/`summarizeJob()` are the only adapter layer that exists
  today, and handlers call them directly rather than through any service boundary.

A future REST API, Dashboard, or Plugin wanting to submit/cancel/query a job today would have no
choice but to reach directly into `JobManager` — exactly the "every transport directly coupled
to internal state" anti-pattern `ADR-0003` already eliminated on the read side. This asymmetry,
not any missing feature, is what this ADR resolves.

Governing documents this ADR must remain compatible with, cited by name throughout:
`docs/FOUNDATION_FREEZE.md` (frozen MCP tool schemas and execution contract — a future access
layer must not force any change here), `docs/OBSERVABILITY_FREEZE.md` (frozen
`ObservabilityService` method set), `ADR-0002` (frozen `RuntimeEventBus` event schema, including
the `JobQueued` payload shape `{tool, model, effort, metadata}` — a future breaking change to any
payload shape bumps `EVENT_SCHEMA_VERSION`, per that ADR's own versioning rule, exactly the
discipline this ADR must also honor for anything touching event payloads),
`CAPABILITY_ROADMAP_REBASELINE.md` (already recommends this unified-layer wave over a REST-only
design), and `ADR-0007`/`ADR-0008`/`ADR-0009` (the three MCP-native thin-wrapper precedents this
ADR extends to the write side).

## Decision (summary)

Two constructed-once objects form the platform's stable internal API, held side by side exactly
as `mcpServer.js` already holds `observabilityService` today — not merged into one facade (see
§4):

1. **`ObservabilityService`** — unchanged. Already transport-agnostic; already frozen by
   `OBSERVABILITY_FREEZE.md`.
2. **`DelegationService`** (new) — `src/services/delegationService.js` evolves from a bare
   `submitDelegation()` export into a factory, `createDelegationService({jobManager, config,
   logger, service, workspace})`, returning a frozen object:

   ```js
   DelegationService = {
     submit(input, toolName): jobId          // absorbs today's submitDelegation() body, plus input validation (see §2)
     getJob(jobId): JobView | undefined       // toJobView(jobManager.getJob(jobId)) applied inside the service — see §2
     listJobs({status?, limit?}?): JobSummary[]  // filter+slice+reverse+summarizeJob applied inside the service — see §2
     cancelJob(jobId): boolean
   }
   ```

   Mirrors `createObservabilityService()`'s shape exactly — same construction pattern, same
   "plain object of methods, no class, no transport type" contract. The five write-side MCP
   handlers are rerouted to call `delegationService.*` instead of `jobManager.*`/
   `submitDelegation()` directly. `delegateTaskHandler.js` keeps a direct `jobManager` reference
   *in addition to* `delegationService`, for `waitForCompletion`/`bus` only — a deliberate,
   documented exception (see §4), not an oversight.

The following six subsections answer this ADR's required questions explicitly.

## 1. Which services become the stable internal API

- **`ObservabilityService`** (no change). This ADR declares `docs/OBSERVABILITY_FREEZE.md`'s
  frozen method table — not `ADR-0003`'s original "Components" prose listing — as the normative
  definition of its API for this ADR's purposes. Reason: `ADR-0003`'s "Components" section
  (line ~168) and "Dependency Direction" section (line ~98) still list
  `getJobSummary(jobId): JobSummary | null` as part of the interface; this method was never
  implemented (confirmed absent from `src/` by direct search) and `OBSERVABILITY_FREEZE.md`
  correctly omits it. This is stale drift in `ADR-0003`'s original narrative, not in the actual
  frozen contract. **Action**: add a one-line corrective note at both locations in `ADR-0003`
  marking `getJobSummary` as never-implemented/superseded by `OBSERVABILITY_FREEZE.md`'s method
  table, so no future document (including this one) accidentally enshrines a non-existent
  method. This is a doc-accuracy fix, not an architecture change.
- **`DelegationService`** (new, per Decision above). Evolves the existing
  `src/services/delegationService.js` module rather than introducing a new file/name —
  `docs/FOUNDATION_FREEZE.md` already calls this file's `submitDelegation()` "the single path
  into `JobManager`"; this ADR upgrades that path's shape, it does not replace its identity.
  Wraps exactly four operations: `submit`, `getJob`, `listJobs`, `cancelJob`. It deliberately
  does **not** wrap `waitForCompletion`, `jobManager.bus`, or `forwardJobProgressToMcp` — see §4
  for why each stays where it is.
- **`ObservabilityService`'s substrate** (`MetricsCollector`, `TimelineStore`, `ReplayEngine`,
  `SnapshotBuilder`, `ConsumerRegistry`) remains internal, never imported directly by any
  transport adapter, mirroring the existing rule, with no exception.
- **`JobManager`** remains internal to every transport adapter **except** `delegateTaskHandler.js`,
  which keeps a direct `jobManager` reference alongside `delegationService` for
  `waitForCompletion`/`bus` only — a single, deliberate, documented exception (see §4), not a
  contradiction of this rule. No other transport adapter (present or future) gets this exception;
  `delegateStatusHandler.js`/`delegateHistoryHandler.js`/`delegateCancelHandler.js`/
  `delegateSubmitHandler.js` and any future REST/Dashboard/Plugin adapter reach `JobManager` only
  through `DelegationService`.

## 2. Which request/response contracts become transport-independent

Already transport-independent today, reused verbatim, zero changes required:

- `src/models/job.js`'s `toJobView()`/`summarizeJob()` — verified to contain zero MCP-specific
  shaping (no reference to `content`/`structuredContent`/`isError`, no import of anything MCP).
  `DelegationService.getJob()`/`listJobs()` call these internally exactly as the handlers do
  today.
- `OBSERVABILITY_FREEZE.md`'s frozen data shapes: `Metrics`, `TimelineEntry`, `Snapshot`,
  `ConsumerInfo`.

**View-shaping and list filtering move inside `DelegationService`, not the handler** — a
placement decision, not left implicit in a type signature. `getJob(jobId)` calls
`jobManager.getJob(jobId)` then `toJobView(...)` internally, returning the already-shaped
`JobView | undefined`. `listJobs({status, limit})` calls `jobManager.listJobs()` (which itself
takes zero arguments, confirmed `src/services/jobManager.js:63`), applies the `status` filter and
the `slice(-limit).reverse()` ordering — both handler-resident in `delegateHistoryHandler.js`
today, confirmed by direct read, and business-adjacent presentation policy sitting there by
omission, not by design — then `summarizeJob(...)` on each result, returning `JobSummary[]`.
Post-refactor, `delegateStatusHandler.js`/`delegateHistoryHandler.js`/`delegateCancelHandler.js`
stop importing `src/models/job.js` at all — they only format whatever `DelegationService` already
returns, the same "destructure / one service call / envelope-format" shape every other handler
already holds to.

**Two further contract decisions this ADR makes explicitly** (both were open questions across the
research passes; neither is left unresolved here):

- **Input validation.** `createExecutionContext(input, config)`
  (`src/models/executionContext.js`) performs zero validation — confirmed line-by-line, it only
  reshapes/defaults. The only validation that exists today is `DelegateTaskInputSchema`
  (`z.object(DelegateTaskInputShape)`, `src/models/schemas.js`), enforced solely by the MCP SDK
  at tool-registration time in `mcpServer.js`, before any handler runs. Left as-is, a future REST
  caller invoking `DelegationService.submit()` directly would bypass that check entirely
  (unchecked `model` enum, unchecked `max_budget_usd > 0`, etc.). **Decision: `DelegationService.
  submit(input, toolName)` calls the existing, already-exported `DelegateTaskInputSchema.
  parse(input)` internally**, before building the `ExecutionContext`. `DelegateTaskInputSchema`
  is a plain zod object schema with no MCP-specific type or framing — reusing it inside the
  service layer does not import any MCP concept into `src/services/`, it only reuses an
  already-shared validation rule. This makes validation a property every transport gets for
  free, not a duty every future transport must remember to re-implement.
- **`job.metadata.tool` naming.** Today `submitDelegation()` stores `{tool: toolName, ...}` into
  `job.metadata`, and `JobManager.submit()` echoes it into the `JobQueued` event payload
  (`payload: {tool: metadata.tool ?? null, ...}`). `tool` is an MCP-flavored label for what is
  really generic submission provenance, and it is not referenced in any frozen contract table in
  `FOUNDATION_FREEZE.md` or `OBSERVABILITY_FREEZE.md`. **However**, unlike those two documents,
  `ADR-0002` *does* freeze this exact shape: its Event contract table lists `JobQueued`'s payload
  as `{ tool, model, effort, metadata }` verbatim, and that ADR's own rule is explicit — *"a
  future breaking change to any payload shape bumps [`EVENT_SCHEMA_VERSION`], per the same
  breaking-change discipline `FOUNDATION_FREEZE.md` already applies to MCP schemas."* Renaming
  `payload.tool` → `payload.source` (and the mirrored `metadata.tool` → `metadata.source`) is
  exactly such a payload-shape change to a frozen event type, not an unconstrained internal
  detail — confirmed observably breaking, not byte-identical, by the existing tests that already
  construct jobs on this exact key (`tests/fileJobStore.test.js:23`,
  `tests/workspaceManager.test.js:76` and `:98`, each passing `{tool: "delegate_task"}` /
  `{tool: "delegate_submit"}` as `metadata`). **Decision: do *not* rename this field in this ADR.**
  `DelegationService.submit(input, toolName)` keeps storing `metadata.tool` and `JobManager.
  submit()`'s `JobQueued` payload keeps `payload.tool`, unchanged, so `EVENT_SCHEMA_VERSION` stays
  at `1` and Stage 1b's "byte-identical behavior" and **patch** classification both hold without
  qualification. The generic-naming observation is real but is exactly the kind of speculative
  improvement this ADR already declines to make ahead of a concrete need elsewhere (see §4's
  `subscribeToJob()` reasoning): if a future caller genuinely needs a non-tool-shaped provenance
  label, that is its own ADR, done explicitly alongside an `ADR-0002` amendment and an
  `EVENT_SCHEMA_VERSION` bump — not folded silently into this one's patch-classified refactor.

## 3. Which responsibilities belong to transport adapters

A transport adapter owns everything specific to *how one wire protocol talks*, nothing about
*what the system does*. Concretely, verified against this codebase's own MCP adapter as the
worked example — every item below stays in `src/server/mcpServer.js`/`src/handlers/*.js`, is
never pushed into `ObservabilityService`/`DelegationService`, and each has a distinct REST/
Dashboard/Plugin equivalent that would look nothing alike:

1. **Protocol-specific request schema/validation shape** — `JOB_ID_FIELD`,
   `DelegateTaskInputShape` (zod) are defined and consumed only in `src/server/mcpServer.js`
   (verified by import trace, `ADR-0007` §4); a REST route's equivalent is its own path/body
   validation (e.g. JSON-schema, a different library), never this zod shape directly.
2. **Protocol-specific response envelope** — MCP's `{content: [{type: "text", text}],
   structuredContent}` pairing, present in every handler today. A REST adapter returns a JSON
   body; a Dashboard backend may return whatever its own view layer expects.
3. **Human-readable text formatting** — `delegateStatusHandler`'s `summary` string,
   `delegateHistoryHandler`'s per-job line, `delegateReplayHandler`'s if/else, cancel/submit's
   messages. `ADR-0007` names this explicitly: *"presentation formatting for MCP's
   `content[0].text` channel — not a decision about replay data."* Every transport builds its
   own.
4. **Protocol-specific error shaping** — `toToolErrorContent()` (`src/utils/errors.js`) maps any
   `Error` to MCP's `{isError, content}`. A REST adapter maps the same underlying `Error` to an
   HTTP status + JSON error body instead — a different mechanism serving the same underlying
   error, never a shared one.
5. **Protocol-specific push/notification mechanism** — `mcpProgressAdapter.js`'s
   `forwardJobProgressToMcp()`, wired to `extra._meta.progressToken`/`extra.sendNotification`/
   `notifications/progress` — MCP-specific by its own doc comment. A REST-SSE stream or
   Dashboard WebSocket push needs its own equivalent, not this one (see §4 on why this isn't
   generalized yet).
6. **Protocol-specific per-request context extraction** — the `extra` parameter (MCP SDK request
   context) is this transport's equivalent of REST's `req`/`res` or a WebSocket's socket handle;
   none of it belongs below the handler.
7. **Tool/route registration metadata** — `server.registerTool()`'s `title`/`description`/
   `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) are
   MCP-protocol hints with no REST/Dashboard equivalent slot.
8. **Protocol-specific auth/session handling** — whatever the MCP SDK's transport layer does for
   stdio/HTTP session establishment must never leak into `JobManager`/`ObservabilityService`/
   `DelegationService`, matching how none of it appears there today.

## 4. Which responsibilities remain inside ObservabilityService and DelegationService

**`ObservabilityService`** — unchanged, per its already-frozen contract (§1). The **Passive
Observation Rule** and **Dependency Direction** (both `ADR-0003`, reused here by reference, not
re-derived) continue to govern it exactly as written.

**`DelegationService`** — this ADR extends the same two named principles to the write side,
symmetrically rather than inventing new names for the same shape:

- **Single Mutation Path Rule** (the write-side mirror of the Passive Observation Rule).
  `JobManager.submit`/`_transition`/`_run` remains the one write path into job state
  (`FOUNDATION_FREEZE.md`: *"`JobManager` is the single source of truth for job state — no other
  component may claim authority"*). `DelegationService` adds no new mutation logic of its own —
  it is a pass-through to `JobManager`'s existing methods, exactly as `ObservabilityService` adds
  no new read-derivation logic beyond what `MetricsCollector`/`TimelineStore` already compute.
  Verifiable the same way `OBSERVABILITY_FREEZE.md` verifies the read side: a future test can
  assert `DelegationService` calls exactly one `JobManager` mutator per operation, never
  duplicating `cancelJob`'s queued/starting/running branching or `submit`'s transition logic
  inline in a handler.
- **Dependency Direction, extended**: `RuntimeEventBus ← JobManager ← DelegationService ←
  transports`, run alongside (not merged with) the existing `RuntimeEventBus → Observability →
  Dashboard → Future Consumers` read-side diagram. `DelegationService` never calls `bus.publish`
  or `bus.subscribe` directly — `JobManager` already owns all publishing internally, so there is
  nothing left for `DelegationService` to publish. Its only bus-shaped behavior is forwarding the
  existing `jobManager.bus` reference into `claudeCliService.invoke()` (so `OutputChunk` events
  publish during execution) — inherited unchanged from today's `submitDelegation()`, not new
  coupling introduced by this ADR.
- **Business/domain validation and state-transition rules** stay in `JobManager`
  (`cancelJob`'s queued-vs-starting/running branching, `TERMINAL_STATUSES` immutability) plus the
  new input-validation call in `DelegationService.submit()` (§2) — never reimplemented inside a
  handler.
- **Data-shape ownership** — `toJobView()`/`summarizeJob()` remain the one adapter from raw
  `Job` to view/summary, called from inside `DelegationService`'s methods; no transport hand-rolls
  its own projection of `job.result`/`job.metadata`.
- **Retry/eviction/bounding and concurrency/queueing policy** — `JobManager._trimHistory()`,
  `_drain()`/`pending`/`maxConcurrent` are untouched and never duplicated by a transport adapter.
- **Security-sensitive redaction** — `delegationService.js`'s existing rationale for never
  copying raw `environment`/context into `job.metadata` (it would leak secrets through
  `delegate_status`'s response) is preserved verbatim inside the new `submit()` implementation.

**Two design questions this ADR resolves rather than leaves open:**

- *Single facade or two?* **Two, composed side by side, never merged.** Merging
  `DelegationService`'s write methods into `ObservabilityService` (or vice versa) would dilute
  the Passive Observation Rule's structural guarantee (`Object.keys(observability)` contains no
  mutator) into something that has to be re-verified by convention instead of by construction.
  `mcpServer.js` continues constructing both independently and passing whichever a given handler
  needs — `delegateTaskHandler` already takes multiple named dependencies today (`config`,
  `logger`, `jobManager`, `service`); adding `delegationService` alongside `jobManager` is the
  same shape, not a new one.
- *Does `waitForCompletion`/`bus` belong on `DelegationService`?* **No — stays a documented
  exception on `jobManager` directly, held by `delegateTaskHandler.js` only.**
  `waitForCompletion()` exists purely so a caller can block until a terminal status — exactly
  `delegate_task`'s frozen synchronous contract (`FOUNDATION_FREEZE.md`: *"synchronous, blocks
  until terminal"*), not a shape any other transport wants: REST/Dashboard adapters would poll
  `getJob`/`listJobs` (mirroring `delegate_status`/`delegate_history` today) or eventually
  subscribe to bus events directly, never block a request thread on a CLI subprocess bounded only
  by `config.spawnTimeoutMs`. Similarly, `forwardJobProgressToMcp()` stays in
  `mcpProgressAdapter.js`, called directly from `delegateTaskHandler.js` — this ADR does
  **not** generalize progress forwarding into a formal `subscribeToJob()` service primitive. The
  underlying capability (`jobManager.bus.subscribe(type, cb)` plus `EVENT_TYPES`) is already a
  transport-agnostic primitive any future adapter could use directly; committing to a specific
  wrapper shape before a second concrete consumer (a real REST-SSE or Dashboard-WebSocket build)
  exists to validate what that shape should be would be speculative — the same "not built
  speculatively... a scoped addition at that time" discipline `ADR-0003` already applied to
  `ConsumerRegistry`'s push semantics.

## 5. How Dashboard, REST, and Plugins can all reuse identical backend logic

Every transport is a thin adapter over the same two constructed objects
(`ObservabilityService`, `DelegationService`) — none of them import each other's adapter code,
all of them import the same backend logic:

| Concern | MCP (today) | REST (future) | Dashboard (future) |
|---|---|---|---|
| Get job status | `delegateStatusHandler` → `delegationService.getJob(id)` (view-shaped internally) → MCP envelope | `GET /jobs/:id` → identical call → JSON body | Same call, in-process or via REST, → rendered view |
| List jobs | `delegateHistoryHandler` → `delegationService.listJobs({status,limit})` (filtered+summarized internally) | `GET /jobs?status=&limit=` → identical call → JSON array | Same |
| Submit job | `delegateSubmitHandler`/`delegateTaskHandler` → `delegationService.submit(input, toolName)` | `POST /jobs` → identical call, but never blocks the request thread the way `delegate_task` does — polls or streams instead | Same, via REST |
| Cancel job | `delegateCancelHandler` → `delegationService.cancelJob(id)` | `DELETE /jobs/:id` → identical call | Same |
| Metrics/snapshot/replay | `delegate_metrics`/`delegate_snapshot`/`delegate_replay` → `observabilityService.*` | `GET /metrics`, `GET /snapshot`, `GET /jobs/:id/replay` → identical calls | Same, polled |

**Two-tier framing for the read side (extends unchanged to the write side)**, resolving a
distinction the research surfaced but which no prior ADR stated explicitly:

- **End-user/AI-facing methods** — `getMetrics`/`getTimeline`/`replay`/`getSnapshot`/`submit`/
  `getJob`/`listJobs`/`cancelJob` — any transport wraps these 1:1 as its own external
  endpoint/tool, exposed to *that transport's own* external callers (an MCP client, an HTTP
  caller, a Dashboard user).
- **Transport-infrastructure methods** — `ConsumerRegistry`'s `registerConsumer`/`touchConsumer`/
  `unregisterConsumer`/`listConsumers`/`getConsumerHealth`/`getConsumerStatistics`. Reconfirmed
  (`ADR-0009`, `CAPABILITY_ROADMAP_REBASELINE.md` finding #3) as the wrong shape for a one-shot
  MCP tool call, but a good fit for a long-lived REST/Dashboard **backend process**: such a
  process registers itself once at its own boot, holds the handle in process-level state,
  touches it on its own cadence, and unregisters at its own graceful shutdown — **one
  registration per backend process instance, at process boot/shutdown, never per incoming HTTP
  request.** Never exposed symmetrically as that transport's own external endpoint (no browser or
  curl caller would ever invoke "register a consumer"). A legitimate secondary use:
  `listConsumers()`/`getConsumerStatistics()` could power an internal ops/admin view once
  multiple REST/Dashboard instances exist (horizontal scaling) — out of scope for this ADR,
  noted for whichever future ADR designs that deployment shape.
- **`getTimeline()`'s `{type, since}` filtering** is re-opened as a live question for REST/
  Dashboard specifically, not foreclosed by `ADR-0007`/`ADR-0009`'s "redundant with
  `delegate_replay`" finding. That finding is transport-specific: `replayEngine.js`'s runtime
  tier calls `getTimeline(jobId)` with no filter, and no MCP tool exposes `type`/`since` — true,
  but only because no MCP consumer has asked for filtering. A REST/Dashboard consumer doing live
  polling (`getTimeline(jobId, {since: lastPollTimestamp})`) has a concrete, different use this
  MCP-specific rejection didn't evaluate — deferred to the REST API Foundation ADR to decide
  whether it becomes its own endpoint or a query parameter on a replay-style endpoint.

## 6. Migration strategy

**Stage 0 (this ADR, current gate, no code)** — draft and get this ADR reviewed and approved.
Per `PUSH_REPORT.md`, this gate is already live, not hypothetical.

**Stage 1a — characterization tests only, zero production code.** Inspector `tools/list` schema
snapshot for all 9 tools; e2e assertions pinning today's exact request/response shapes and
job-lifecycle transitions for `delegate_task`/`delegate_submit`/`delegate_status`/
`delegate_history`/`delegate_cancel`. Independently valuable and de-risks Stage 1b; ships as its
own PR before any handler is touched.

**Stage 1b — the write-side service refactor.** Evolve `delegationService.js` into
`createDelegationService(...)` (§ Decision), reroute all five write-side handlers, verify
byte-identical behavior against Stage 1a's tests. Update `FOUNDATION_FREEZE.md`'s sentence
naming `submitDelegation()` as "the single path into `JobManager`" to name `DelegationService`
instead — done via this ADR, not silently, satisfying `FOUNDATION_FREEZE.md`'s own rule that "no
entry in Frozen sections changes without an ADR documenting why." `mcpProgressAdapter.js`'s
direct `jobManager.bus` access stays a documented exception (§4), not moved into
`DelegationService`.

*Versioning*: **patch**, not minor — resolved explicitly here because it was ambiguous in
research (the three prior ADRs were each minor bumps, but each of those added a **net-new tool**,
which `FOUNDATION_FREEZE.md`'s own policy classifies as minor regardless of internal
implementation cost). Stage 1b adds no new tool, no new schema field, no new response shape — it
is purely an internal dependency-injection change, exactly `FOUNDATION_FREEZE.md`'s own
definition of patch: *"internal fix, doc correction, dead-code removal, non-behavioral
refactor."* `metadata.tool`/`payload.tool` are **not** renamed as part of this stage (§2 reverses
that earlier proposal) — `EVENT_SCHEMA_VERSION` stays at `1`, so nothing in this stage touches
`ADR-0002`'s frozen event contract, and the patch classification holds without exception.

**Stage 2 — REST API Foundation ADR + build.** A thin HTTP adapter mapping 1:1 onto
`ObservabilityService` (proven three times over) and `DelegationService` (freshly proven in
Stage 1b). No new business logic in the HTTP layer — every responsibility in §3 lives there;
everything in §4 does not.

**Stage 3 — Dashboard as a thin UI over REST only.** **Explicitly rejected: a Dashboard
colocated in-process, calling `ObservabilityService`/`DelegationService` directly instead of
through REST**, even though technically convenient. `CAPABILITY_ROADMAP_REBASELINE.md`'s own
reasoning ranks REST beneath Dashboard specifically because REST is the *shared* substrate
Dashboard, Plugin API, and automation all sit on; an in-process Dashboard bypassing REST
recreates the exact redundant-parallel-path problem Stage 1 exists to eliminate on the write
side, one layer up.

**Stage 4 — Plugin API**, parked until a concrete consumer exists (no named use case today).
**Analytics layer** (cross-job historical/trend aggregation) rides along later as a REST
endpoint, not its own MCP tool or stage, per `CAPABILITY_ROADMAP_REBASELINE.md`.

## Recommended next sprint

**Stage 1a only: characterization/regression tests, zero production code.** Not Stage 1b, and
not the full four-stage migration — the single smallest safe next step is proving today's exact
observable behavior of the five write-side handlers via Inspector schema snapshots and e2e
lifecycle assertions, as its own PR, before any handler or service file is touched. This is
independently valuable regardless of whether Stage 1b proceeds on the same timeline, and it is
what makes Stage 1b's "byte-identical behavior" claim empirically verifiable rather than
asserted from reading source, matching this project's own `superpowers:verification-before-
completion` discipline (evidence before assertions).

## Explicitly out of scope this ADR

- Any REST API, Dashboard, or Plugin implementation — each is its own future ADR (Stage 2/3/4).
- A generalized `subscribeToJob()` push primitive on `DelegationService` — deferred per §4 until
  a second concrete consumer exists.
- `ConsumerRegistry` exposure as an MCP tool — reconfirmed non-candidate (`ADR-0009`), unchanged
  by this ADR.
- `delegate_timeline`, `delegate_search` — reconfirmed rejected/deferred
  (`CAPABILITY_ROADMAP_REBASELINE.md`), unchanged by this ADR.
- Renaming `job.metadata.tool`/`JobQueued`'s `payload.tool` to a more generic name (e.g.
  `source`) — reversed out of this ADR (§2) once checked against `ADR-0002`'s frozen Event
  contract table; would require its own ADR amending `ADR-0002` and bumping
  `EVENT_SCHEMA_VERSION`, deferred until a concrete second caller pattern needs it.
- Any change to `ObservabilityService`, `MetricsCollector`, `TimelineStore`, `ReplayEngine`,
  `SnapshotBuilder`, or their frozen contracts.
- Building REST directly against `JobManager`/`ObservabilityService` while deferring the
  handler refactor indefinitely — rejected: the refactor is schema-invisible (§ Compatibility
  impact), so there is no cost/risk justification for the two-divergent-paths shortcut.

## Alternatives considered

- **Merge `DelegationService`'s write methods into `ObservabilityService`** (one facade):
  rejected (§4) — would dilute the Passive Observation Rule's structural guarantee.
- **Leave `submitDelegation()` a bare function, build REST directly against `JobManager`**:
  rejected — forks "the single path into `JobManager`" into two independently-evolving
  consumers (MCP's inline calls vs. REST's inline calls), reintroducing the exact anti-pattern
  `ADR-0003` eliminated on the read side.
- **Generalize `forwardJobProgressToMcp()` into a transport-agnostic `subscribeToJob()` now**:
  rejected — no second concrete consumer exists yet to validate the right shape (backpressure,
  which event types to forward, etc.); `ADR-0003` applied the identical reasoning to
  `ConsumerRegistry`'s push semantics.
- **Skip Stage 1a and refactor the handlers directly**: rejected — Stage 1's real surface (5
  handlers + `delegationService.js` + a bus-access decision) is wider than any single prior
  `ADR-0007`/`0008`/`0009` sprint (each touched one new handler file + one `registerTool` call);
  undersizing it the way `delegate_snapshot` was casually sized would understate the actual
  review/testing effort required.
- **Build Dashboard colocated in-process over the services, skipping REST**: rejected (§6,
  Stage 3) — reintroduces a redundant parallel path one layer up.
- **Rename `metadata.tool`/`payload.tool` → `.source` as part of this ADR's patch-classified
  Stage 1b** (an earlier draft of this ADR proposed exactly this): rejected on reconsideration
  (§2) — `ADR-0002` freezes this exact `JobQueued` payload shape and requires an
  `EVENT_SCHEMA_VERSION` bump for any breaking change to it; bundling an unversioned rename into a
  stage classified as **patch** would silently violate that frozen ADR's own rule and falsify the
  "byte-identical" claim against Stage 1a's characterization tests.

## Compatibility impact

- Zero MCP schema change. `FOUNDATION_FREEZE.md`'s nine frozen tool schemas, the frozen
  execution contract's sync/async shapes, the frozen Job lifecycle, and the frozen
  `ExecutionContext` contract are all unaffected.
- One sentence in `FOUNDATION_FREEZE.md`'s "Frozen execution contract" section changes (naming
  `DelegationService` instead of `submitDelegation()` as the single path into `JobManager`) —
  done via this ADR, per that document's own breaking-change policy ("no entry ... changes
  without an ADR documenting why"). The underlying guarantee — one single path, same sync/async
  response shapes — is preserved, not broken.
- `job.metadata.tool` / the `JobQueued` event's `payload.tool`: **unchanged** (§2 reverses the
  earlier rename proposal once `ADR-0002`'s frozen Event contract table and
  `EVENT_SCHEMA_VERSION` rule were checked — this field *is* part of a frozen contract, just not
  one of the two freeze documents this ADR checked first). `EVENT_SCHEMA_VERSION` stays at `1`;
  zero impact on `ADR-0002`.
- `ADR-0003`'s "Components"/"Dependency Direction" sections get a corrective note about
  `getJobSummary()` (§1) — a doc-accuracy fix, not a contract change.
- Overall classification: **patch**, per `FOUNDATION_FREEZE.md`'s own versioning policy (§6).

## Testing / verification plan

- **Stage 1a** (this ADR's recommended next sprint): Inspector `tools/list` snapshot for all 9
  tools; e2e tests pinning exact request/response shapes and lifecycle transitions for the five
  write-side tools against the current implementation, committed before any handler changes.
- **Stage 1b**: `npm test` stays green; every Stage 1a assertion re-run and must pass unchanged
  against the refactored handlers; a live Inspector `tools/list` diff against the pre-refactor
  snapshot must show zero schema changes across all 9 tools; a real end-to-end
  `delegate_task`/`delegate_submit`/`delegate_status`/`delegate_history`/`delegate_cancel` call
  sequence against a real `JobManager` + the new `DelegationService`, not mocks.
- This ADR itself introduces no code, so there is nothing to test yet — the plan above is scoped
  to the sprint this ADR recommends and gates, not to this document.

## Confirmation

This ADR proposes **no code changes**. It is a design document only, gated for the user's
separate review and approval before any implementation plan, TDD sprint, or code change begins —
consistent with `PUSH_REPORT.md`'s standing instruction and this repository's own governance
precedent (`ADR-0007`/`ADR-0008`/`ADR-0009` were each written and approved before their
implementation waves began).
