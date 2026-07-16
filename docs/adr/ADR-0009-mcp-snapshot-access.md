# ADR-0009: MCP Snapshot Access

## Status

**Frozen — approved for implementation.** Rank 1 in `CAPABILITY_ROADMAP_REBASELINE.md` (which
supersedes `CAPABILITY_ROADMAP.md`'s ranking for all remaining candidates). Reuses `ADR-0007`'s
six-principle Platform Transport-Agnosticism Verification in full, by reference — do not
re-derive, exactly as `ADR-0008` did.

## Decision

New tool `delegate_snapshot`, no input, wrapping `ObservabilityService.getSnapshot()` verbatim.
Same pattern as `delegate_replay`/`delegate_metrics`: new handler file
(`src/handlers/delegateSnapshotHandler.js`), one `registerTool` call reusing the existing
`observabilityService` binding, no changes to `ObservabilityService`/`SnapshotBuilder`/
`MetricsCollector`.

```js
export function createDelegateSnapshotHandler({ observabilityService }) {
  return async function delegateSnapshotHandler() {
    const snapshot = observabilityService.getSnapshot();
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot };
  };
}
```

Model precedent: `delegate_metrics` (no-input tool, identical two-line handler body,
`annotations: {readOnlyHint: true, ...}`, `inputSchema: {}`) — this handler is the same shape,
one method-name substitution (`getMetrics()` → `getSnapshot()`).

## Platform Transport-Agnosticism Verification

Identical to `ADR-0007`'s six principles, unchanged reasoning, exactly as `ADR-0008` reused
them — `getSnapshot()` is already transport-agnostic (a plain, frozen object returned by
`SnapshotBuilder`, deep-cloned off `MetricsCollector`'s live state before freezing, `ADR-0003`),
the handler is the same two-line wrapper `delegate_metrics` already proved, and no MCP type
touches `src/services/`. Not re-derived here per `ADR-0008`'s own reuse mandate, which this ADR
continues.

## Explicitly out of scope

- **`ConsumerRegistry` exposure** (`registerConsumer`/`touchConsumer`/`unregisterConsumer`/
  `listConsumers`/`getConsumerHealth`/`getConsumerStatistics`) — per
  `CAPABILITY_ROADMAP_REBASELINE.md`'s finding #3, this is a stateful register/heartbeat/
  unregister lease API meant for a long-lived process (a future Dashboard or REST backend) to
  track its own registration over time. An MCP tool call is a one-shot request/response from an
  ephemeral AI session — the wrong shape of consumer for register-then-heartbeat-then-unregister
  semantics. This is not a low-priority deferral; it is a likely-permanent non-candidate for MCP
  exposure specifically. `ConsumerRegistry` remains valuable as future Dashboard/REST-internal
  infrastructure, just not through this server's tool surface.
- **`getTimeline()`** — rejected as its own tool; see `ADR-0007` Alternatives
  (`delegate_replay`'s `runtime` tier already returns this data for any currently-retained job,
  and additionally degrades gracefully where `getTimeline()` alone cannot). `delegate_timeline`
  — rejected, unchanged, reconfirmed by `CAPABILITY_ROADMAP_REBASELINE.md`.
- **`delegate_search`** — deferred, see `CAPABILITY_ROADMAP_REBASELINE.md` (no concrete need at
  current retention scale, no index designed).

## Last tool in this family

After `delegate_snapshot` ships, every `ObservabilityService` read method with a well-shaped MCP
consumer has one: `replay()` → `delegate_replay` (`ADR-0007`), `getMetrics()` →
`delegate_metrics` (`ADR-0008`), `getSnapshot()` → `delegate_snapshot` (this ADR). `getTimeline()`
is a strict subset of what `delegate_replay`'s runtime tier already returns, and
`ConsumerRegistry` is out of scope for the reason above — there is no fourth point tool waiting
in this family. The next wave that touches `ObservabilityService`'s external surface is a
unified **Access Layer Architecture** ADR (`ADR-0010`, not yet written) — a REST API Foundation
design covering framework choice, hosting/lifecycle model, auth model, and versioning policy —
per `CAPABILITY_ROADMAP_REBASELINE.md`'s "Recommended next sprint" and "Expected roadmap after
that sprint", not another point tool wrapping a single method.

## Compatibility impact

One net-new tool — **minor** per `FOUNDATION_FREEZE.md`'s versioning policy. Zero change to any
existing tool or to `ObservabilityService`.

## Testing plan

Same convention as `delegate_replay`/`delegate_metrics` — real `ObservabilityService` against a
real bus, no per-handler unit test file. `npm test` must stay green; Inspector must show 9
tools, other 8 unchanged.
