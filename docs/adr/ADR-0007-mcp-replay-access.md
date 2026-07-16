# ADR-0007: MCP Replay Access

## Status

**Frozen — approved in principle, implementation gated on the Platform Transport-Agnosticism
Verification below.** Written per `CAPABILITY_ROADMAP.md`'s ranking (Rank 1 of 9 evaluated
candidates) and `REPLAY_ACCESS_ARCHITECTURE_REVIEW.md`'s architecture readiness / dependency
verification / reuse analysis / no-duplication analysis — all performed before this Decision
was drafted, per the same process `ADR-0005` and `ADR-0006` used. A second verification round
(below) checks the Decision as written against six platform-level principles — treating
`delegate_replay` as the first of several transports this same service layer must serve, not a
one-off — before implementation begins.

## Platform Transport-Agnosticism Verification (performed against the Decision below, before implementation)

The user's framing for this round: `delegate_replay` is **the first public access layer for the
Observability platform**, not a one-off MCP tool — its design must not create anything a future
Dashboard, REST API, Web UI, Analytics feature, or Plugin API would have to route around, undo,
or duplicate. Six principles, checked against the actual Decision text above (not a redesign —
this section audits what's already written).

### 1. Is `delegate_replay` a thin transport adapter only — no replay/filtering/persistence/business logic?

**Yes.** The handler (Decision, lines 47-57) does exactly three things: destructure
`observabilityService.replay(job_id)`'s return value, build a human-readable string from fields
that value already carries (`source`, `timeline[].timestamp`/`.type`/`.synthetic`), and return
both. There is no branch that changes *what* is fetched, no filter applied to `timeline` before
returning it, no write of any kind. The text-building `if/else` is presentation formatting for
MCP's `content[0].text` channel — not a decision about replay data, exactly mirroring
`delegateStatusHandler.js`'s own `summary` string (built the identical way, from `toJobView`'s
already-fetched fields, never questioned as "business logic" in six prior tools).

### 2. Does all replay behavior continue to live inside `ReplayEngine`/`ObservabilityService`? Does the tool only validate input, invoke, and return?

**Yes.** Zero lines change in `src/services/replayEngine.js`, `observabilityService.js`,
`timelineStore.js`, or `eventHistoryStore.js` (Goals, line 31-33; Compatibility impact, line
140-141). "Validate input" is not hand-rolled in the handler — it's already satisfied
structurally by reusing `JOB_ID_FIELD` (Decision, line 71), the same zod schema
`delegate_status`/`delegate_cancel` already use, enforced by the MCP SDK *before* the handler
runs at all. By the time `delegateReplayHandler` calls `replay(job_id)`, `job_id` is a plain
validated string — the handler adds no validation code of its own because none is needed beyond
what the existing schema-reuse already provides.

### 3. Is the contract designed so the same service layer is reusable unchanged by Dashboard/REST API/Web UI/Analytics/Plugin API?

**Yes — and this property predates this ADR.** `ADR-0003` built `ObservabilityService` as a
transport-agnostic façade specifically so *"a future Dashboard (in any form) calls
`getSnapshot()`/`getTimeline()`/`replay()` and renders the result"* (`ADR-0003:274-278`) — this
ADR does not need to invent that property, only refrain from breaking it. Checked concretely: a
hypothetical `GET /jobs/:id/replay` REST endpoint would call `observabilityService.replay(job_id)`
directly and serialize `{source, timeline}` as its JSON body — it would not call
`delegateReplayHandler` at all, would not need `JOB_ID_FIELD` (its own path param does that job),
and would not need the human-readable `text` string (HTTP JSON has no equivalent channel). None
of `delegateReplayHandler`'s three concerns (MCP schema, MCP response envelope, human-readable
text) are things a REST/Dashboard/Plugin consumer would ever import or depend on — they'd all
route through `observabilityService.replay()` directly, exactly as designed two sprints ago.

### 4. Does the design avoid introducing MCP-specific types into the replay subsystem?

