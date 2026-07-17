# ADR-0010 Final Architecture Review Package (Self-Contained)

**Subject:** `docs/adr/ADR-0010-unified-access-layer.md` (`main` at `e8c49b3`, 4 commits ahead of
`origin/main`, not pushed, prior to this package's own commit). **Status: awaiting architecture
approval.** This document replaces the earlier review package in full and does not depend on it —
every claim below is either derived from a direct source read (file:line cited) or from the ADR
text itself (section cited). No production code has been changed by ADR-0010, by this package, or
by any work described here. No implementation plan exists. Stage 1a has not started.

---

## 1. Executive Summary

**The asymmetry this ADR resolves.** `ObservabilityService` (`src/services/observabilityService.js`)
is a transport-agnostic, read-only façade: its only coupling to `RuntimeEventBus` is one
`bus.subscribeAll()` call at construction, it holds no reference to `JobManager` or
`claudeCliService`, and this is enforced structurally (`docs/OBSERVABILITY_FREEZE.md`: *"verified
structurally (`Object.keys(observability)` contains no mutator) and by regression test"*). Three
MCP tools already prove this façade is cheap to expose: `delegate_replay` → `replay()`
(`ADR-0007`), `delegate_metrics` → `getMetrics()` (`ADR-0008`), `delegate_snapshot` →
`getSnapshot()` (`ADR-0009`) — each a two-line handler, zero lines changed in
`ObservabilityService` to add any of the three.

No equivalent exists for writes. `src/handlers/delegateStatusHandler.js` calls
`jobManager.getJob(job_id)` directly. `delegateHistoryHandler.js` calls `jobManager.listJobs()`
directly, then performs filtering/pagination itself. `delegateCancelHandler.js` calls
`jobManager.cancelJob(job_id)` directly. `delegateSubmitHandler.js` and `delegateTaskHandler.js`
both call `submitDelegation()` (`src/services/delegationService.js`) — a bare exported function,
not an object with its own boundary, that itself takes `jobManager` as a raw parameter.
`src/services/jobManager.js`'s `JobManager` class exposes `submit`/`getJob`/`listJobs`/
`waitForCompletion`/`cancelJob` directly to any caller — no wrapper, no structural enforcement.
A future REST API, Dashboard, or Plugin wanting to submit, cancel, or query a job today would have
no choice but to reach directly into `JobManager` — the exact "every transport directly coupled to
internal state" anti-pattern `ADR-0003` already eliminated on the read side.

**The decision.** Introduce `DelegationService` — evolving today's
`src/services/delegationService.js` from a bare `submitDelegation()` export into a factory,
`createDelegationService({jobManager, config, logger, service, workspace})`, returning a frozen
object with exactly four methods: `submit`, `getJob`, `listJobs`, `cancelJob`. It is held **side by
side with `ObservabilityService`, never merged into one facade** — `mcpServer.js` constructs both
independently, exactly as it already constructs `observabilityService` today. Two named
architectural principles govern it, both extending existing `ADR-0003` principles rather than
inventing new ones: the **Single Mutation Path Rule** (the write-side mirror of the Passive
Observation Rule — `DelegationService` adds no mutation logic of its own, it is a pass-through to
`JobManager`'s existing methods) and an extended **Dependency Direction** diagram (§3 below).

**What changes, concretely, if Stage 1b is later approved and built:** the five write-side MCP
handlers stop calling `jobManager`/`submitDelegation()` directly and call `delegationService.*`
instead. `delegateTaskHandler.js` keeps one documented exception — a direct `jobManager` reference
for `waitForCompletion()`/`jobManager.bus`, because those are specific to `delegate_task`'s frozen
synchronous contract, not something any other transport wants. One sentence in
`docs/FOUNDATION_FREEZE.md` (naming the single path into `JobManager`) is updated to name the new
service. Nothing else changes: zero MCP schema diff, zero change to `ObservabilityService`, zero
change to any persisted format, zero change to `RuntimeEventBus`'s event schema.

**What this ADR does not do.** It does not implement REST, Dashboard, or Plugin support. It does
not touch any production code. It does not decide `getTimeline()`'s future REST shape, does not
rename `job.metadata.tool`, does not generalize progress-notification forwarding into a formal
subscription primitive, and does not merge the two facades. Each of these was considered and
explicitly declined or deferred, with a stated reason (§7, §11).

**Where this stands.** Four independent research passes grounded the original draft in direct
source reads. Two independent adversarial reviews followed, together finding and fixing four real
defects before this package was assembled: (1) a proposed rename of `job.metadata.tool` that
silently violated `ADR-0002`'s frozen event schema, (2) a self-contradiction between one section's
absolute claim about `JobManager` encapsulation and another section's documented exception, (3) an
unassigned piece of business logic (`delegate_history`'s filter/pagination) implied only by a type
signature, and (4) an ambiguous return-type contract between raw `Job` and the already-shaped
view/summary types. All four are resolved in the current ADR text (commit `4bf2f4e`); see §6 and
§10 for the evidence trail on each.

**What is being asked of you now.** Approve, request changes, or reject the architecture described
here. Nothing pushes to `origin`. No implementation plan is written. Stage 1a does not begin until
you respond. §11 lists every remaining assumption that has not been given your explicit sign-off.

---

## 2. Responsibilities Matrix

| Responsibility | `DelegationService` (new) | `ObservabilityService` (unchanged) | `JobManager` (unchanged) | MCP handlers (all 9, post-refactor) | Future REST adapter | Future Dashboard adapter |
|---|---|---|---|---|---|---|
| Own authoritative job state | No | No | **Yes — sole owner** (`FOUNDATION_FREEZE.md`: *"no other component may claim authority over a job's status/result"*) | No | No | No |
| Mutate job state | Pass-through call only, no logic of its own | **Never** (Passive Observation Rule) | Yes — the only component that ever calls `store.create/update/delete`, `bus.publish` for job events, or manages `pending`/`running` | **Never** | **Never** | **Never** |
| Derive read-only aggregates (metrics/timeline/snapshot/replay) | No | **Yes, exclusively**, via its substrate (`MetricsCollector`, `TimelineStore`, `ReplayEngine`, `SnapshotBuilder`) | No | No | No | No |
| Business/domain validation & state-transition rules | No — none of its own | N/A (nothing to validate; read-only) | **Yes** — `cancelJob`'s queued-vs-starting/running branching, `TERMINAL_STATUSES` immutability, `_drain`/`_run`/`_transition`'s scheduling and status-machine logic | **Never** | **Never** | **Never** |
| Input schema validation | **Yes (new)** — `submit()` calls the existing, already-exported `DelegateTaskInputSchema.parse(input)` internally, before building `ExecutionContext` | N/A | No | No (delegates to the MCP SDK today, which validates before the handler runs; this becomes a second, redundant-but-harmless check for MCP callers and the only check for any future non-MCP caller) | Own request validation (its own framework's mechanism), then calls the same shared service, which validates again | Own form validation, then calls the same shared service |
| View/summary shaping (`toJobView`/`summarizeJob`) | **Yes (new placement)** — `getJob()` returns `JobView`, `listJobs()` returns `JobSummary[]`, both shaped internally | N/A (`OBSERVABILITY_FREEZE.md`'s own shapes: `Metrics`/`TimelineEntry`/`Snapshot`/`ConsumerInfo`) | No — returns raw `Job` only | **Never post-refactor** — stop importing `src/models/job.js` entirely | Reuses `DelegationService`'s already-shaped output verbatim | Same |
| List filtering/pagination (`status`, `limit`) | **Yes (new placement)** — moves from `delegateHistoryHandler.js` into `listJobs({status, limit})` | N/A | No — `listJobs()` takes zero arguments | **Never post-refactor** | Own query-string parsing, then calls the shared service with the same `{status, limit}` shape | Same |
| Retry/eviction/bounding/concurrency policy | No | No (its own substrate handles its own bounding — `TimelineStore`'s eviction, `MetricsCollector`'s O(1) aggregates) | **Yes** — `_trimHistory()` (oldest-terminal-first, `maxHistory`-bounded), `_drain()`/`pending`/`maxConcurrent` | **Never** | **Never** | **Never** |
| Security-sensitive redaction | Preserves existing rationale verbatim (never copies raw `environment`/context into `job.metadata` — would leak secrets through `delegate_status`'s response) | N/A | N/A (JobManager never sees raw environment; `ExecutionContext`/workspace layer handles this today, unchanged) | **Never** | **Never** | **Never** |
| `RuntimeEventBus` coupling | Forwards the existing `jobManager.bus` reference into `claudeCliService.invoke()` only (unchanged from today's `submitDelegation()`); never calls `bus.publish`/`bus.subscribe` itself | One `bus.subscribeAll()` at construction, pull-only, never publishes | **Yes — the only publisher** of job lifecycle events (`JOB_QUEUED`, `JOB_STATE_CHANGED`, `JOB_COMPLETED`, `JOB_FAILED`, `JOB_CANCELLED`) | No direct coupling (all through services) | No direct coupling | No direct coupling |
| Protocol-specific request parsing/schema | No | No | No | **Yes** — zod shapes (`JOB_ID_FIELD`, defined in `mcpServer.js`; `DelegateTaskInputShape`, defined in `src/models/schemas.js`), consumed only at MCP tool-registration time in `src/server/mcpServer.js`, never imported by any service | Yes — its own shape (e.g. JSON schema, path/body validation) | Yes — its own shape |
| Protocol-specific response envelope | No | No | No | **Yes** — `{content: [{type:"text", text}], structuredContent}` | Yes — JSON body | Yes — its own view layer |
| Protocol-specific error shaping | No | No | No | **Yes** — `toToolErrorContent()` maps any `Error` to `{isError, content}` | Yes — HTTP status + JSON error body | Yes — its own error UI |
| Protocol-specific push/notification | No — deliberately not generalized (§7) | No (pull-only by design, `ADR-0003`) | Publishes events to the bus; does not push to any transport itself | **Yes, one exception only** — `delegateTaskHandler.js`'s `forwardJobProgressToMcp()`, wired to MCP's `notifications/progress` | Its own mechanism (SSE/webhook) — **not built, not designed yet** | Its own mechanism (WebSocket) — **not built, not designed yet** |
| Protocol-specific auth/session handling | No | No | No | Whatever the MCP SDK's transport layer does for stdio/HTTP session establishment | Its own (e.g. API key, OAuth) | Its own |
| Tool/route registration metadata | No | No | No | **Yes** — `server.registerTool()`'s `title`/`description`/`annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) | Its own route table | N/A — consumes REST, has no registration surface of its own for these operations |

---

## 3. Dependency Graph

```
                              RuntimeEventBus
                             /                \
                            /                  \
             (publishes job lifecycle    (subscribeAll,
              events — sole publisher)    pull-only, never
                           │              publishes)
                           ▼                   ▼
                      JobManager        ObservabilityService
                    (sole owner of        (MetricsCollector,
                     job state;            TimelineStore,
                     _drain/_run/          ReplayEngine,
                     _transition/          SnapshotBuilder,
                     _trimHistory)         ConsumerRegistry)
                      │        │                │
        (submit/      │        │ (bus ref,      │
         getJob/       │        │  forwarded     │
         listJobs/     │        │  unchanged —   │
         cancelJob —   │        │  documented    │
         pass-through, │        │  exception,    │
         no new logic) │        │  §2 of ADR)    │
                       ▼        │                │
              DelegationService │                │
                (input           │                │
                 validation +    │                │
                 view-shaping —  │                │
                 new, additive)  │                │
                       │         │                │
                       ▼         ▼                ▼
     ┌──────────────────────────────────────────────────────┐
     │             MCP handlers (transport adapters)          │
     │  9 tools: delegate_task, delegate_submit,               │
     │  delegate_status, delegate_history, delegate_cancel,    │
     │  delegate_models, delegate_replay, delegate_metrics,     │
     │  delegate_snapshot                                       │
     │  (delegate_task alone also holds a direct JobManager      │
     │   reference for waitForCompletion/bus — the one           │
     │   documented exception in this whole graph)                 │
     └──────────────────────────────────────────────────────┘
                       │         │                │
                       ▼         ▼                ▼
              Future REST    Future Dashboard   Future Plugin
              (Stage 2 —     (Stage 3 — thin    (Stage 4 —
               its own ADR,  UI over REST       parked, no
               not built)    only, not built;    concrete
                             in-process short-   consumer yet)
                             cut explicitly
                             rejected)
```

**Invariant, extended symmetrically from `ADR-0003`'s original one-directional diagram:** the
graph never inverts into a control path. `RuntimeEventBus → JobManager → DelegationService →
transports` (write) runs alongside `RuntimeEventBus → ObservabilityService → transports` (read).
Neither path ever routes back through a service into `JobManager`, the bus, or the execution
engine from a transport adapter. The one documented exception —
`delegateTaskHandler.js` holding a direct `jobManager` reference — is a leaf-level shortcut
*within* the MCP transport layer for a blocking read (`waitForCompletion`) and an existing bus
reference passed through for event publication during execution; it does not reverse the graph's
direction, since `delegateTaskHandler.js` still only reads/awaits/forwards, and any mutation it
triggers goes through `DelegationService.submit()` like every other write path.

**Beneath `JobManager`, unaffected by anything in this ADR (verified directly against
`src/services/jobManager.js`):** `JobManager` holds `this.store`, a `JobStore`-shaped object
(`create`/`get`/`update`/`list`/`delete`, `ADR-0005`'s public contract) — by default
`InMemoryJobStore`, or `FileJobStore` when `mcpServer.js` constructs and injects one.
`jobManager.js` never imports `FileJobStore` itself; the persistence implementation is fully
encapsulated behind the `JobStore` interface. `DelegationService` calls only `JobManager`'s
public methods (`submit`/`getJob`/`listJobs`/`cancelJob`) — it is two full layers removed from
`FileJobStore`/`ADR-0005`'s persistence format and never touches `this.store` directly.

---

## 4. Public API / Contract Definitions

### 4.1 New — `DelegationService`

```js
// src/services/delegationService.js
export function createDelegationService({ jobManager, config, logger, service, workspace }) {
  return Object.freeze({
    submit(input, toolName): string,             // returns jobId
    getJob(jobId: string): JobView | undefined,
    listJobs(filter?: { status?: string, limit?: number }): JobSummary[],
    cancelJob(jobId: string): boolean,
  });
}
```

**`submit(input, toolName)`** — absorbs today's `submitDelegation()` body verbatim (build
`ExecutionContext` via `createExecutionContext(input, config)`, call
`jobManager.submit(taskFn, { tool: toolName, ...context.metadata })`, call
`workspace.createJobWorkspace(jobId, context, config, logger)`), with one addition: calls
`DelegateTaskInputSchema.parse(input)` (`src/models/schemas.js`, already exported, a plain zod
object schema with zero MCP-specific type or framing) before building the `ExecutionContext`.
Returns the new job's id (`string`), identical to today.

**`getJob(jobId)`** — calls `jobManager.getJob(jobId)`, then `toJobView(...)` internally if a job
was found, returning the shaped `JobView` (or `undefined` if not found — `jobManager.getJob()`
already returns `undefined` for an unknown id, per `src/services/jobStore.js`'s `JobStore`
contract, `ADR-0005`).

**`listJobs({status, limit})`** — calls `jobManager.listJobs()` (which takes no arguments and
returns every `Job` in insertion order, per direct read of `src/services/jobManager.js:63`),
applies `if (status) jobs = jobs.filter(j => j.status === status)`, then
`jobs.slice(-limit).reverse()` (both moved verbatim from today's `delegateHistoryHandler.js`),
then `summarizeJob(...)` on each surviving job, returning `JobSummary[]`.

**`cancelJob(jobId)`** — calls `jobManager.cancelJob(jobId)` verbatim, returning the `boolean` it
already returns today (`true` if a cancellation was issued for a queued/starting/running job,
`false` for an unknown id or an already-terminal job).

**Deliberately not wrapped:** `waitForCompletion(jobId)` (stays on `jobManager` directly, called
only by `delegateTaskHandler.js` — this is `delegate_task`'s frozen synchronous contract, not
something any other transport wants; REST/Dashboard would poll `getJob`/`listJobs` instead, never
block a request thread on a CLI subprocess). `jobManager.bus` (forwarded into
`claudeCliService.invoke()` by `submit()`, unchanged from today — not re-exposed as its own
`DelegationService` method). `forwardJobProgressToMcp()` (`src/services/mcpProgressAdapter.js`,
stays wired directly from `delegateTaskHandler.js` — MCP-protocol-specific by its own doc comment).

### 4.2 Data shapes referenced above (already exist today, `src/models/job.js`, reused verbatim,
zero changes)

```js
/** @typedef {Object} Job  — JobManager's raw internal representation, ADR-0005 */
// { id, status, phase, progressMessage, queuedAt, startedAt, finishedAt, runtimeMs, exitCode,
//   metadata, result, error }

/** JobView — toJobView(job): the Job as external tools should see it (live runtimeMs while in flight) */
function toJobView(job) {
  return { ...job, runtimeMs: deriveRuntimeMs(job) }; // deriveRuntimeMs computes elapsed time live for non-terminal jobs
}

/** JobSummary — summarizeJob(job): lean projection for list views (drops raw CLI output) */
function summarizeJob(job) {
  const view = toJobView(job);
  return {
    id: view.id, status: view.status, phase: view.phase, progressMessage: view.progressMessage,
    model: view.metadata?.model ?? null, queuedAt: view.queuedAt, startedAt: view.startedAt,
    finishedAt: view.finishedAt, runtimeMs: view.runtimeMs, exitCode: view.exitCode,
    costUsd: view.result?.parsed?.total_cost_usd ?? null, error: view.error,
  };
}
```

### 4.3 Unchanged — `ObservabilityService` (`src/services/observabilityService.js`), no changes
proposed anywhere in ADR-0010

```js
ObservabilityService = Object.freeze({
  getMetrics(): Metrics,
  getTimeline(jobId, filter?: { type?: string, since?: string }): TimelineEntry[],
  replay(jobId): { source: "runtime"|"durable"|"workspace"|"unavailable", timeline: object[] },
  getSnapshot(): { takenAt: string, metrics: Metrics, activeJobs: object[] },
  registerConsumer(name, metadata?): { id, unregister(), touch() },
  unregisterConsumer(id): boolean,
  touchConsumer(id): void,
  listConsumers(): ConsumerInfo[],
  getConsumerHealth(id): object,
  getConsumerStatistics(): object,
  close(): void,
})
```
(Per `docs/OBSERVABILITY_FREEZE.md`'s frozen method table — the normative source ADR-0010 cites,
not `ADR-0003`'s original "Components" prose listing, which still names a never-implemented
`getJobSummary(jobId): JobSummary | null` — confirmed absent from `src/` and from
`OBSERVABILITY_FREEZE.md` by direct search; stale drift in `ADR-0003`'s narrative, not the frozen
contract. ADR-0010 recommends — but does not itself perform — a one-line corrective note at
`ADR-0003`'s two mentions of this method; see §11, Open Question 8.)

### 4.4 Changed — one sentence in `docs/FOUNDATION_FREEZE.md` (Stage 1b only, not by this ADR
itself)

Current text (paraphrased from the frozen execution-contract section): *"Both `delegate_task` and
`delegate_submit` submit through `services/delegationService.js`'s `submitDelegation()` — the
single path into `JobManager`."* Changes, during Stage 1b, to name `DelegationService` instead of
`submitDelegation()`. Done via this ADR, per `FOUNDATION_FREEZE.md`'s own rule: *"no entry in
Frozen sections changes without an ADR documenting why."* The underlying guarantee — one single
path, same synchronous/async response shapes — is preserved, not broken.

### 4.5 Unchanged, explicitly confirmed — every MCP tool schema (all 9), `job.metadata.tool` /
`JobQueued`'s `payload.tool`, `EVENT_SCHEMA_VERSION` (stays `1`)

---

## 5. Backward Compatibility Analysis

| Surface | Impact | Evidence |
|---|---|---|
| MCP tool schemas (all 9 tools' `inputSchema`/`title`/`description`/`annotations`) | **Zero change** | `registerTool()` calls in `mcpServer.js` are independent of which object a handler factory is given as a dependency — swapping `createDelegateStatusHandler({jobManager})` for `createDelegateStatusHandler({delegationService})` touches zero characters of the schema block. Same pattern already proven three times: `ADR-0007`/`0008`/`0009` each added a tool with a live Inspector `tools/list` byte-diff showing the other tools unchanged. |
| Request/response shapes an MCP client observes | **Zero change** | `toJobView`/`summarizeJob`'s output shape is reused verbatim (§4.2); `{success: true, job_id, status}` (`delegate_submit`), `{content, structuredContent}` envelopes, and every handler's text-formatting logic are untouched by this ADR — only *which internal object* the handler calls changes, a fact never observable from outside the process. |
| `JobQueued` event payload / `EVENT_SCHEMA_VERSION` (`ADR-0002`) | **Zero change** | A rename (`payload.tool` → `payload.source`) was proposed in an earlier draft and explicitly reversed after checking `ADR-0002`'s frozen Event contract table and finding two existing tests construct jobs on the `tool` key directly (`tests/fileJobStore.test.js:23`, `tests/workspaceManager.test.js:76`/`:98`). `metadata.tool`/`payload.tool` stay exactly as they are today; `EVENT_SCHEMA_VERSION` stays `1`. |
| Persisted job format (`FileJobStore`, `ADR-0005`) | **Zero change** | `DelegationService` never touches `this.store`; it calls only `JobManager`'s already-existing public methods, which route through `this.store` exactly as they do today. No new field is added to a persisted job; no hydration logic changes. |
| Durable event log (`EventHistoryStore`, `ADR-0006`) | **Zero change** | `EventHistoryStore` subscribes to `RuntimeEventBus` independently of any caller of `JobManager`; `DelegationService` never publishes to the bus itself (only forwards the existing `jobManager.bus` reference into `claudeCliService.invoke()`, unchanged). `JobManager`'s publish call sites, event types, and payload shapes are untouched by this ADR, so `EventHistoryStore` continues to see an identical event stream. |
| `docs/FOUNDATION_FREEZE.md` prose | **One sentence changes, by design, during Stage 1b** | The sentence naming `submitDelegation()` as "the single path into `JobManager`" is updated to name `DelegationService`. This is a change the freeze document's own rule anticipates ("no entry ... changes without an ADR documenting why") — the underlying guarantee (one single path) is preserved, not broken. |
| `ADR-0003`'s "Components"/"Dependency Direction" prose | **One corrective note recommended, not yet applied by this ADR** | Flags `getJobSummary(jobId)` as stale/never-implemented (§4.3). `git show --stat` across every ADR-0010 commit (`3c0e913`, `858a308`, `4bf2f4e`) touches only `docs/adr/ADR-0010-unified-access-layer.md` — `ADR-0003` itself has not been edited. |
| External callers (Claude Desktop or any other MCP client) | **None observable** | Every impact above is internal call-routing; nothing changes in what a caller sends or receives. |

**Overall classification: patch**, per `FOUNDATION_FREEZE.md`'s own versioning policy — defined
there as *"internal fix, doc correction, dead-code removal, non-behavioral refactor,"* the exact
shape of Stage 1b (no new tool, no new schema field, no new response shape — contrast with
`ADR-0007`/`0008`/`0009`, each classified **minor** because each added a net-new tool, which
`FOUNDATION_FREEZE.md`'s policy classifies as minor regardless of internal implementation cost).
This classification is itself flagged as an assumption warranting your explicit sign-off — see
§11, Open Question 5.

---

## 6. ADR-0002 / ADR-0003 / ADR-0005 / ADR-0006 / ADR-0007 / ADR-0008 / ADR-0009 Compliance Matrix

| ADR | What it governs | Does ADR-0010 touch this? | Compliance verdict | Evidence |
|---|---|---|---|---|
| **ADR-0002** — Streaming & Event Architecture | `RuntimeEventBus`'s event schema, including the frozen `JobQueued` payload shape `{tool, model, effort, metadata}`, `EVENT_SCHEMA_VERSION`'s breaking-change rule | Was proposed to touch it (rename), now does not | **Compliant, after one defect found and fixed.** First draft proposed renaming `metadata.tool`/`payload.tool` → `.source`, classified as non-breaking **patch**, without citing `ADR-0002` at all. An independent adversarial review caught this: the rename is a payload-shape change to a frozen event type per `ADR-0002`'s own rule, and is observably breaking (two existing tests construct jobs on the `tool` key directly). **Resolution: the rename is reversed** (§4.5). `EVENT_SCHEMA_VERSION` stays `1`. | `docs/adr/ADR-0002-streaming-and-event-architecture.md`'s Event contract table (`JobQueued` row); `tests/fileJobStore.test.js:23`; `tests/workspaceManager.test.js:76,:98`; `src/services/jobManager.js:52` (`payload: {tool: metadata.tool ?? null, ...}`) |
| **ADR-0003** — Observability Architecture | The Passive Observation Rule, Dependency Direction, Non-Goals, Data Ownership for `ObservabilityService` | Extends two named principles to the write side; does not modify `ObservabilityService` itself | **Compliant, extended symmetrically, not restated.** The **Single Mutation Path Rule** (new, this ADR) mirrors the Passive Observation Rule: `DelegationService` adds no mutation logic of its own, it is a pass-through to `JobManager`'s existing methods — verified directly, `submit`/`getJob`/`listJobs`/`cancelJob` each make exactly one call into `JobManager`'s existing public surface, no new branching. The Dependency Direction diagram is extended (§3), not merged, preserving "no control path back through a service." The two facades are kept **separate, composed side by side, never merged** specifically to avoid diluting `Object.keys(observability)`'s structural no-mutator guarantee. One stale-drift finding (`getJobSummary()`, never implemented, still listed in `ADR-0003`'s prose) is flagged, not silently fixed — `ADR-0003` itself is unedited. | `src/services/observabilityService.js` (full read: eleven methods — `getMetrics`, `getTimeline`, `replay`, `getSnapshot`, `registerConsumer`, `unregisterConsumer`, `touchConsumer`, `listConsumers`, `getConsumerHealth`, `getConsumerStatistics`, `close` — zero mutator, one `bus.subscribeAll()`); `docs/OBSERVABILITY_FREEZE.md`; `docs/adr/ADR-0003-observability-architecture.md` lines ~49-102 (Passive Observation Rule, Dependency Direction), ~98/~168 (`getJobSummary` stale mentions) |
| **ADR-0005** — Persistent Job Store | The `JobStore` interface (`create`/`get`/`update`/`list`/`delete`), `FileJobStore`'s on-disk format and hydration semantics | Not touched at all | **Fully compliant — zero interaction, two layers removed.** `JobManager` holds `this.store` (a `JobStore`-shaped object, `FileJobStore` or `InMemoryJobStore`); `jobManager.js` never imports `FileJobStore` itself — the persistence implementation is fully encapsulated behind the interface, injected by whichever module constructs a `JobManager` (`mcpServer.js`). `DelegationService` calls only `JobManager`'s public methods (`submit`/`getJob`/`listJobs`/`cancelJob`); it never references `this.store`, `FileJobStore`, or any hydration/atomic-rewrite logic. No persisted field, format, or recovery-semantics change of any kind. | `src/services/jobManager.js` full read — every `this.store.*` touch, grep-verified: lines 48 (`create`), 60 (`get`), 64 (`list`), 73 (`get`, `waitForCompletion`), 90 (`get`, `cancelJob`), 157/159 (`get`/`update`, `_transition`), 209 (`get`, `_settle`), 218/227 (`list`/`delete`, `_trimHistory`); `docs/adr/ADR-0005-persistent-job-store.md`'s "Public contract — the `JobStore` interface" section (lines 81-105) |
| **ADR-0006** — Persistent Event History | `EventHistoryStore`'s append-only per-job event log, wired via `wireEventHistoryToEventBus` subscribing to `RuntimeEventBus` independently | Not touched at all | **Fully compliant — event stream unaffected.** `JobManager` is the sole publisher of every job-lifecycle `RuntimeEvent` (`JOB_QUEUED` in `submit()`; `JOB_STATE_CHANGED`/`JOB_COMPLETED`/`JOB_FAILED`/`JOB_CANCELLED` via `_transition()`/`_publishTransitionEvent()`) — none of these call sites, event types, or payload shapes change. `DelegationService` never calls `bus.publish`/`bus.subscribe`; its only bus-shaped behavior is forwarding the pre-existing `jobManager.bus` reference into `claudeCliService.invoke()`, unchanged from today's `submitDelegation()`. `EventHistoryStore` subscribes to the same bus independently of any caller of `JobManager` — it cannot observe a difference. | `src/services/jobManager.js` lines 46-57 (`submit`), 156-204 (`_transition`/`_publishTransitionEvent`) — the complete, unchanged set of publish call sites; `docs/adr/ADR-0006-persistent-event-history.md`'s Decision section (event-history bridge subscribes independently to the bus) |
| **ADR-0007** — MCP Replay Access | `delegate_replay` tool, the "thin transport adapter" rule, the rejection of `delegate_timeline` as its own tool | Not reopened; precedent extended, not contradicted | **Compliant.** `delegate_replay`, `replay()`, and `ObservabilityService` are untouched by ADR-0010. `delegate_timeline`'s rejection (strict subset of `replay()`'s runtime tier) is reconfirmed, not reopened, per `CAPABILITY_ROADMAP_REBASELINE.md`. The "thin transport adapter" rule this ADR established (a handler contains zero replay/filtering/persistence/business logic) is the exact rule ADR-0010 extends to the write side via `DelegationService`. | `docs/adr/ADR-0007-mcp-replay-access.md` Alternatives section (delegate_timeline rejection); `src/handlers/delegateReplayHandler.js` (unmodified) |
| **ADR-0008** — MCP Metrics Access | `delegate_metrics` tool, reuse of `ADR-0007`'s six-principle verification by reference | Not touched | **Compliant.** `delegate_metrics`/`getMetrics()` untouched. ADR-0010 follows the same "reuse by reference, don't re-derive" discipline this ADR established, applied here to the Passive Observation Rule/Dependency Direction rather than re-deriving them. | `src/handlers/delegateMetricsHandler.js` (unmodified); `docs/adr/ADR-0008-mcp-metrics-access.md` |
| **ADR-0009** — MCP Snapshot Access | `delegate_snapshot` tool; the finding that `ConsumerRegistry` is likely not MCP-shaped work (a stateful lease/heartbeat API, wrong fit for one-shot calls) | Not touched; the `ConsumerRegistry` finding is extended, not reversed | **Compliant.** `delegate_snapshot`/`getSnapshot()` untouched. `ConsumerRegistry`'s exclusion from any MCP tool is reconfirmed; ADR-0010 additionally works through why it *is* a good fit for a long-lived REST/Dashboard backend process specifically (one registration per process instance at boot/shutdown, never per request) — an extension of the finding to a new transport shape, not a reversal of the original MCP-specific verdict. | `src/handlers/delegateSnapshotHandler.js` (unmodified); `docs/adr/ADR-0009-mcp-snapshot-access.md` |

---

## 7. Migration Strategy

**Stage 0 (current).** This ADR plus this review package. No code. **You are here — awaiting your
approval.** Nothing in Stage 1a begins until you respond.

**Stage 1a — characterization tests only, zero production code.** Inspector `tools/list` schema
snapshot for all 9 tools (proving no accidental schema drift exists even before any refactor
starts). End-to-end assertions pinning today's exact, currently-observed request/response shapes
and job-lifecycle transitions for the five write-side tools (`delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_cancel`) against the *current*, unrefactored
implementation. Ships as its own PR/commit, reviewed and merged before any handler file is
touched. Independently valuable regardless of whether Stage 1b ever proceeds — it is what makes
Stage 1b's "byte-identical behavior" claim empirically checkable rather than asserted from reading
source.

**Stage 1b — the write-side service refactor.** Evolve `src/services/delegationService.js` into
`createDelegationService(...)` (§4.1). Reroute all five write-side handlers to call
`delegationService.*` instead of `jobManager.*`/`submitDelegation()` directly.
`delegateTaskHandler.js` retains its documented `jobManager` exception for
`waitForCompletion`/`bus`. Verify byte-identical behavior against Stage 1a's characterization
suite — every assertion from Stage 1a must pass unchanged against the refactored code. Update
`docs/FOUNDATION_FREEZE.md`'s one sentence naming the single path into `JobManager` (§4.4), done
via this ADR, not silently. `mcpProgressAdapter.js`'s direct `jobManager.bus` access stays
exactly where it is — not moved into `DelegationService`.

**Stage 2 — REST API Foundation ADR + build.** A thin HTTP adapter mapping 1:1 onto
`ObservabilityService` (proven three times over by Stages already shipped) and `DelegationService`
(freshly proven in Stage 1b). No new business logic in the HTTP layer — every responsibility in
§2's "MCP handlers" column applies equally to a REST adapter's own transport-specific concerns;
every responsibility in the `DelegationService`/`ObservabilityService`/`JobManager` columns stays
exactly where it is. This is its own future ADR and its own implementation plan — not started, not
designed beyond the shape already implied by §2's matrix.

**Stage 3 — Dashboard as a thin UI over REST only.** Explicitly rejected: a Dashboard colocated
in-process, calling `ObservabilityService`/`DelegationService` directly instead of through REST —
even though technically convenient, this recreates the exact redundant-parallel-path problem
Stage 1 exists to eliminate on the write side, one layer up. `CAPABILITY_ROADMAP_REBASELINE.md`'s
own reasoning ranks REST beneath Dashboard specifically because REST is the *shared* substrate
Dashboard, Plugin API, and automation all sit on.

**Stage 4 — Plugin API (parked, no concrete consumer today) / Analytics layer (rides along later
as a REST endpoint, not its own MCP tool or stage).** Neither is designed, scoped, or scheduled.

**Recommended next sprint, if and when you approve this ADR: Stage 1a only.** Not Stage 1b, and
not the full four-stage migration — the single smallest safe next step, independently valuable,
zero production code.

---

## 8. Risk Analysis

| # | Risk | Likelihood | Impact | Detection point | Mitigation |
|---|---|---|---|---|---|
| R1 | Stage 1b's refactor surface (5 handler files + `delegationService.js` + a bus-access decision on `delegateTaskHandler.js`) is wider than any single prior `ADR-0007`/`0008`/`0009` sprint, each of which touched exactly one new handler file plus one `registerTool` call — easy to undersize the review/testing effort | Medium | Medium — a schema-invisible behavioral bug could ship undetected if under-tested | Stage 1a's characterization suite, run against Stage 1b's output | Stage 1a is a **separate, mandatory** gate completed and merged *before* Stage 1b starts, giving Stage 1b an objective, pre-existing baseline rather than a claim made only from reading source |
| R2 | Moving input validation (`DelegateTaskInputSchema.parse`) inside `DelegationService.submit()` exercises a code path today's MCP transport doesn't rely on (the MCP SDK already validates before any handler runs) — a latent behavioral difference (e.g. a slightly different error message/shape on invalid input) could exist and go unnoticed until a non-MCP caller hits it | Low for MCP (redundant, defense-in-depth only); unverified for a hypothetical future non-MCP caller | Low today (no non-MCP caller exists yet); would be load-bearing once one does | Stage 1a's characterization tests, if extended to include the validation-rejection path | Include an explicit invalid-input test case (bad `model` enum, non-positive `max_budget_usd`) in Stage 1a's suite so any drift is caught before Stage 1b merges, not after a future REST caller discovers it |
| R3 | `docs/FOUNDATION_FREEZE.md`'s "single path into `JobManager`" sentence is forgotten during Stage 1b, leaving the freeze document stale relative to the actual code | Medium — this exact class of miss cost six review cycles on `ADR-0007` before the project applied the lesson (cut to one cycle by `ADR-0009`) | Low (doc-only, no runtime impact) | Whole-branch review, doc-reconciliation pass | Stage 1b's task brief must name the exact file/sentence to update up front, as `ADR-0009`'s doc task already demonstrated works |
| R4 | `ConsumerRegistry`'s in-memory-only state (no persistence across process restarts) becomes a real limitation once a REST/Dashboard backend process relies on it for ops/admin statistics (a restart looks like a brand-new consumer) | Low, and not until Stage 2/3 exist | Low | Would surface only once Stage 2/3 is built and observed in operation | Out of this ADR's scope entirely; explicitly flagged (§4.3, §11 Open Question 2) for whichever future ADR designs that deployment shape |
| R5 | `getTimeline()`'s `{type, since}` filtering is re-opened as a live design question for REST/Dashboard rather than resolved here, creating a small amount of unresolved design debt carried forward | Certain (deliberate) | None to this ADR's own scope | N/A — deliberate deferral | Explicitly assigned to the REST API Foundation ADR (Stage 2) as a named open item, not left ambiguous |
| R6 | Documentation drift between this ADR's prose and what actually gets implemented in Stage 1b — this has already happened twice during drafting (the `ADR-0002` rename conflict, the `listJobs`/view-shaping ambiguity) | Medium — demonstrated, not hypothetical | Low, self-correcting once caught | Two independent adversarial reviews already performed; a third would be warranted before Stage 1b's own implementation, not before this design-only ADR | This is precisely why Stage 1a exists as *executable* proof rather than relying on prose — and why this package documents every fix's evidence trail rather than only its conclusion |
| R7 | The **patch** (not minor) versioning classification for Stage 1b is a judgment call, not a mechanically derived fact — `FOUNDATION_FREEZE.md`'s policy text supports it, but the three precedent ADRs were all classified **minor**, creating an interpretive gap a future reader could question | Medium (genuinely ambiguous, flagged by the original research) | Low (versioning label only, no functional impact either way) | N/A — a documentation/precedent question | Flagged explicitly as Open Question 5 (§11) for your ratification rather than silently assumed |
| R8 | `delegateCancelHandler.js`'s current three-call sequence (`getJob` → `cancelJob` → `getJob` again) persists unchanged through `DelegationService`, since its contract mirrors `JobManager`'s one-operation-per-method shape rather than collapsing the sequence into a single call — a minor design inefficiency, not a correctness risk | High (certain, given the current contract) | None (no logic hides in the sequencing — verified, no domain decision is made between the three calls) | N/A | Flagged as Open Question 11 (§11) as a possible future refinement, not required for Stage 1b |

---

## 9. Rollback Strategy

**Stage 0 (this ADR + this package).** Nothing to roll back — no code exists. If rejected, the
ADR file and this package simply remain unmerged design artifacts; `main` is already fully clean
and functional at `v2.7.0` regardless of this ADR's fate.

**Stage 1a (characterization tests).** Fully and trivially reversible: test files only, zero
production code. Rollback = delete the new test file(s) via a single revert commit. No data
migration, no schema change, no external contract touched.

**Stage 1b (the service refactor).** Three layers of protection, in order:
1. **Pre-merge**: isolated to a single worktree branch, per this project's established branching
   discipline (`.claude/worktrees/<name>`, branch `worktree-<name>`, never committed to `main`
   directly). If Stage 1a's characterization suite fails against the refactored code, the defect
   is caught *before* the branch is ever merged — it never reaches `main`.
2. **Post-merge, defect found quickly**: `git revert` of the single Stage 1b merge commit. Because
   Stage 1b touches no persisted format (`FileJobStore`/`EventHistoryStore` are both untouched,
   §6) and no external contract (§5), a plain revert restores byte-identical prior behavior with
   zero migration step — no data to reconcile, no schema version to roll back, no consumer to
   notify (since nothing external ever observed a difference in the first place).
3. **Post-merge, defect found later, after `v2.8.0`-equivalent has been tagged/pushed**: same
   `git revert` mechanism, followed by a patch release re-establishing the pre-refactor behavior;
   because the refactor is internal-only, no downstream consumer coordination is required (no MCP
   client pins a schema version that depended on which internal object a handler called).

**Stage 2/3/4.** Each is its own future ADR and its own sprint; none begins until the preceding
stage is merged and certified. A rollback of any later stage never implicates an earlier one,
since each stage's rollback is scoped to its own commits by the same worktree-isolation discipline
used for Stage 1b.

**What would trigger a rollback decision, concretely:** Stage 1a's suite failing against Stage
1b's refactor and not being resolvable within the same review cycle; a live Inspector `tools/list`
diff showing any of the other 8 tools' schemas changed (would indicate the refactor leaked into
territory it should never have touched); or a real end-to-end `delegate_task`/`delegate_submit`/
`delegate_status`/`delegate_history`/`delegate_cancel` call sequence against a real `JobManager` +
the new `DelegationService` producing any output different from the pre-refactor baseline.

---

## 10. Explicit Proof

### 10.1 All transport adapters remain thin

Verified by direct, line-by-line reads of every one of the 9 MCP handlers plus `mcpServer.js`'s
registration blocks — not asserted from the ADR's own design intent.

**Already-shipped, unmodified by this ADR:**
- `delegateReplayHandler.js` — one call `observabilityService.replay(job_id)`, an if/else building
  presentation text (sanctioned, `ADR-0007` names this explicitly as "presentation formatting ...
  not a decision about replay data"), the response envelope. Nothing else.
- `delegateMetricsHandler.js` — one call `observabilityService.getMetrics()`, the envelope.
  Nothing else.
- `delegateSnapshotHandler.js` — one call `observabilityService.getSnapshot()`, the envelope.
  Nothing else.
- `delegateModelsHandler.js` — makes no service call at all by design (reflects a static,
  config-derived constant); its only "decision" is a null-coalescing display fallback, which is
  formatting, not business logic.

**Planned for Stage 1b, verified against the ADR's current (fixed) text:**
- `delegateStatusHandler.js` — post-refactor: one call `delegationService.getJob(job_id)`
  (already view-shaped), an existence branch translating an already-decided
  `JobView | undefined` into MCP's error envelope (sanctioned protocol-specific error shaping),
  the response envelope. No import of `src/models/job.js` remains.
- `delegateHistoryHandler.js` — post-refactor: one call
  `delegationService.listJobs({status, limit})` (already filtered, paginated, and summarized
  internally — the filter/pagination logic that lived in this handler today moves into the
  service, per §4.1/§4.2, resolving the gap an earlier draft left only implicit in a type
  signature), then per-job text formatting (sanctioned), the envelope.
- `delegateCancelHandler.js` — post-refactor: `delegationService.getJob(job_id)` (existence
  check) → `delegationService.cancelJob(job_id)` → `delegationService.getJob(job_id)` again (to
  report post-cancellation state) → the envelope. Three calls, zero decisions between them — pure
  orchestration of already-decided facts, not business logic (see §10.3 for why this is not
  "duplicate orchestration").
- `delegateSubmitHandler.js` — post-refactor: `delegationService.submit(input, "delegate_submit")`
  → `delegationService.getJob(jobId)` to echo status → the envelope. A hardcoded
  `{success: true, ...}` literal, not a computed value.
- `delegateTaskHandler.js` (the one documented exception) — post-refactor:
  `delegationService.submit(input, "delegate_task")`, then the exception: a direct
  `jobManager.waitForCompletion(jobId)` call and `jobManager.bus` passed to
  `forwardJobProgressToMcp()`. Branches on `job.status === "failed"/"cancelled"` map already-decided
  `JobManager` outcomes to MCP error shapes (sanctioned); `if (!parsed)` is a data-shape fallback,
  not policy. The exception is scoped to exactly `waitForCompletion`/`bus` — nothing more — and is
  justified because both are unique to `delegate_task`'s frozen synchronous contract.

**`mcpServer.js`'s 9 `registerTool` blocks** — contain only `title`/`description`/`inputSchema`/
`annotations` plus a handler-factory construction call. Zero per-request logic in any of the nine.

### 10.2 All business logic resides only inside services

Enumerated exhaustively, not merely asserted by absence in §10.1:

- **`JobManager`** — the status state machine (`_transition`, `PHASE_INFO`), `TERMINAL_STATUSES`
  immutability (`cancelJob`'s branching), concurrency/queueing (`_drain`/`pending`/`running`/
  `maxConcurrent`), retry/eviction (`_trimHistory`, oldest-terminal-first, `maxHistory`-bounded),
  and event publication (`_publishTransitionEvent`) all live here, unchanged by this ADR.
- **`DelegationService`** (new) — input validation (`DelegateTaskInputSchema.parse`, moved inside
  `submit()`) and view/summary shaping + list filtering/pagination (moved inside `getJob`/
  `listJobs`) are the *only* logic this ADR adds anywhere, and both are service-layer, not
  transport-layer, by design.
- **`ObservabilityService`'s substrate** — aggregation (`MetricsCollector`'s per-event-type
  dispatch), chronological ordering and bounded retention (`TimelineStore`), tiered fallback
  (`ReplayEngine`: runtime > durable > workspace > unavailable), and point-in-time assembly
  (`SnapshotBuilder`) all live here, entirely untouched by this ADR.
- **Security-sensitive redaction** — the existing rationale for never copying raw environment/
  context into `job.metadata` (it would leak secrets through `delegate_status`'s response) is
  preserved verbatim inside the new `submit()` implementation, not reimplemented per-transport.

### 10.3 No duplicate orchestration exists

Verified directly against `src/services/jobManager.js`'s full source (read in this session): every
scheduling/transition primitive (`_drain()`, `_run()`, `_transition()`, `_publishTransitionEvent()`,
`_settle()`, `_trimHistory()`, the `waiters` map backing `waitForCompletion()`) is **private**
(underscore-prefixed, called only from within `JobManager` itself) and appears in exactly one
place in the codebase. `DelegationService`'s four methods each make **exactly one** call into
`JobManager`'s public surface (`submit`/`getJob`/`listJobs`/`cancelJob`) and add no scheduling,
transition, retry, or eviction logic of their own — confirmed by the Single Mutation Path Rule's
own definition (§6, `ADR-0003` row) and by the absence of any new private method on
`DelegationService` beyond the two additive, non-duplicating concerns named in §10.2 (input
validation, view-shaping). No handler reimplements any part of this machinery either — the
three-call sequence in `delegateCancelHandler.js` (§10.1) is orchestration of *already-computed*
facts (three separate reads/one write), not a parallel reimplementation of `cancelJob`'s own
queued-vs-starting/running branching, which remains solely inside `JobManager`.

### 10.4 No business logic remains inside MCP handlers

Direct consequence of §10.1 combined with the two gaps found and fixed during this review's own
verification process: the first ADR draft would have left `delegate_history`'s filter/pagination
logic handler-resident (a real violation of this claim, silently present until caught), and left
ambiguous whether `getJob`/`listJobs` returned raw `Job` (requiring the handler to still call
`toJobView`/`summarizeJob` itself — another real violation) or the already-shaped view/summary.
Both are now resolved as explicit decisions in the ADR text (§4.1, commit `4bf2f4e`): post-refactor,
no write-side handler imports `src/models/job.js` at all. This claim is a **design target**
verified against the current (fixed) ADR text — Stage 1a/1b is what makes it empirically true of
shipped code. A concrete, CI-gateable structural test is recommended for Stage 1b's own
implementation plan (not yet written): a test asserting each handler file's
`import ... from "../services/..."` list is restricted to `delegationService.js`/`job.js`
(five handlers) or additionally `jobManager.js`/`mcpProgressAdapter.js` (the one documented
`delegateTaskHandler.js` exception only) — the direct write-side analog of how
`docs/OBSERVABILITY_FREEZE.md` already structurally verifies the Passive Observation Rule
(`Object.keys(observability)` contains no mutator, verified by a real test, not by convention).

---

## 11. Open Questions

Every architectural assumption below is stated as a decision somewhere in ADR-0010 or this
package, but each still represents a judgment call that has not been given your explicit sign-off.
None blocks the *design* from being internally consistent; each could change the design if you
decide differently.

1. **`FOUNDATION_FREEZE.md`'s frozen sentence — literal reading.** The freeze document names a
   specific implementation (`services/delegationService.js`'s `submitDelegation()`) as "the single
   path into `JobManager`," not an abstract property. ADR-0010 reads this as naming *the property*
   (one single path exists) rather than *this specific implementation*, and treats updating the
   sentence to name `DelegationService` instead as a permitted, ADR-documented change rather than a
   breaking one. Do you agree with this reading, or should the freeze document's own language be
   tightened first to explicitly distinguish "the property" from "the implementation" before any
   future ADR relies on this interpretation again?
2. **`ConsumerRegistry`'s restart-persistence gap.** Its state is in-memory-only — a future REST/
   Dashboard backend process's `registerConsumer()` handle would not survive that process's own
   restart, meaning "total consumers ever registered" style statistics would undercount across
   restarts. Is this acceptable for the intended ops/admin use case, or does `ConsumerRegistry` need
   a caller-supplied stable external consumer id before Stage 2/3 relies on it?
3. **`getTimeline()`'s future REST shape.** Deferred entirely to the REST API Foundation ADR: should
   filtered timeline access become its own endpoint (`GET /jobs/:id/timeline?type=&since=`) or a
   query-parameter mode on a replay-style endpoint (`GET /jobs/:id/replay?since=...`)? Not decided
   here by design — is deferring this specific decision (rather than deciding it now, while the
   context is fresh) the right call?
4. **`job.metadata.tool`/`payload.tool` generic renaming — no trigger criteria defined.** The rename
   is deferred indefinitely, contingent on "a concrete second caller pattern" needing a non-tool-
   shaped label. No specific trigger is defined (e.g., "the first REST endpoint that calls `submit()`
   without a natural tool name"). Should a concrete trigger condition be written down now, or is
   open-ended deferral acceptable?
5. **Versioning classification: `patch`, not `minor`, for Stage 1b.** `FOUNDATION_FREEZE.md`'s
   policy text supports this reading (no new tool, no schema change), but the three precedent ADRs
   (`0007`/`0008`/`0009`) were each classified `minor` because each added a net-new tool — this is
   the first internal-only refactor to be classified under this policy at all. Do you want to
   explicitly ratify "internal refactor with zero external contract change = patch" as a standing
   precedent for future similar work, or reserve judgment until Stage 1b is actually implemented?
6. **Input-validation double-execution for MCP callers.** `DelegationService.submit()` will call
   `DelegateTaskInputSchema.parse(input)` even though the MCP SDK has already validated the same
   input against the same schema moments earlier, at tool-registration time. This is harmless
   overhead (zod validation is cheap) but is a deliberate design choice, not a necessity for MCP
   specifically — it exists purely so a future non-MCP caller gets validation for free. Is doubled
   validation for every existing MCP call an acceptable permanent cost for that future benefit?
7. **Single unified `DelegationService` vs. eventually splitting responsibilities.** ADR-0010
   commits to one service wrapping all four write operations. Is this the intended long-term shape,
   or only the minimal starting shape — should a future split (e.g., a separate query-only service
   from a mutation-only service) be anticipated now in the naming/structure, or left entirely to
   whenever (if ever) the surface grows enough to justify it?
8. **The `ADR-0003` corrective note — should it actually be made, and by whom?** ADR-0010
   recommends adding a one-line note at `ADR-0003`'s two mentions of the never-implemented
   `getJobSummary()` method, but does not make this edit itself (confirmed: no ADR-0010 commit
   touches `ADR-0003`). This project's established practice treats frozen/historical ADRs as
   permanent record, never retroactively edited for content changes — does a purely corrective,
   non-decisional note fall outside that norm and warrant an edit, or should it instead be tracked
   as a standalone documentation task (mirroring how `task_026caee1`/`task_d7317142` are tracked as
   backlog chips) rather than touching `ADR-0003`'s file at all?
9. **Naming: does `DelegationService` still communicate the right role?** The name is inherited
   from the existing `delegationService.js` module (a deliberate choice to avoid introducing an
   unrelated new name), but its role has expanded from "a helper function for submission" to "the
   formal write-side peer to `ObservabilityService`." Does the name still read clearly to a future
   engineer, or would something like `JobAccessService`/`ExecutionService` better signal its
   now-formalized, symmetric role alongside `ObservabilityService`?
10. **Should Stage 1a's test scope include `mcpProgressAdapter.js`'s behavior?** `delegateTaskHandler.js`'s
    documented exception touches `jobManager.bus`, which `mcpProgressAdapter.js`'s
    `forwardJobProgressToMcp()` consumes for MCP progress notifications. Stage 1b does not modify
    `mcpProgressAdapter.js` at all, so strictly it need not be in Stage 1a's characterization scope
    — but should Stage 1a pin its behavior anyway, purely as an extra safety margin around the one
    handler that keeps a direct `JobManager` dependency?
11. **`delegateCancelHandler.js`'s three-call sequence — refine now or leave as-is?** Post-refactor,
    the handler still calls `delegationService.getJob()` → `delegationService.cancelJob()` →
    `delegationService.getJob()` again, rather than `DelegationService.cancelJob()` returning the
    post-cancellation view directly in one call. Not required for Stage 1b's byte-identical goal
    (§10.1/§8 R8) — is collapsing this into a single service call worth doing now, or is it a minor
    future refinement better left for whenever `DelegationService`'s contract is revisited for
    another reason?
12. **No authorization/ownership scoping on the write surface — acceptable today, but for how
    long?** `DelegationService.getJob(jobId)`/`cancelJob(jobId)` take a bare job id with no
    caller/session scoping of any kind — confirmed nowhere in `JobManager`, `DelegationService`,
    or any handler today. §2's Responsibilities Matrix defers all auth/session handling entirely
    to each transport ("Whatever the MCP SDK's transport layer does" for MCP; "Its own (e.g. API
    key, OAuth)" for REST) — meaning nothing prevents any authenticated REST/Dashboard caller from
    inspecting or cancelling *any* job by id, regardless of who submitted it, once Stage 2/3 exist.
    This is a non-issue for today's single trusted MCP stdio client, where there is exactly one
    caller and no multi-tenant concern. Does this ADR need to say anything now about a future
    caller-scoped ownership model for `DelegationService`, or is it correctly out of scope until
    Stage 2 (REST API Foundation) actually introduces a multi-consumer, potentially multi-tenant
    surface where "who may act on which job" becomes a real question for the first time?

---

## Confirmation

This package proposes no code changes and modifies no production file — confirmed by
`git status --short`/`git diff --stat` showing only this file itself modified while being written
(committed immediately after, restoring a clean tree), and by `git show --stat` across every other
ADR-0010-related commit showing only documentation files touched. It exists solely to support your
approval decision. **Waiting for your explicit approval before pushing `ADR-0010` to `origin`,
writing an implementation plan, or beginning Stage 1a.**
