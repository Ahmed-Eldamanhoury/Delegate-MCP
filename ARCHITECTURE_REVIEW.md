# Architecture Review — Observability Subsystem

**Scope:** requested after a whole-repo ponytail-audit (run during the Persistent Job Store
Sprint's Task 7 final gate) flagged `ObservabilityService` and its five components as having
zero production consumers. Before treating that as dead weight, this review determines what
the subsystem actually is, whether it's genuinely unused or deliberately ahead of its
consumers, and whether it should be the foundation for the requested next wave ("Persistent
Event History + Replay Engine") rather than be removed. **No code was changed to produce this
review** — it is read-only analysis, per the explicit instruction not to delete or refactor
anything yet.

## Documents read (in full, before any conclusion below)

- `docs/adr/ADR-0001-workspace-and-artifact-architecture.md`
- `docs/adr/ADR-0002-streaming-and-event-architecture.md`
- `docs/adr/ADR-0003-observability-architecture.md`
- `docs/adr/ADR-0004-server-instance-lifecycle.md` (context; not directly load-bearing here)
- `docs/adr/ADR-0005-persistent-job-store.md` (this sprint's own architecture, for comparison)
- `docs/FOUNDATION_FREEZE.md`
- `docs/OBSERVABILITY_FREEZE.md`

## Source read (in full)

- `src/services/observabilityService.js`
- `src/services/metricsCollector.js`
- `src/services/timelineStore.js`
- `src/services/replayEngine.js`
- `src/services/snapshotBuilder.js`
- `src/services/consumerRegistry.js`
- `src/services/runtimeEventBus.js`
- `src/models/runtimeEvent.js`
- `src/server/mcpServer.js` (wiring)
- `src/cli/entry.js` (shutdown path)

Plus a repo-wide grep for every call site of this subsystem's public methods, and the six
dedicated test files' test counts.

## What the subsystem actually is

`RuntimeEventBus` (ADR-0002) is a single in-process pub/sub bus (`{publish, subscribe,
subscribeAll}`, `src/services/runtimeEventBus.js:21-63`) that every job-lifecycle transition
already publishes to, in production, on every real `delegate_task`/`delegate_submit` call. It
has **three** subscribers wired in `mcpServer.js` today:

| Subscriber | Wired at | Role |
|---|---|---|
| `workspaceEventBridge.js` | `mcpServer.js:67` | drives disk persistence (execution pipeline) |
| `mcpProgressAdapter.js` | inside `createDelegateTaskHandler` per ADR-0002 | drives MCP `notifications/progress` (execution pipeline) |
| `ObservabilityService` | `mcpServer.js:75` | **observation only** — this review's subject |

`ObservabilityService` (`src/services/observabilityService.js:25-100`) is a façade over five
components, each with a single, narrow responsibility:

- **`MetricsCollector`** (`metricsCollector.js`) — O(1) incremental aggregates (queued/running/
  completed/failed/cancelled counts, average/max runtime, average queue wait, progress rate),
  updated on every `record(event)` call. No stored history arrays.
- **`TimelineStore`** (`timelineStore.js`) — per-job, append-only, in-memory list of lean
  `TimelineEntry` objects. Bounded by `maxTimelineHistory` (oldest-**terminal**-job eviction,
  an in-flight job's timeline is never evicted — `timelineStore.js:23-31`). **Lost on process
  restart** — this is the exact gap this review exists to evaluate.
- **`ReplayEngine`** (`replayEngine.js`) — reconstructs a job's event history for viewing, zero
  side effects, zero re-execution. Three-tier fallback: `runtime` (TimelineStore, full
  fidelity) → `workspace` (synthesized from `metadata.json`'s three timestamps, **coarse** —
  `replayEngine.js:13-49`) → `unavailable`.
- **`SnapshotBuilder`** (`snapshotBuilder.js`) — pull-only, `structuredClone()` +
  `Object.freeze()`'d point-in-time snapshot, no background timer.
- **`ConsumerRegistry`** (`consumerRegistry.js`) — bookkeeping only (register/unregister/touch/
  list/health/`pruneStale`), no transport, no second pub/sub layer.

## Is this dead code? No — evidence, not assertion

Every one of these components is **executing on every real job right now**: `bus.subscribeAll`
in `observabilityService.js:32-35` fans every published `RuntimeEvent` into
`metrics.record(event)` and `timeline.record(event)` unconditionally, for every job the server
runs, whether or not anything ever reads the result. This is the critical distinction the
review was asked to draw: **the write path is live production code with a 100% execution rate
per job; only the read path (`getMetrics`/`getTimeline`/`getSnapshot`/`replay`/consumer
methods) has zero external callers.** "Dead code" implies unreachable or never-executed code —
that is not what a grep confirms:

```
grep -rln "createObservabilityService\|getMetrics\|getTimeline\|getSnapshot\|registerConsumer\|\.replay(" src/ --include="*.js"
  src/server/mcpServer.js          (the one construction call)
  src/services/observabilityService.js
  src/services/metricsCollector.js
  src/services/timelineStore.js
  src/services/snapshotBuilder.js
  src/services/consumerRegistry.js
  src/services/replayEngine.js
```

No handler, no script, no MCP tool anywhere in `src/` calls any read method. That confirms the
audit's "zero production consumers" finding precisely — but the correct characterization is
**unconsumed**, not **dead**: the state is being actively, correctly maintained; nobody is
asking for it yet.

## Is this "ahead of time" by design, or accidental? Evidence for deliberate

ADR-0003's own Status line states this plainly, not as a gap discovered later: *"No Dashboard,
REST API, plugin, or new MCP tool consumes `ObservabilityService` yet — those remain future
waves."* (`ADR-0003:9-10`). Its Context section explains *why* it was built before any
consumer exists: *"Today, building [a Dashboard/plugin/REST API] would mean subscribing
directly to `RuntimeEventBus` — which means every future consumer re-derives its own metrics,
its own timeline reconstruction, its own retention policy, from raw `RuntimeEvent`s. That's the
coupling this ADR removes"* (`ADR-0003:27-32`). Its Alternatives section explicitly rejected
waiting: *"Let Dashboard/plugins subscribe to `RuntimeEventBus` directly: rejected — this is
exactly the coupling the wave's objective calls out"* (`ADR-0003:349-352`).

This is a documented, deliberate build-the-plumbing-before-the-faucet decision, reviewed and
accepted (`ADR-0003` Status: *"Accepted and fully implemented (v1.9.0)... verified against
every guarantee in `docs/FOUNDATION_FREEZE.md`"*), not an abandoned side branch.

## Test coverage — is it production-ready?

| File | Dedicated tests |
|---|---|
| `tests/consumerRegistry.test.js` | 16 |
| `tests/observabilityService.test.js` | 12 |
| `tests/metricsCollector.test.js` | 9 |
| `tests/timelineStore.test.js` | 7 |
| `tests/replayEngine.test.js` | 6 |
| `tests/snapshotBuilder.test.js` | 4 |
| **Total** | **54** |

All 54 currently pass as part of the repo's 213/213 suite. `OBSERVABILITY_FREEZE.md:58-61`
states the Passive Observation Rule is verified "structurally (`Object.keys(observability)`
contains no mutator) and by regression test." Structurally: `observabilityService.js`'s
`getMetrics`/`getTimeline`/`replay`/`getSnapshot`/consumer methods take no job-mutating
argument and the module holds no reference to `JobManager` or `bus.publish` anywhere in its
closure (confirmed by reading the whole file — its only bus interaction is the one
`subscribeAll` call). This is genuinely production-quality code: read-only by construction,
bounded memory, tested, integrated into the real bus today.

## One real defect found (not by the audit — found while verifying the freeze doc's own claims)

`OBSERVABILITY_FREEZE.md:310`'s "Resource cleanup" claims: *"`ObservabilityService`'s
`bus.subscribeAll()` returns an unsubscribe function, called during the same graceful-shutdown
path `cli/entry.js` already uses for `SIGINT`/`SIGTERM`."* This is **false as currently
implemented**:

- `mcpServer.js:75`: `createObservabilityService({ bus, config, logger, maxTimelineHistory:
  config.maxJobHistory });` — the return value (which is the only handle to `close()`) is
  **discarded**, not assigned to any variable, not returned from `createMcpServer()`.
- `src/cli/entry.js:26-33`'s `registerShutdownHandlers()` calls only `server.close()` (the MCP
  SDK's own transport close) on `SIGINT`/`SIGTERM`/`stdin`-end. It has no reference to, and
  never calls, any `ObservabilityService` instance's `close()`.

**Practical impact: none today** — the whole Node process exits via `exit()` immediately after
`server.close()` resolves (`entry.js:29`), which reclaims the bus subscription along with
everything else in the process. This is a **documentation/code mismatch**, not a resource leak
with observable consequences under the current single-process lifecycle. It matters for this
review because it is concrete evidence that this subsystem's own designed cleanup hook was
never actually wired up end-to-end — worth fixing as part of any wave that touches this code
next (see `CONSOLIDATION_PLAN.md`), not evidence against the architecture's soundness.

## Answering the review's required questions

**Which components are production-ready?** All six (`ObservabilityService`,
`MetricsCollector`, `TimelineStore`, `ReplayEngine`, `SnapshotBuilder`, `ConsumerRegistry`) —
tested, structurally sound, actively maintaining correct state on every real job today, zero
known defects in their own logic (the one defect found is in wiring one level up, in
`mcpServer.js`/`entry.js`, not in the components themselves).

**Which are intentionally "ahead of time" infrastructure?** The entire stack, as a unit — this
is not a per-component distinction. ADR-0003 built all five components as one wave,
specifically so that whichever consumer arrives first (Dashboard, REST API, a new MCP tool)
inherits metrics/timeline/replay/consumer-tracking for free instead of rebuilding it.

**Which are genuinely dead code?** None. See "Is this dead code?" above — every component's
write path executes on every job; the read path (methods, not the components) is unconsumed,
which is a different, much narrower claim than "dead."

**Which are waiting for future consumers?** All six, by design (ADR-0003 Extension Rules,
`ADR-0003:280-294`) — Dashboard, CLI Dashboard, VSCode Extension, REST API, Prometheus
Exporter, Grafana Adapter, and future AI-facing MCP tools are each designed to call
`ObservabilityService`'s existing frozen methods, never `RuntimeEventBus` directly.

**Which should become the foundation for future Dashboard/API work?** `ObservabilityService`'s
public API, as currently frozen in `OBSERVABILITY_FREEZE.md` — see `DASHBOARD_FOUNDATION.md`
for the full argument.

See `REUSE_ANALYSIS.md` for the comparison against `FileJobStore`/ADR-0005, `CONSOLIDATION_PLAN.md`
for the proposed extension strategy, and `RECOMMENDATION.md` for the final verdict.
