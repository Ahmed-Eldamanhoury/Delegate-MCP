# ADR-0007: MCP Replay Access

## Status

**Proposed — pending user sign-off before implementation.** Written per
`CAPABILITY_ROADMAP.md`'s ranking (Rank 1 of 9 evaluated candidates) and
`REPLAY_ACCESS_ARCHITECTURE_REVIEW.md`'s architecture readiness / dependency verification /
reuse analysis / no-duplication analysis — all performed before this Decision was drafted, per
the same process `ADR-0005` and `ADR-0006` used.

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
