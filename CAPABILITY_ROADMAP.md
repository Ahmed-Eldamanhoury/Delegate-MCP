# Capability Roadmap — Next Product Wave

**Baseline:** the codebase as of `main@fe6467e` (Persistent Event History Sprint, certified,
`v2.4.0`). This document treats that state as given — it does not propose further refactors or
cleanup (two such items are already tracked separately: `task_026caee1` on the
`ObservabilityService` stack's unconsumed status, `task_d7317142` on three dead `RuntimeEvent`
types). This is a forward-looking evaluation of **user-facing capabilities**, not
infrastructure-for-its-own-sake.

**Product identity, stated plainly because it shapes every evaluation below:**
`claude-delegate-mcp` is a **local, stdio-transport MCP server** invoked by an MCP host (Claude
Desktop or another MCP client) — confirmed by `docs/adr/ADR-0004-server-instance-lifecycle.md`'s
own investigation (`StdioServerTransport`, no HTTP listener anywhere in this codebase today) and
by every ADR's "Compatibility impact" section, which measures changes against MCP schema and
`JobManager`'s contract, never against a web/HTTP contract. Its current users are **MCP
clients** — an AI orchestrator or a human inside a chat interface — not people with a browser
tab open to a separate dashboard. This fact is decisive for several rankings below.

## Evaluation

Each candidate scored on: production value, architectural readiness (what's already designed/
built vs. what's a green field), code already reusable, estimated complexity, dependencies, and
expected user impact.

### 1. Replay Viewer

- **Production value — High, for the actual user base.** Two full sprints (`ADR-0005`,
  `ADR-0006`) were spent making a job's full event history survive eviction and restart. Right
  now, **nothing outside `ObservabilityService`'s own tests can call `replay(jobId)` at all** —
  the capability exists and is fully tested, but is completely unreachable by any real user.
  Exposing it is the single highest-leverage, lowest-cost way to convert existing investment
  into value.
- **Architectural readiness — Highest of all nine candidates.** `docs/adr/ADR-0003-observability-architecture.md`'s
  own Extension Rules table names this exact wave: *"AI Consumers (e.g. an orchestrating model
  asking 'what's running right now') | A future MCP tool ... whose handler calls
  `ObservabilityService` internally, same pattern `delegate_status` already uses for
  `JobManager` | Deferred — no MCP schema change in this ADR."* `docs/FOUNDATION_FREEZE.md`'s own
  versioning policy classifies "new tool" as **minor**, not a breaking or even a moderate-risk
  change. Six MCP tools already exist as a template (`src/server/mcpServer.js`).
- **Code already reusable — 100% of the backend.** `ObservabilityService.replay(jobId)`
  (frozen, tested, shipped) needs zero new logic. `createMcpServer()` already holds a local
  `observabilityService` reference in scope at the exact point new `server.registerTool(...)`
  calls would go (verified by reading the file directly).
  `src/handlers/delegateStatusHandler.js`/`delegateHistoryHandler.js` are a directly-copyable
  template for the new handler's shape (`{content, structuredContent}` / `{isError, content}`).
- **Estimated complexity — Low.** One new handler file (~20-30 lines, mirroring
  `delegateStatusHandler.js` almost exactly), one schema field reuse (`JOB_ID_FIELD` already
  exists), one `registerTool` call, tests. No new dependency, no new transport, no new process
  lifecycle.
- **Dependencies — None unbuilt.** Depends only on `ADR-0003` (shipped, v1.9.0) and `ADR-0006`
  (shipped, v2.4.0). Nothing else on this list needs to exist first.
- **Expected user impact — Immediate and universal.** Any MCP client (Claude Desktop, or any
  other host) that already talks to this server gains the ability to ask "what exactly happened
  in that job" — including full-fidelity history recovered after a restart — with no new tool
  to install, no new port to open, no new UI to learn.

**One naming note, addressed head-on:** "Viewer" often implies a visual web UI. This evaluation
recommends **MCP-native access** (a new tool) over a **standalone web viewer**, and separates
those two readings explicitly — see the ranking discussion below for why the MCP-native reading
wins decisively for this product, and where a future web viewer would fit if ever built.

### 2. Timeline Viewer

Same duality as Replay Viewer. `ObservabilityService.getTimeline(jobId, {type?, since?})` is
equally frozen, tested, and equally unreachable by any real consumer today. As MCP-native access
(a `type`/`since`-filterable view, or folded into the same new tool as Replay), the readiness/
complexity/reuse profile is identical to Replay Viewer's — genuinely the same wave, not a
separate one, differing only in which `ObservabilityService` method is called. As a standalone
web UI, it inherits the same infrastructure burden as Dashboard (below). Recommendation: treat
Timeline access as a natural, near-zero-cost extension of the same new tool that exposes Replay
(see ADR-0007), not a separate wave.

### 3. Dashboard

- **Production value — High in the abstract, narrower in practice for this product's actual
  usage pattern.** Real value for a power user running many concurrent `delegate_submit` jobs,
  but this product's stated identity (a local MCP server billed against an existing Claude
  subscription) doesn't obviously demand a separate always-on web app for its typical use.