**Yes, confirmed by import trace.** `JOB_ID_FIELD` (a `zod` schema) is defined and used only in
`src/server/mcpServer.js` — never imported by `replayEngine.js`, `observabilityService.js`, or
any other replay-subsystem file. The MCP SDK validates the tool call's input against that schema
*before* `delegateReplayHandler` is invoked; the handler itself receives and passes along a
plain `string`, and `observabilityService.replay()`'s signature (`(jobId: string) => {source,
timeline}`) is untouched — it has never known about zod, MCP, or any transport concept, and
this ADR keeps it that way.

### 5. Can pagination/filtering/search be added later as extensible parameters, without a breaking change?

**Yes — structurally, not by accident.** `inputSchema: { job_id: JOB_ID_FIELD }` (Decision, line
71) is a zod *object* shape. Adding new keys to it later (e.g. `type`, `since`, `limit`,
`cursor`) is non-breaking by construction: an existing caller that omits a new optional field is
unaffected, and `docs/FOUNDATION_FREEZE.md`'s own versioning policy already classifies *"new
optional field"* as **minor** (not the kind of change requiring reconsideration of any frozen
guarantee). This ADR deliberately ships with none of those fields today (Explicitly out of
scope, line 98-100) — per this codebase's own consistent discipline against unrequested
parameters (`ADR-0003`'s `ConsumerRegistry`: *"not built speculatively... a scoped addition at
that time, not now"*) — but the schema shape itself imposes no future migration cost when a
real need for one appears.

### 6. Does implementing `delegate_replay` reduce — not increase — future work for Dashboard/REST?

**Reduces risk and provides a validated precedent; does not literally write code those
transports could reuse (an honest distinction, not an overclaim).** Concretely:
- It does not increase future work: nothing about this ADR couples any future transport to
  `delegateReplayHandler.js`, `JOB_ID_FIELD`, or MCP's `{content, structuredContent}` shape — a
  future REST endpoint's handler would be written against `observabilityService.replay()`
  directly, untouched by whatever exists in `src/handlers/` or `src/server/mcpServer.js`.
  There is nothing here to "undo."
  - It reduces future risk: this is the *first real, working proof* that
  `ObservabilityService`'s API is genuinely callable by an external-facing transport without
  modification — a claim `ADR-0003` made two years of ADRs ago but that, until this wave, no
  concrete consumer had ever tested. A future Dashboard/REST implementer inherits a working
  example (however transport-specific its edges are) rather than a purely theoretical claim.
  - It does *not* reduce the literal amount of HTTP-routing/UI/auth code a future Dashboard/REST
  wave will have to write — that work is transport-specific and orthogonal to this ADR by
  design (per Q3 above). Framing this ADR as "shrinking" that future work would overclaim; the
  honest claim is *de-risking*, not code-sharing beyond the service layer both already share.

### Conclusion

All six principles hold against the Decision as already written — **no redesign was required**,
because the property being verified (`ObservabilityService` as a transport-agnostic façade) was
established by `ADR-0003` before this ADR existed; this ADR's obligation was only to not
undermine it, and it doesn't. No architecture change affecting future transports was discovered
— the stop-and-ask trigger does not fire. **Proceed with the existing implementation plan
(`docs/superpowers/plans/mcp-replay-access.md`) exactly as written.**

## Context

`ADR-0003` (Observability, v1.9.0) and `ADR-0006` (Persistent Event History, v2.4.0) together
built a fully tested, frozen `ObservabilityService.replay(jobId)` method that reconstructs a
job's event history — full fidelity while retained in memory, full fidelity from a durable log
if `CLAUDE_DELEGATE_EVENT_HISTORY=file` is enabled, or a coarse summary as a last resort. **No
MCP tool, script, or any code outside `ObservabilityService`'s own tests calls this method.**
Two sprints of work are entirely unreachable by this server's actual users. `ADR-0003` itself
named this exact gap and deferred it: *"AI Consumers ... A future MCP tool ... whose handler
calls `ObservabilityService` internally, same pattern `delegate_status` already uses for
`JobManager` ... Deferred — no MCP schema change in this ADR"* (`ADR-0003:294`). This ADR is
that named successor.

## Goals

- Any MCP client (Claude Desktop, or any other host) can ask "what happened in job X" and get
  back the richest available history — full-fidelity where possible, coarse where not, with the
  source explicitly labeled so a caller can tell which it received.
- Zero MCP schema change to any *existing* tool. One net-new, additive tool — a **minor** change
  per `docs/FOUNDATION_FREEZE.md`'s own versioning policy.
- Zero new code in `ObservabilityService`, `ReplayEngine`, `TimelineStore`, `EventHistoryStore`,
  `MetricsCollector`, `SnapshotBuilder`, or `ConsumerRegistry` — this wave is a thin MCP-facing
  wrapper only.
- No new production dependency.
- Useful with zero operator configuration (works against the coarse `workspace` fallback even
  when `CLAUDE_DELEGATE_EVENT_HISTORY` is unset), richer once that flag is enabled.

## Decision

New tool `delegate_replay`, registered in `src/server/mcpServer.js` alongside the existing six,
and a new handler file `src/handlers/delegateReplayHandler.js` mirroring
`delegateStatusHandler.js`'s exact shape:

```js
// src/handlers/delegateReplayHandler.js
/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateReplayHandler({ observabilityService }) {
  return async function delegateReplayHandler({ job_id }) {
    const { source, timeline } = observabilityService.replay(job_id);
    const text =
      timeline.length === 0
        ? `No replay data available for job ${job_id} (source: ${source}).`
        : `Replay for ${job_id} (source: ${source}, ${timeline.length} event${timeline.length === 1 ? "" : "s"}):\n` +
          timeline.map((e) => `  [${e.timestamp}] ${e.type}${e.synthetic ? " (synthetic)" : ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { source, timeline } };
  };
}
```

```js
// src/server/mcpServer.js — additive registration alongside the existing six
server.registerTool(
  "delegate_replay",
  {
    title: "Replay a delegated job's event history",
    description:
      "Reconstructs a delegate_task/delegate_submit job's event history for viewing -- read-only, " +
      "never re-executes anything. Returns the richest available source: 'runtime' (live, in-memory, " +
      "full fidelity), 'durable' (on-disk full fidelity, only if CLAUDE_DELEGATE_EVENT_HISTORY=file " +
      "was enabled), 'workspace' (coarse lifecycle summary), or 'unavailable'.",
    inputSchema: { job_id: JOB_ID_FIELD },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  createDelegateReplayHandler({ observabilityService })
);
```

**No existence check duplicated.** Unlike `delegate_status` (which errors when `JobManager` has
never heard of a `job_id`), `delegate_replay` treats `source: "unavailable"` as a normal,
informative response, not an error — see `REPLAY_ACCESS_ARCHITECTURE_REVIEW.md`'s No-duplication
analysis for why re-implementing `JobManager.getJob()`'s existence check here would itself be a
form of duplication this ADR avoids.

**No filtering in this wave.** `getTimeline(jobId, {type, since})` supports filtering;
`delegate_replay` does not expose `type`/`since` parameters. Adding them now, before any concrete
caller has asked for filtered replay, would be exactly the kind of speculative parameter this
codebase's own engineering culture has consistently avoided (`ADR-0003`'s `ConsumerRegistry`
section: *"not built speculatively ... a scoped addition at that time, not now"*). See
Explicitly out of scope.

**Response shape**: matches `delegate_status`/`delegate_history`'s existing convention exactly
— human-readable `content[0].text` plus machine-readable `structuredContent`
(`{source, timeline}`, the same shape `ObservabilityService.replay()` already returns, passed
through verbatim — no reshaping, no new type).

## Explicitly out of scope this wave

- `type`/`since` filtering on `delegate_replay` — not requested by any concrete consumer yet;
  add as an optional input field (additive, still **minor** per `FOUNDATION_FREEZE.md`) if a
  real need appears.
- A separate `delegate_timeline` tool — `replay()`'s `runtime` tier already returns exactly
  `TimelineStore.getTimeline()`'s data when a job is still retained (`replayEngine.js`); a
  second tool exposing the same data via a different method would be the kind of duplication
  this ADR's own no-duplication analysis rules out. Revisit only if a concrete need for
  `getTimeline()`'s filtering (which `replay()` doesn't offer) materializes.
- `delegate_metrics` / any `getMetrics()`/`getSnapshot()` exposure — Rank 2 in
  `CAPABILITY_ROADMAP.md`, a legitimate future wave, not bundled here to keep this ADR's scope
  to exactly the #1-ranked capability.
- Any Dashboard, REST API, WebSocket streaming, Search, Analytics, Live Monitoring, or Plugin
  API work — all ranked lower in `CAPABILITY_ROADMAP.md` and explicitly deferred.

## Testing plan

**Note on this codebase's real handler-testing convention** (verified directly — there are no
per-handler unit test files like `delegateStatusHandler.test.js`; none of the six existing
handlers has one): handlers are tested by constructing them directly (imported, not via a full
MCP server) and calling them as plain functions against a real `JobManager`/`ObservabilityService`,
in `tests/asyncExecution.integration.test.js` (which already imports and wires
`createDelegateStatusHandler`/`createDelegateHistoryHandler`/etc. this exact way,
`tests/asyncExecution.integration.test.js:10-14,68-72`). The new handler follows the identical
pattern, most naturally as an addition to that same file or a new one following its precedent —
implementer's call, note which in the report.

