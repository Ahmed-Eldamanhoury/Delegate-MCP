# ADR-0008: MCP Metrics Access

## Status

**Frozen — approved for implementation.** Rank 2 in `CAPABILITY_ROADMAP.md`. Reuses `ADR-0007`'s
verification in full, by reference — do not re-derive.

## Decision

New tool `delegate_metrics`, no input, wrapping `ObservabilityService.getMetrics()` verbatim.
Same pattern as `delegate_replay`: new handler file (`src/handlers/delegateMetricsHandler.js`),
one `registerTool` call reusing the existing `observabilityService` binding, no changes to
`ObservabilityService`/`MetricsCollector`. `getSnapshot()` (adds `activeJobs`) is explicitly
**not** included — out of scope, additive later if needed, mirroring how `delegate_replay`
deferred `type`/`since` filtering.

```js
export function createDelegateMetricsHandler({ observabilityService }) {
  return async function delegateMetricsHandler() {
    const metrics = observabilityService.getMetrics();
    return { content: [{ type: "text", text: JSON.stringify(metrics) }], structuredContent: metrics };
  };
}
```

Model precedent: `delegate_models` (no-input tool, `annotations: {readOnlyHint: true, ...}`,
`inputSchema: {}`).

## Platform Transport-Agnosticism Verification

Identical to `ADR-0007`'s six principles, unchanged reasoning — `getMetrics()` is already
transport-agnostic (plain object return, `ADR-0003`), the handler is a thinner wrapper than
`delegate_replay`'s (no branching at all), and no MCP type touches `src/services/`. Not
re-derived here per this ADR's own reuse mandate.

## Explicitly out of scope

`getSnapshot()`, `getTimeline()`, `ConsumerRegistry` exposure — future waves. `delegate_timeline`
— rejected, see `ADR-0007` Alternatives. `delegate_search` — deferred, see
`CAPABILITY_ROADMAP.md` Rank 7.

## Compatibility impact

One net-new tool — **minor** per `FOUNDATION_FREEZE.md`. Zero change to any existing tool or to
`ObservabilityService`.

## Testing plan

Same convention as `delegate_replay` — real `ObservabilityService` against a real bus, no
per-handler unit file. `npm test` must stay green; Inspector must show 8 tools, other 7
unchanged.