- **Architectural readiness — Low.** `ADR-0003`'s own table: *"Web Dashboard | Thin HTTP/
  WebSocket adapter ... | Deferred — its own future ADR."* Requires, from zero: an HTTP server
  (this codebase has never had one — confirmed by `ADR-0004`'s direct reading of
  `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js`, the only transport in use),
  a web framework decision (`ADR-0003`: *"framework choice is a real dependency decision, not
  made here"*), an actual UI build/toolchain, and a new security model for exposing a network
  listener (a genuine departure from this codebase's stdio-only threat model —
  `docs/FOUNDATION_FREEZE.md`'s security invariants are all about subprocess spawning, none
  about network exposure, because none has existed until now).
- **Code already reusable — Backend only.** `getSnapshot()`/`getMetrics()`/`getTimeline()`/
  `replay()` are ready to be called; 0% of an actual Dashboard (server, routes, UI) exists.
- **Estimated complexity — High.** New runtime dependency (or several), new server lifecycle
  question (does it start automatically? behind a flag? what port? what happens on conflict?),
  a UI with its own build pipeline.
- **Dependencies — REST API, or at least an ad hoc HTTP layer, as a practical prerequisite.**
- **Expected user impact — Real, but gated behind the largest unbuilt-infrastructure cost of
  any candidate on this list.** Ranks low specifically because the instruction is to pick a
  *capability*, not commit to the *infrastructure* a capability like this presupposes.

### 4. REST API

- **Production value — Real, for a different audience.** Enables third-party/scripted
  integrations outside any MCP host — genuinely useful, but for users this product doesn't
  currently serve at all (its whole value proposition today is "no separate API key, billed
  against your Claude subscription via the CLI" — a REST API is a scope expansion, not a natural
  extension of the existing user base).
- **Architectural readiness — Low.** Same gap as Dashboard: no framework decision made, no HTTP
  server exists, `ADR-0003` explicitly defers this with no design.
- **Code already reusable — Backend only**, same as Dashboard (`ObservabilityService`'s methods
  map 1:1 to hypothetical endpoints, per `ADR-0003`'s own table — but no routing/auth/versioning
  layer exists).
- **Estimated complexity — High.** New dependency, new server lifecycle, a genuinely new
  security question (authentication for a network-facing API didn't need to exist before), a
  separate versioning policy from the MCP schema's own.
- **Dependencies — None unbuilt, but is itself a dependency for Dashboard/WebSocket streaming/
  Live Monitoring.**
- **Expected user impact — Meaningful for automation use cases, but this is a strategic
  expansion of the product's surface, not an incremental feature — deserves its own deliberate
  future wave, not a default "next" pick.**

### 5. Analytics

- **Production value — Medium.** Cost/usage trends over time would be genuinely useful, but
  today's retention (`maxJobHistory`/`maxWorkspaceHistory`/`maxEventHistoryFiles`, all defaulting
  around 100) bounds how much history is actually available to aggregate over — meaningful
  trend analysis needs either a much larger retention policy (a real, undesigned tradeoff) or
  accepting a narrow window.
- **Architectural readiness — Low-Medium.** Not even named in `ADR-0003`'s Extension Rules table
  (closest analog: "Prometheus Exporter," which is about *scraping* existing metrics, not
  computing new cross-job aggregates). `ADR-0006`'s own Q4 answer speculated about a future
  `getHistoricalMetrics({since, until})` method — genuinely undesigned, not just unbuilt.
- **Code already reusable — Partial.** Raw data exists (`workspace/jobs/*/metadata.json`'s
  `cost`/`runtimeMs` fields, `ADR-0001`; `EventHistoryStore`'s durable logs, `ADR-0006`) but the
  aggregation logic itself doesn't exist anywhere.
- **Estimated complexity — Medium.** No new transport needed if surfaced via an MCP tool
  (in-process aggregation over existing files), but real new logic to design and write.
- **Dependencies — Benefits from settling the retention-window tradeoff first; overlaps with
  Search's data needs.**
- **Expected user impact — Valuable to an ops-minded subset of users; narrower than universal
  Replay access, and not yet even scoped as a concrete design.**

### 6. Search

- **Production value — Low right now, given current scale.** With job/history retention capped
  around 100 by default, "search a large historical corpus" isn't yet a real problem this
  product's users are hitting.
- **Architectural readiness — Low.** No index exists, no search method is designed anywhere.
- **Code already reusable — Partial**, same raw sources as Analytics.
- **Estimated complexity — Medium-High**, depending on ambition (a linear scan over ≤100 small
  files is trivial; a real search index is a new subsystem).
- **Dependencies — Shares data-layer needs with Analytics.**
- **Expected user impact — Premature.** Revisit once real usage patterns (or an intentionally
  larger retention policy) create an actual need.

### 7. Live Monitoring

- **Production value — Low incremental value over what already exists.** `mcpProgressAdapter.js`
  (`ADR-0002`) already pushes live `notifications/progress` for `delegate_task`'s blocking calls;
  `delegate_status`/`delegate_history` polling already covers the `delegate_submit` path. A
  dedicated "Live Monitoring" feature would mean either enhancing MCP progress notifications
  further (marginal) or building a push-based external viewer (which collapses into Dashboard/
  WebSocket streaming below).
- **Architectural readiness — None independent of Dashboard/WebSocket streaming** — it isn't a
  standalone capability, it's a property those two would need to have.
- **Code already reusable — `RuntimeEventBus.subscribeAll()` is exactly the right hook** — but
  that's already true for every existing bus subscriber; nothing new to reuse specifically for
  "live monitoring" as its own thing.
- **Estimated complexity — High**, inherited entirely from whichever transport it rides on.
- **Dependencies — Is the same capability as Dashboard + WebSocket streaming, not independent.**
- **Expected user impact — Marginal, given the existing progress-notification + polling
  mechanisms already deliver most of this value today.**

### 8. WebSocket streaming

- **Production value — Zero standalone.** Pure transport plumbing with no consumer of its own;
  its only conceivable users are a future Dashboard or Live Monitoring feature, neither of which
  exists.
- **Architectural readiness — Low.** No WebSocket server exists; `RuntimeEventBus` is the right
  internal hook, but the actual network-facing server, connection lifecycle, and any external
  protocol are all undesigned.
- **Code already reusable — `RuntimeEventBus`, nothing else.**
- **Estimated complexity — High**, and unjustifiable in isolation — building push infrastructure
  before anything needs to consume the push is precisely the "infrastructure improvement ahead
  of a real consumer" this evaluation was asked to deprioritize.
- **Dependencies — Depends on Dashboard/Live Monitoring existing first; building it before
  either is backwards.**
- **Expected user impact — None on its own.**

### 9. Plugin API

- **Production value — Speculative.** No concrete third-party plugin author has been named or
  is asking for this. `docs/releases/SUPPORTED_FEATURES.md`'s own words: *"No design exists yet
  beyond 'future consumers depend only on `ObservabilityService`.'"*
- **Architectural readiness — Lowest of all nine candidates.** Zero design work exists — not
  even a sketched contract, unlike Dashboard/REST API which at least have a named row in
  `ADR-0003`'s Extension Rules table. No plugin-loading mechanism, no sandboxing model, no
  compatibility/versioning policy.
- **Code already reusable — In principle, the whole `ObservabilityService` API "is" the future
  contract** — but there's no actual loading, discovery, or isolation mechanism, and third-party
  code execution inside this process raises a real, entirely unscoped security question this
  codebase has never had to consider (every existing security invariant is about the CLI
  subprocess it spawns, not about arbitrary in-process third-party code).
- **Estimated complexity — High, with high uncertainty** (security sandboxing for arbitrary
  code is its own unscoped research problem, not an estimable engineering task yet).
- **Dependencies — Needs a concrete transport (probably REST API) plus an entirely new security
  model — the least-ready foundation of any candidate.**
- **Expected user impact — Entirely hypothetical until a concrete plugin use case exists.**
  Building this now would be the exact premature abstraction `ADR-0003` repeatedly warned
  against building ahead of a real consumer — *accelerating* into the one thing this project's
  own engineering culture has consistently deferred.

## A. Which capability should be implemented first?

## Ranking

| Rank | Capability | One-line reason |
|---|---|---|
| **1** | **Replay/Timeline access via a new MCP tool** | Zero new infrastructure, 100% backend reuse, directly monetizes two full completed sprints, matches a wave `ADR-0003` already pre-designed and deferred, classified as a **minor**, safe change by this project's own frozen versioning policy. |
| 2 | Analytics (metrics-only, MCP-native) | Same low-infrastructure family as #1, but narrower audience and the aggregation logic itself is genuinely undesigned — a legitimate *second* MCP-native wave, not the first. |
| 3 | REST API | Real value, but a deliberate strategic scope expansion requiring a framework decision and a new security model — its own future wave, not a default next step. |
| 4 | Dashboard | Depends on #3's infrastructure (or an ad hoc equivalent); the single biggest unbuilt-infrastructure cost on this list. |
| 5 | Timeline Viewer (standalone web UI reading) | Rides on #4's infrastructure if a *visual* viewer is truly wanted separately from MCP-native access. |
| 6 | Live Monitoring | Marginal value over existing progress-notification + polling; not independent of #4/#8. |
| 7 | Search | Premature at current retention scale; revisit once real usage data shows a need. |
| 8 | WebSocket streaming | Zero standalone value; transport plumbing for a consumer (#4/#6) that doesn't exist yet. |
| 9 | Plugin API | Least architecturally ready of all nine; entirely speculative; the exact premature abstraction this project's culture has consistently deferred. |

**Recommendation: build #1 — a new MCP tool exposing `ObservabilityService.replay()` (and,
folded into the same small wave, `getTimeline()`) to the server's actual, existing users.** This
is the only candidate that delivers real, immediate, universal user value without requiring any
new infrastructure decision this project hasn't already made. See
`REPLAY_ACCESS_ARCHITECTURE_REVIEW.md`, `docs/adr/ADR-0007-mcp-replay-access.md`, and
`docs/superpowers/plans/mcp-replay-access.md` for the full design, following the same process
`ADR-0005` and `ADR-0006` used.