Unit/integration (via the pattern above): a fake `observabilityService` stub returning each of
the four `source` values in turn, asserting `structuredContent` matches verbatim and the
human-readable text mentions the source and event count; an empty-timeline case renders the "no
replay data available" message, not an empty list dump; a real end-to-end case — a real
`JobManager` runs a job to completion, `createDelegateReplayHandler({observabilityService})`
called directly returns `source: "runtime"` with the job's actual event sequence. Separately, in
`tests/mcpServer.test.js`: a real `createMcpServer()` instance's registered tool list includes
`delegate_replay`. Inspector: `npx @modelcontextprotocol/inspector --cli node server.js --method
tools/list` must show exactly 7 tools (the existing 6 plus `delegate_replay`) with no change to
any of the existing 6 tools' schemas — a diff against the pre-change snapshot, not just a count
check.

## Compatibility impact

None on `docs/FOUNDATION_FREEZE.md`'s existing guarantees. One net-new MCP tool — **minor** per
that document's own versioning policy. Zero change to any existing tool's input schema, output
shape, or behavior. Zero change to `ObservabilityService`, `ReplayEngine`, or any component
`ADR-0003`/`ADR-0006` shipped.

## Alternatives considered

- **Add a `timeline`/`replay` field to `delegate_status`'s existing response** instead of a new
  tool: rejected — `replay()` can return an unbounded-within-retention number of events; folding
  it into `delegate_status`'s response would inflate *every* status-check call's payload size,
  including the overwhelming majority of callers who only want current status, not full history.
  A dedicated tool called only when explicitly needed is more precise and doesn't bloat the
  existing hot-path tool.
- **A separate `delegate_timeline` tool wrapping `getTimeline()` directly**: rejected — as noted
  in Decision, `replay()`'s `runtime` tier already returns exactly this data for any
  currently-retained job, and additionally degrades gracefully for evicted/restarted jobs, which
  `getTimeline()` alone cannot do. A second tool exposing a strict subset of what the first
  already provides would be duplication, not a new capability.
- **Building `type`/`since` filtering into this wave**: rejected for now — no concrete consumer
  has asked for it; adding it later is a strictly additive, still-minor change, so there's no
  cost to deferring it and a real (if small) cost to guessing at an unrequested filter shape now.
- **Bundling `delegate_metrics` into this same ADR**: rejected — keeps this ADR's scope to
  exactly the #1-ranked capability from `CAPABILITY_ROADMAP.md`; `delegate_metrics` is a
  legitimate, separately-scoped future wave (Rank 2), not a reason to delay or bloat this one.
