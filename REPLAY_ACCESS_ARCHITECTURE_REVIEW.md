# Architecture Review — MCP Replay/Timeline Access

**Scope:** the #1-ranked capability from `CAPABILITY_ROADMAP.md` — exposing
`ObservabilityService.replay(jobId)` (and, by direct consequence, `getTimeline()`'s data) to
this server's actual MCP-client users via a new tool. Covers architecture readiness, dependency
verification, reuse analysis, and no-duplication analysis — the four steps requested before
drafting the ADR.

## Architecture readiness

`docs/adr/ADR-0003-observability-architecture.md`'s Extension Rules table (`ADR-0003:280-294`)
pre-designed this exact wave under "AI Consumers": *"A future MCP tool (e.g. `delegate_metrics`)
whose handler calls `ObservabilityService` internally, same pattern `delegate_status` already
uses for `JobManager` | Deferred — no MCP schema change in this ADR."* This proposal **is** that
named, deferred wave — not a new architectural idea.

`docs/FOUNDATION_FREEZE.md`'s versioning policy classifies the change precisely: *"minor: new
tool, new optional field, new config option with a safe default."* Adding one MCP tool is
explicitly pre-classified as safe, backward-compatible, and not requiring re-litigation of any
frozen guarantee.

Six existing tools in `src/server/mcpServer.js` are a direct, copyable template. Read in full
for this review: `src/handlers/delegateStatusHandler.js` and
`src/handlers/delegateHistoryHandler.js` — both follow the identical shape:

```js
export function createDelegateStatusHandler({ jobManager }) {
  return async function delegateStatusHandler({ job_id }) {
    const job = jobManager.getJob(job_id);
    if (!job) return { isError: true, content: [{ type: "text", text: `No job found with id ${job_id}` }] };
    // ... build a view, return { content: [{type:"text", text: summary}], structuredContent: view }
  };
}
```

The new handler follows this exact convention: a factory taking its one dependency
(`observabilityService`, already constructed and in scope inside `createMcpServer()` at the
point new `registerTool` calls would go — verified by reading `mcpServer.js` directly, no new
plumbing needed), returning an async handler that produces `{content, structuredContent}`.

## Dependency verification

- **No new npm dependency.** `ObservabilityService.replay()` is pure JS/`node:fs`, already
  shipped and tested (`v1.9.0`, `v2.4.0`).
- **No unbuilt prerequisite.** Depends only on `ADR-0003` (Phase 1+2, shipped) and `ADR-0006`
  (shipped). Nothing else on `CAPABILITY_ROADMAP.md`'s list needs to exist first.
- **Does not require `CLAUDE_DELEGATE_EVENT_HISTORY=file` to be useful.** `replay(jobId)`
  already degrades gracefully without it — `runtime` tier while `TimelineStore` retains a job,
  `workspace` (coarse) fallback otherwise. The new tool is useful **out of the box**, with zero
  operator configuration, and becomes richer (full-fidelity, restart-survivable) once the
  operator opts into durable event history. This is a real, verifiable property, not an
  assumption: `replayEngine.js`'s `workspace` tier only requires `config` (always present) —
  `eventHistoryStore` being `undefined` (the default) simply skips that branch.
- **Never throws on a bad `job_id`.** Traced the full call chain: `TimelineStore.has(jobId)` is
  a plain `Map.has()` call (never throws on any input); the `durable` tier's
  `eventHistoryStore.has(jobId)` is wrapped in `replayEngine.js`'s own try/catch (falls through
  on an invalid id); `replayFromWorkspace(jobId, config)` explicitly checks `isValidJobId(jobId)`
  and returns `null` (not a throw) for an invalid one (`replayEngine.js`). The worst case for a
  garbage `job_id` is `{source: "unavailable", timeline: []}` — never an exception. The new
  handler needs no defensive validation of its own; `replay()` already guarantees safety.

## Reuse analysis

| Component | Reused as-is? | Notes |
|---|---|---|
| `ObservabilityService.replay(jobId)` | Yes, verbatim | The entire data-fetching logic — zero new code |
| `JOB_ID_FIELD` (zod schema, `mcpServer.js`) | Yes, verbatim | Already shared by `delegate_status`/`delegate_cancel`; the new tool's `job_id` input is identical |
| `{content, structuredContent}` response shape | Yes, same convention | Matches `delegateStatusHandler.js`/`delegateHistoryHandler.js` exactly |
| `annotations: {readOnlyHint: true, ...}` | Yes, same convention | `replay()` is provably read-only (Passive Observation Rule, `ADR-0003`) — same annotation `delegate_status`/`delegate_history` already declare |
| `createMcpServer()`'s local `observabilityService` binding | Yes, already in scope | No new construction — the exact instance Task 5 (prior sprint) made reachable for `close()` is reused here for a second purpose |

**Nothing about `FileJobStore`, `EventHistoryStore`, `TimelineStore`, `MetricsCollector`,
`SnapshotBuilder`, or `ConsumerRegistry` needs to change.** This wave touches exactly two new
things: one handler file, one `registerTool` call.

## No-duplication analysis

- **No duplicated replay logic.** The handler is a thin pass-through — it calls
  `observabilityService.replay(job_id)` and formats the result; it contains no independent
  replay/history-reconstruction code of its own.
- **No duplicated MCP schema.** One net-new tool; no existing tool's input/output shape changes.
- **No duplicated existence-check.** `delegate_status` calls `jobManager.getJob(job_id)` and
  errors (`isError: true`) if the job was never tracked by *this* `JobManager` instance at all —
  a different question from "is any history available for this id." The new tool deliberately
  does **not** re-implement that check: `source: "unavailable"` (from `replay()` itself) is
  treated as a normal, informative response, not a hard error, avoiding a second,
  slightly-different "does this job exist" implementation living in two handlers.
- **No duplicated filtering logic.** `getTimeline(jobId, {type, since})` supports filtering;
  `replay()` does not. This wave deliberately does **not** re-implement `getTimeline()`'s filter
  predicate on top of `replay()`'s output — see `docs/adr/ADR-0007-mcp-replay-access.md`'s
  Explicitly-out-of-scope section for why, and what a future addition would look like if a real
  need for it appears.

## Conclusion

Every readiness signal points the same direction: this is a same-shape, low-risk, fully-reusable
extension of an already-frozen, already-tested API, explicitly pre-authorized by `ADR-0003` and
explicitly classified as a minor, safe change by `FOUNDATION_FREEZE.md`. See
`docs/adr/ADR-0007-mcp-replay-access.md` for the formal decision and
`docs/superpowers/plans/mcp-replay-access.md` for the implementation plan.
