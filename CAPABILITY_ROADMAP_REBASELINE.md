# Capability Roadmap Re-Baseline

**Baseline:** `main@0e3a36d`, tag `v2.6.0`. Supersedes `CAPABILITY_ROADMAP.md`'s ranking for all
remaining candidates. Ranks #1 (Replay) and #2 (Analytics/metrics-only) from that document are
historical record, not restated — they shipped as `delegate_replay` (`ADR-0007`, v2.5.0) and
`delegate_metrics` (`ADR-0008`, v2.6.0). This document evaluates only what's left.

**No implementation in this document. Analysis only, per instruction.**

## What materially changed since the original ranking

1. The "thin MCP wrapper over `ObservabilityService`" pattern has now shipped **twice**,
   proving it cheap and low-risk — but also revealing its real cost driver isn't code, it's
   **docs reconciliation**: `delegate_replay` took 6 review cycles to stop finding stale
   "no external consumer" claims scattered across docs; `delegate_metrics`, applying that
   lesson, took 2. A third iteration should cost less still.
2. The original "Analytics" candidate (rank 2) was scoped as *"metrics-only, MCP-native"* — that
   scope is now done. The **remaining** "Analytics layer" the user asks me to re-evaluate is a
   different, bigger thing: cross-job historical/trend aggregation, which was never designed
   (`ADR-0006`'s Q4 answer only speculated about a future `getHistoricalMetrics({since, until})`).
   It should rank lower than the original "Analytics" line did, because its cheap portion is
   already captured.
3. Re-examining `delegate_consumers` specifically (not done at this granularity before): its
   backing subsystem, `ConsumerRegistry`, is a **stateful lease/heartbeat registry**
   (`registerConsumer`/`touchConsumer`/`unregisterConsumer`) meant for a long-lived process
   (a future Dashboard or REST backend) to track its own registration over time. An MCP tool is
   a one-shot request/response call from an ephemeral AI session — the wrong shape of consumer
   for register-then-heartbeat-then-unregister semantics. This is a new finding, not a restated
   one: `delegate_consumers` is likely **not a good MCP tool candidate at all**, independent of
   priority.
4. `delegate_snapshot` (`getSnapshot()` → `{takenAt, metrics, activeJobs}`) was re-examined against
   "is this redundant with `delegate_metrics` + `delegate_history`?" Its `activeJobs` field is
   derived from `ObservabilityService`'s own event-derived bookkeeping (`MetricsCollector`), not
   from `JobManager` directly — a different, non-authoritative code path from `delegate_history`.
   Its real distinct value is **atomicity**: one timestamped read of "metrics + what's active
   right now," useful for a poll-based Dashboard consumer wanting a single consistent snapshot
   instead of two separate calls that could observe an in-flight state change between them. This
   is exactly the purpose `ADR-0003` designed `getSnapshot()` for.

## Updated ranking

| Rank | Candidate | Sprint size | Dependencies | Business value | Technical value | Unlocks |
|---|---|---|---|---|---|---|
| **1** | **`delegate_snapshot`** | XS (~1 day, proven pattern) | None unbuilt | Med — atomic point-in-time read for future pollers | High — completes the query-only `ObservabilityService` MCP surface; fully proves Dashboard's data layer | Dashboard/REST data-layer confidence |
| 2 | REST API Foundation (design/ADR only) | S for ADR, L for build | None unbuilt | High — unlocks Dashboard, Plugin/API, external automation at once | High — single shared backend avoids duplicate transport work later | Dashboard, Plugin/API, Analytics-as-endpoint |
| 3 | Dashboard Foundation (design/ADR only) | S for ADR, L for build | REST API Foundation (should sit underneath it, not beside it) | High in the abstract, narrower for this product's actual MCP-client user base | Med — data layer now 100%-MCP-proven (replay+metrics+snapshot); only the transport/UI layer is unbuilt | Live Monitoring |
| 4 | Analytics layer (cross-job historical/trend) | M (needs new aggregation design) | Retention-window tradeoff; naturally an endpoint on REST API Foundation rather than a new MCP tool | Med — ops-minded subset of users | Low-Med — `getHistoricalMetrics()`-style method still entirely undesigned | Nothing further; a leaf capability |
| 5 | Live Monitoring | — (not a standalone capability) | Dashboard/REST + streaming | Low — existing MCP progress notifications + polling already cover most of this | Low | Nothing |
| 6 | `delegate_search` | — (deferred) | Larger retention policy, or real usage data showing need | Low at current ~100-job retention scale | Low — no index designed | Nothing until precondition changes |
| 7 | `delegate_timeline` | — (rejected, stands) | N/A | None — strict subset of `delegate_replay`'s runtime tier (`ADR-0007` Alternatives) | None | If filtering is ever needed, extend `delegate_replay` with `type`/`since` params instead |
| 8 | Plugin/API layer | — (not ready) | REST API Foundation + an undesigned sandboxing/security model | Speculative — no named consumer | None — zero design exists | Nothing until a concrete use case exists |
| 9 | `delegate_consumers` | N/A as an MCP tool | — | Low as an MCP tool — see finding #3 above | Low as an MCP tool; `ConsumerRegistry` itself stays valuable as future Dashboard/REST-internal infrastructure | Reconsider only if/when a Dashboard/REST backend process needs it in-process — not via MCP |

`delegate_timeline` and `delegate_search` re-confirmed, not reopened — no new evidence changes
either the `ADR-0007` rejection or the roadmap's "premature" call on scale.

## Architectural justification

- **`delegate_snapshot` first:** it's the last cheap, zero-new-architecture item in the
  `ObservabilityService`-query family (`replay` → `metrics` → `snapshot`), and it directly
  produces the data-layer proof a Dashboard/REST build would otherwise have to redo from
  scratch. After it ships, every read-oriented `ObservabilityService` method with a real,
  well-shaped MCP consumer will have one — a deliberate stopping point, not an oversight:
  `ConsumerRegistry` doesn't get one because its shape doesn't fit MCP (finding #3).
- **REST API before Dashboard:** the original roadmap already ranked REST above Dashboard
  (ranks 3/4) for the same reason repeated here — REST is a shared substrate Dashboard, Plugin
  API, and external automation can all sit on, while Dashboard alone only serves itself. Nothing
  has changed to reverse that ordering; if anything, it's more clearly true now that three
  MCP-native reads exist as a proven reference implementation of what REST's own read endpoints
  should return.
- **Analytics demoted:** the cheap version of "Analytics" is done. What's left needs real design
  work (aggregation logic, retention tradeoff) and is better built as a REST endpoint later than
  as a fourth MCP tool now — there's no urgency and no unblocked path to it today.
- **`delegate_consumers` demoted below its original implicit position:** this is the one place
  this re-baseline overrides a implicit assumption in the prior roadmap (that ConsumerRegistry
  exposure was just "a future wave" of the same kind as replay/metrics/snapshot). Closer
  examination shows it likely isn't MCP-shaped work at all. Flagging this rather than silently
  scheduling it.

## Recommended next sprint

**`delegate_snapshot` only** — single track, same governance as the `delegate_metrics` sprint
(no parallel candidate is both independent and ready: `delegate_consumers` is the wrong shape,
`delegate_search`/`delegate_timeline` stay deferred/rejected, REST/Dashboard/Analytics are all
bigger design-first waves). ADR-0009 would mirror ADR-0008's concise reuse-by-reference pattern
(same six-principle Transport-Agnosticism Verification, same testing convention, same
`{takenAt, metrics, activeJobs}` passthrough with zero new logic).

## Expected roadmap after that sprint

1. `delegate_snapshot` ships (v2.7.0) — the `ObservabilityService` MCP-read surface is complete;
   `ConsumerRegistry` is the only unconsumed piece, by design (finding #3), not by omission.
2. Next architecture-review gate: draft a **REST API Foundation ADR** (design only — framework
   choice, hosting/lifecycle model, auth model, versioning policy separate from the MCP schema's
   own). No implementation until that ADR is reviewed and approved, per this project's standing
   process.
3. Dashboard Foundation follows as a thin layer on top of REST API Foundation, not a parallel
   build — deferred until REST's ADR is settled.
4. Analytics layer and Plugin/API layer remain parked, revisited only if a REST API Foundation
   creates a natural place to attach them (an endpoint, a plugin transport) or new usage data
   changes their preconditions.
