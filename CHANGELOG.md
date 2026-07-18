# Changelog

## [2.9.4] - 2026-07-18

Production patch release. Fixes a genuine defect discovered and repaired during the Production
Acceptance Test for v2.9.3. **No API changes. No architecture changes. No feature additions.**

### Fixed

- **`src/services/delegationService.js`**: `DelegateTaskInputSchema.parse(input)` result was
  discarded — the raw, unprocessed `input` object was passed directly to `createExecutionContext`
  instead of the Zod-parsed output. When callers omitted optional fields (`max_budget_usd`,
  `allowed_tools`, `trust_all`), Zod's defaults were never applied: `createExecutionContext`
  received `undefined` for those fields, causing the CLI to be invoked with
  `--max-budget-usd undefined` and exit immediately with code 1.
  Fix: `const parsed = DelegateTaskInputSchema.parse(input); createExecutionContext(parsed, config)`.
  Zod defaults now apply for every submission path (MCP + REST). End-to-end verified: job
  submitted without `max_budget_usd`, ran to completion, `exitCode: 0`.

### Not changed

- REST routes — none modified.
- MCP interfaces — none modified.
- Application source beyond the single 2-line fix — unchanged.
- Authentication — unchanged.
- Dashboard source (`dashboard/src/`) — unchanged.
- Security invariants (RC6) — unchanged.
- Test suites — unchanged (466/466 server, 108/108 dashboard).
- All 12 ADRs remain FROZEN.

## [2.9.3] - 2026-07-18

Maintenance release following the Official Certified Baseline (v2.9.2). Contains CI compatibility
improvements and multilingual documentation only. **Zero application behaviour change.** No REST
contract change, no MCP schema change, no authentication change, no dashboard change, no
architectural change. Application functionality is identical to v2.9.2.

### Changed

- **`.github/workflows/ci.yml`**: Replaced `npm test` (which invoked `node --test tests/**/*.test.js`
  via `/bin/sh`/dash — no globstar support on Ubuntu) with `shell: bash` and
  `node --test tests/*.test.js`. Bash is available on all GitHub Actions runners (Ubuntu and
  Windows). Single `*` is correct for the flat `tests/` directory. All 4 matrix combinations
  (ubuntu-latest/windows-latest × Node 20/Node 22) now pass.

### Added

- **`docs/en/PROJECT_OVERVIEW.md`**: Canonical English project overview — 21 sections covering
  architecture, REST API, MCP tools, job lifecycle, security model, ADR registry, known
  limitations, and deployment. Includes Mermaid diagrams and reference tables.
- **`docs/ar/PROJECT_OVERVIEW.md`**: Faithful Arabic translation of the canonical overview.
  Technical terms (MCP, REST API, Replay, Dashboard, Authentication, etc.) preserved in English.
  All Mermaid diagrams and tables translated to Arabic.
- **`README.md`**: Language selector added after the title — links to English and Arabic
  project overviews.
- **`docs/{fr,es,zh}/`**: Empty directory stubs prepared for future language additions.

### Not changed

- REST routes — none modified.
- MCP interfaces — none modified.
- Application source (`src/`, `server.js`, `restServer.js`) — unchanged.
- Authentication — unchanged.
- Dashboard source (`dashboard/src/`) — unchanged.
- Security invariants (RC6: no `innerHTML`/`dangerouslySetInnerHTML`) — unchanged.
- Test suites — unchanged (466/466 server, 108/108 dashboard).
- All 12 ADRs remain FROZEN.

## [2.9.1] - 2026-07-18

Operational patch — adds the missing `restServer.js` runtime entry point specified in the WP2
design and corrects `docs/DEPLOYMENT.md`'s start command. **Zero application behaviour change.**
No REST contract change, no MCP schema change, no authentication change, no dashboard change.
466/466 server tests + 108/108 dashboard tests unchanged. Independently certified
(`HOTFIX CERTIFIED` 2026-07-18) before tagging.

### Added

- **`restServer.js`**: top-level entry point that imports `main()` from `src/cli/restEntry.js`
  and calls it. Mirrors `server.js`→`entry.js` pattern for the MCP transport. Was specified
  in the WP2 design ("restEntry.js + restServer.js skeleton") but not created at implementation
  time, causing `node src/cli/restEntry.js` to exit immediately (that file exports `main()` but
  never calls it — by design, so tests can import it). Correct start command: `node restServer.js`.

### Fixed

- **`docs/DEPLOYMENT.md`**: start command corrected from `node src/cli/restEntry.js` to
  `node restServer.js`.

### Not changed

- REST routes — none modified.
- MCP interfaces — none modified.
- Authentication (`auth.js`, `timingSafeEqual`) — unchanged.
- Dashboard source (`dashboard/src/`) — unchanged.
- Security invariants (RC6: no `innerHTML`/`dangerouslySetInnerHTML`) — unchanged.
- Test suites — unchanged (466/466 server, 108/108 dashboard).

## [2.9.0] - 2026-07-18

Dashboard Stage 3 — implements [ADR-0012](docs/adr/ADR-0012-dashboard.md): a React SPA served
directly from the existing REST server at `/dashboard/`, consuming only the frozen REST API
(`REST_FREEZE.md`). Zero new REST endpoints. Zero MCP schema impact. Zero change to any frozen
contract. **minor** per `docs/REST_FREEZE.md`'s own versioning policy: new capability, no change
to any existing route or MCP contract. 108/108 dashboard tests (Vitest) + 466/466 server tests
(node:test). Production build: 49 modules, 184.96 kB / 58.18 kB gzip. Independent certification:
CERTIFIED (0 BLOCKER, 0 HIGH). All 4 certification findings subsequently closed.

### Added

- **`dashboard/`**: React 18 + React Router v6 SPA — 7 screens (S1 Login, S2 Overview, S3 Jobs,
  S4 Job Detail, S5 Metrics, S6 Submit, S7 Models), 4 polling hooks (`useSnapshot`, `useJobs`,
  `useJobSubscription`, `useMetrics`), shared utilities (`lib/fmt.js`, `lib/auth.js`,
  `lib/client.js`, `lib/baseUrl.js`), `NavBar` component, 17 Vitest test files.
  Build command: `npm --prefix dashboard run build` → `dashboard/dist/`.
- **`src/rest/dashboard.js`**: `isDashboardRequest()` predicate + `serveDashboard()` static-file
  handler. `GET /dashboard/config.js` injects `window.__DELEGATE_REST__` dynamically.
  All `/dashboard/*` routes served **before** the auth gate (intentionally unauthenticated).
  Path-traversal guard: resolved path must start with `dashboardDir + sep`.
- **`docs/adr/ADR-0012-dashboard.md`**: canonical architecture decision record (FROZEN).
- **`docs/DEPLOYMENT.md`**: deployment prerequisites — dashboard build command, bearer-token
  setup, server start command, access URL, release checklist additions.
- **`docs/releases/RELEASE_NOTES_v2.9.0.md`**: human-readable release summary.
- **`docs/releases/DASHBOARD_RELEASE_REPORT.md`**: certification evidence index.
- 2 new server test files (`tests/restDashboard.unit.test.js`, `tests/restDashboard.integration.test.js`)
  covering `isDashboardRequest`, `serveDashboard`, path-traversal guard, config stub, MIME types.

### Changed

- **`src/config/index.js`**: `dashboardDir` config field added (default: `dashboard/dist/`
  relative to project root) — additive, no existing field changed.
- **`src/rest/restServer.js`**: `isDashboardRequest` check routed before auth gate —
  non-breaking, purely additive path.
- **`tests/configValidation.test.js`**: 2 new tests for `dashboardDir` (present, defaults
  correctly) — additive to pre-existing suite.
- **`docs/ARCHITECTURE.md`**: `dashboard.js` entry added to the file-tree section.
- **`.gitignore`**: `dashboard/dist/` added (build artifacts not committed).

## [2.8.0] - 2026-07-18

REST API Foundation — implements [ADR-0011](docs/adr/ADR-0011-rest-api-foundation.md): a new,
entirely opt-in HTTP transport (`src/cli/restEntry.js`) sitting alongside the existing stdio MCP
server, mapping 1:1 onto the same two already-frozen internal services
(`DelegationService`/`ObservabilityService`) every MCP handler already calls. Zero new business
logic, zero MCP schema impact, zero change to an MCP-only deployment's behavior. **minor** per
`docs/FOUNDATION_FREEZE.md`'s own versioning policy: new capability, zero change to any frozen
MCP contract. 440/440 tests passing (313 at `v2.7.1` + 127 new: pre-implementation MCP
characterization baseline plus every WP0–WP5 unit/integration/contract/security test).

### Added
- **`src/services/delegationBackend.js`**: `createDelegationBackend({config, logger, service?})`
  — the transport-agnostic construction (`JobManager`/`bus`/`ObservabilityService`/
  `DelegationService`/`EventHistoryStore` wiring) both `mcpServer.js` (stdio) and `restEntry.js`
  (REST) now call independently, each producing a fully independent instance sharing no
  module-level state.
- **`src/rest/`**: the REST HTTP layer — `restServer.js` (request pipeline: body-size gate →
  auth → route match → handler → error mapping → response), `router.js` (pure `:id`-param
  matcher), `auth.js` (bearer-token check + token generation/persistence), `bodyLimit.js`
  (Content-Length gate + streaming bound), `errors.js` (unified error-to-HTTP mapping),
  `parsing.js` (query-param validation), `routes/jobs.js` / `routes/observability.js` /
  `routes/models.js` (all 9 routes).
- **`src/cli/restEntry.js`**: standalone REST entry point (`main()`, `buildRouteTable()`,
  `registerRestShutdownHandlers()`) — never a flag on the existing `src/cli/entry.js`, never
  reachable from stdio's boot path.
- **9 new REST routes** — see `docs/REST_FREEZE.md` for the full frozen contract: `POST /v1/jobs`,
  `GET /v1/jobs/:id`, `GET /v1/jobs`, `DELETE /v1/jobs/:id`, `GET /v1/jobs/:id/replay`,
  `GET /v1/jobs/:id/timeline` (new, REST-only — no MCP mirror), `GET /v1/metrics`,
  `GET /v1/snapshot`, `GET /v1/models`.
- **`buildModelsInfo(config)`** (`src/models/schemas.js`): the structured model/effort/defaults
  data, extracted from `delegateModelsHandler.js`'s former inline body — now the single source
  both `delegate_models` (MCP) and `GET /v1/models` (REST) read from.
- **7 new REST config fields** (`src/config/index.js`, all additive):
  `CLAUDE_DELEGATE_REST_HOST`/`_PORT`/`_TOKEN`/`_TOKEN_FILE`/`_MAX_BODY_BYTES`/
  `_SHUTDOWN_GRACE_MS`/`_SHUTDOWN_FORCE_EXIT_MS`.
- **`docs/REST_FREEZE.md`**: the frozen REST contract, sibling to `FOUNDATION_FREEZE.md`/
  `OBSERVABILITY_FREEZE.md`.
- **127 new tests**: 2 new pre-implementation characterization files pinning the exact MCP
  baseline REST is built on top of without disturbing
  (`tests/fileJobStoreCoexistence.characterization.test.js`, `tests/
  handlerGaps.malformedIdRegression.test.js`), plus `tests/delegationBackend.test.js` and 15 new
  `tests/rest*.test.js` files (unit, integration, contract, and security coverage for every new
  module and route).

### Changed
- **`src/services/delegationService.js`**: `getJob`/`cancelJob` gain a leading
  `isValidJobId()` guard (shared with `workspaceManager.js`) — a malformed job id is now
  rejected before ever reaching `JobManager`, but returns exactly what the pre-existing
  unknown-id path already returned (`undefined`/`false`, never throws) — **zero observable
  change** to any existing MCP tool, proven byte-identical by `tests/
  handlerGaps.malformedIdRegression.test.js`.
- **`src/server/mcpServer.js`**: its former inline construction block now calls
  `createDelegationBackend()` instead — `new McpServer(...)` remains the literal first
  statement, construction order otherwise byte-identical, `server._registeredTools` unchanged
  across all 9 tools.
- **`src/handlers/delegateModelsHandler.js`**: now calls `buildModelsInfo(config)` instead of
  inlining the same logic — behavior-preserving, its existing characterization test passes
  unmodified.
- **`src/services/observabilityService.js`**: one comment corrected (a stale reference to
  `mcpServer.js`'s former construction site, now `delegationBackend.js`) — no behavioral change.
- **`tests/delegationService.test.js`**: new unit test proving the `isValidJobId()` guard
  short-circuits before ever reaching `JobManager` for a malformed id.
- **`tests/handlerGaps.characterization.test.js`**: new characterization tests pinning
  repeat-cancel-on-cancelled/repeat-cancel-on-running and malformed/unknown job-id baselines,
  ahead of and reused by this REST work.
- **`tests/mcpServer.test.js`**: `selectJobStore`/`selectEventHistoryStore`/
  `wireEventHistoryIfEnabled` import path updated to their new home, `delegationBackend.js`.
- **`tests/transportBoundary.test.js`**: extended to `src/rest/routes/*.js` — the same
  import-boundary check the existing MCP write-handler check already enforces.

## [2.7.1] - 2026-07-17

Stage 1a/1b of `ADR-0010` (Unified Access Layer) — implements
[ADR-0010](docs/adr/ADR-0010-unified-access-layer.md): a new `DelegationService`
(`src/services/delegationService.js`) is now the write-side counterpart to
`ObservabilityService`, the single object every MCP handler calls to submit, query, list, or
cancel a job. All five write-side tools (`delegate_task`, `delegate_submit`, `delegate_status`,
`delegate_history`, `delegate_cancel`) now route through it instead of calling `JobManager`
directly; the transitional `submitDelegation()` function has been removed now that both its
callers have migrated. `delegate_task` keeps one documented exception
(`jobManager.waitForCompletion()`/`.bus`, its frozen synchronous contract). Purely internal —
**patch** per `docs/FOUNDATION_FREEZE.md`'s own versioning policy: zero MCP schema change, zero
change to any tool's request/response shape, zero change to `ObservabilityService`. 313/313 tests
passing (287 pre-existing + 26 new: Stage 1a's characterization suite pinning the pre-refactor
baseline, `DelegationService` unit tests, and a structural boundary test).

### Added
- **`DelegationService`** (`src/services/delegationService.js`): `submit`/`getJob`/`listJobs`/
  `cancelJob`, mirroring `ObservabilityService`'s shape — held side by side, never merged, per
  `ADR-0010`'s Single Mutation Path Rule. `listJobs()` gains one deliberate, disclosed addition
  not present in the prior handler-resident logic: a `limit = 20` default (non-breaking for MCP,
  whose schema already supplies 20 before any handler runs).
- **Characterization test suite** (`tests/toolRegistry.characterization.test.js`,
  `tests/handlerGaps.characterization.test.js`, `tests/delegationService.test.js`): pins the full
  `tools/list` schema for all 9 tools and closes prior gaps (`delegate_models` had no test at
  all; `delegate_status`/`delegate_cancel`'s unknown-job-id paths and `delegate_history`'s
  status-filter/limit/ordering semantics were untested).
- **Structural transport-boundary test** (`tests/transportBoundary.test.js`): a permanent,
  CI-gateable check that the 5 write-side handlers depend on `DelegationService` only, never
  `JobManager` directly, except `delegate_task`'s one documented exception — the write-side
  analog of how `OBSERVABILITY_FREEZE.md`'s Passive Observation Rule is verified structurally.

### Changed
- `docs/FOUNDATION_FREEZE.md`'s frozen execution-contract sentence now names
  `DelegationService.submit()` instead of `submitDelegation()` as the single path into
  `JobManager` — the underlying guarantee (one single path, same sync/async response shapes) is
  unchanged.

### Compatibility
Zero MCP schema change across all 9 tools (Inspector `tools/list` byte-identical, independently
verified). Zero change to any tool's request/response shape, `ObservabilityService`, or
`RuntimeEventBus`'s event schema (`job.metadata.tool`/`JobQueued`'s `payload.tool` deliberately
left unrenamed — see `ADR-0010`). See `ADR-0010_REVIEW_PACKAGE.md`/`STAGE_1B_DESIGN_PACKAGE.md`
for the full architecture review and implementation design.

## [2.7.0] - 2026-07-16

MCP Snapshot Access Sprint — implements
[ADR-0009](docs/adr/ADR-0009-mcp-snapshot-access.md), a new `delegate_snapshot` tool that gives
any MCP client read-only access to `ObservabilityService.getSnapshot()` — the third and final
external consumer of the observability foundation built across the `ADR-0003`/`ADR-0006`
sprints (after `delegate_replay`/`ADR-0007` and `delegate_metrics`/`ADR-0008`), reusing
`ADR-0007`'s Platform Transport-Agnosticism Verification by reference rather than re-deriving
it. 287/287 tests passing (284 pre-existing + 3 new this sprint).

### Added
- **`delegate_snapshot` MCP tool** (`src/handlers/delegateSnapshotHandler.js`, registered in
  `src/server/mcpServer.js`): read-only, no input, wraps
  `ObservabilityService.getSnapshot()` verbatim — returns `{ content: [{ type: "text", text:
  JSON.stringify(snapshot) }], structuredContent: snapshot }`, the same thin two-line wrapper
  shape as `delegate_metrics`. `getTimeline()` and `ConsumerRegistry` remain out of scope — see
  the ADR's "Last tool in this family" section: every `ObservabilityService` read method with a
  well-shaped MCP consumer now has one.

### Compatibility
Zero change to any existing tool's schema — one net-new, additive MCP tool, **minor** per
`docs/FOUNDATION_FREEZE.md`'s own versioning policy. Zero change to `ObservabilityService` or
`SnapshotBuilder` — `delegate_snapshot` calls `ObservabilityService.getSnapshot()` exactly as it
already existed, no reshaping, no new type. Full design detail in
[ADR-0009](docs/adr/ADR-0009-mcp-snapshot-access.md). 287/287 tests passing (284 pre-existing +
3 new).

## [2.6.0] - 2026-07-16

MCP Metrics Access Sprint — implements
[ADR-0008](docs/adr/ADR-0008-mcp-metrics-access.md), a new `delegate_metrics` tool that gives
any MCP client read-only access to `ObservabilityService.getMetrics()` — the second external
consumer of the observability foundation built across the `ADR-0003`/`ADR-0006` sprints,
reusing `ADR-0007`'s Platform Transport-Agnosticism Verification by reference rather than
re-deriving it. 284/284 tests passing (281 pre-existing + 3 new this sprint).

### Added
- **`delegate_metrics` MCP tool** (`src/handlers/delegateMetricsHandler.js`, registered in
  `src/server/mcpServer.js`): read-only, no input, wraps
  `ObservabilityService.getMetrics()` verbatim — returns `{ content: [{ type: "text", text:
  JSON.stringify(metrics) }], structuredContent: metrics }`, a thinner wrapper than
  `delegate_replay`'s (no branching at all). `getSnapshot()`, `getTimeline()`, and
  `ConsumerRegistry` remain out of scope — future waves, per the ADR.

### Compatibility
Zero change to any existing tool's schema — one net-new, additive MCP tool, **minor** per
`docs/FOUNDATION_FREEZE.md`'s own versioning policy. Zero change to `ObservabilityService` or
`MetricsCollector` — `delegate_metrics` calls `ObservabilityService.getMetrics()` exactly as it
already existed, no reshaping, no new type. Full design detail in
[ADR-0008](docs/adr/ADR-0008-mcp-metrics-access.md). 284/284 tests passing (281 pre-existing +
3 new).

## [2.5.0] - 2026-07-16

MCP Replay Access Sprint — implements
[ADR-0007](docs/adr/ADR-0007-mcp-replay-access.md), a new `delegate_replay` tool that gives any
MCP client read-only access to `ObservabilityService.replay(jobId)` — the first external
consumer of the observability foundation built across the `ADR-0003` and `ADR-0006` sprints.
Two commits (the handler, `createDelegateReplayHandler`, built via TDD as a thin wrapper with no
replay/filtering/persistence logic of its own; then its registration as the MCP server's 7th
tool). 281/281 tests passing (278 pre-existing + 3 new this sprint).

### Added
- **`delegate_replay` MCP tool** (`src/handlers/delegateReplayHandler.js`, registered in
  `src/server/mcpServer.js`): read-only, takes a `job_id` and returns
  `{ source, timeline }` — `ObservabilityService.replay()`'s return value passed through
  verbatim, plus a human-readable `content[0].text` summary. `source` is one of four values:
  `"runtime"` (live, in-memory, full fidelity), `"durable"` (on-disk full fidelity, only when
  `CLAUDE_DELEGATE_EVENT_HISTORY=file` is enabled), `"workspace"` (coarse lifecycle summary
  synthesized from the job's workspace mirror), or `"unavailable"` (no data found — treated as a
  normal, informative response, not an error). Useful with zero operator configuration (falls
  back to the coarse `"workspace"` tier), richer once the durable event log is enabled.

### Compatibility
Zero change to any existing tool's schema — one net-new, additive MCP tool, **minor** per
`docs/FOUNDATION_FREEZE.md`'s own versioning policy. Zero change to `ObservabilityService`,
`ReplayEngine`, `TimelineStore`, or `EventHistoryStore` — `delegate_replay` calls
`ObservabilityService.replay()` exactly as it already existed, no reshaping, no new type. Full
design detail, the six-principle Platform Transport-Agnosticism Verification, and out-of-scope
boundaries in [ADR-0007](docs/adr/ADR-0007-mcp-replay-access.md). 281/281 tests passing (278
pre-existing + 3 new).

## [2.4.0] - 2026-07-16

Persistent Event History Sprint — implements
[ADR-0006](docs/adr/ADR-0006-persistent-event-history.md), an opt-in, append-only durable event
log (`EventHistoryStore`) that gives `ReplayEngine` a full-fidelity fallback tier surviving a
process restart, off by default. Six commits (an isolation-tested `EventHistoryStore`, wiring it
behind a config flag with default behavior unchanged, a file-count retention cap mirroring
`FileJobStore`'s pattern, a new `"durable"` tier added to `ReplayEngine`'s fallback chain, a real
E2E restart proof plus a measured benchmark, and a fix for `ObservabilityService.close()` never
being reachable from graceful shutdown). 271/271 tests passing (212 pre-existing + 59 new this
sprint).

### Added
- **`EventHistoryStore`** (`src/services/eventHistoryStore.js`): an append-only, per-job durable
  event log — one `<job-id>.jsonl` file per job under a configurable directory. Appended
  synchronously via `EventHistoryBridge` (`src/services/eventHistoryBridge.js`), a
  `RuntimeEventBus` wildcard subscriber that skips `OUTPUT_CHUNK` events (already durable via
  `stdout.log`/`stderr.log`). Unit-tested in isolation before being wired to anything else.
- **`eventHistory` / `eventHistoryDir` / `maxEventHistoryFiles` config fields**
  (`src/config/index.js`), env `CLAUDE_DELEGATE_EVENT_HISTORY` (default `"memory"`, accepts
  `"memory"`/`"file"`), `CLAUDE_DELEGATE_EVENT_HISTORY_DIR` (default `<project>/event-history`),
  and `CLAUDE_DELEGATE_MAX_EVENT_HISTORY_FILES` (default `100`) — oldest-completed job event logs
  beyond the cap are evicted first, never an in-flight job's, mirroring `pruneWorkspaces()`'s
  existing eviction pattern.
- **A new `"durable"` tier in `ReplayEngine.replay(jobId)`'s fallback chain**
  (`src/services/replayEngine.js`), sitting between `"runtime"` (`TimelineStore`, full fidelity,
  volatile) and `"workspace"` (coarse, synthesized from `metadata.json`): once a job's timeline
  has left `TimelineStore`'s retained window, `replay()` now checks `EventHistoryStore` first and
  returns full-fidelity, already-ordered events straight from its `<job-id>.jsonl` (source
  priority: `runtime` > `durable` > `workspace` > `unavailable`) — only falling to the coarse
  workspace synthesis when no durable log exists for the job either. `replay()`'s `source` field
  is now one of `"runtime"|"durable"|"workspace"|"unavailable"`.

### Fixed
- **`ObservabilityService.close()` was never reachable from anywhere.** `createMcpServer()`
  constructed the service and immediately discarded the return value, so `close()` (which
  unsubscribes it from `RuntimeEventBus`) was dead code — the service was never actually
  unsubscribed during shutdown. `createMcpServer()` now returns `{server, observabilityService}`
  instead of the bare server (its one caller, `src/cli/entry.js`, is updated accordingly; no test
  called it directly, so this is a safe shape change), and `registerShutdownHandlers()` calls
  `observabilityService?.close?.()` alongside `server.close()` in the shutdown path.

### Compatibility
Zero MCP schema change. Zero `ObservabilityService.replay()` signature change — the new
`"durable"` value is an addition to the existing `source` union with no change to `replay()`'s
call signature or to the other three values' meaning, which `docs/OBSERVABILITY_FREEZE.md`'s own
versioning policy (see its "Versioning policy" section) treats as the same class of change as
adding a new field with a safe default: additive, non-breaking, at most a minor version bump —
not the major-version, ADR-amendment-required class of change reserved for anything that breaks
an existing guarantee. Both new config fields default to today's exact behavior — an existing
deployment that never sets `CLAUDE_DELEGATE_EVENT_HISTORY` keeps `EventHistoryStore` off
entirely, byte-identical to before this sprint. Full design detail, amendment log, and
out-of-scope boundaries in [ADR-0006](docs/adr/ADR-0006-persistent-event-history.md). 271/271
tests passing (212 pre-existing + 59 new).

## [2.3.0] - 2026-07-16

Persistent Job Store Sprint — implements [ADR-0005](docs/adr/ADR-0005-persistent-job-store.md),
a file-backed, restart-durable alternative to the in-memory job store, opt-in via config and
off by default. Eight commits (an explicit `JobStore` interface, the `FileJobStore`
implementation with its own isolation tests, a cache-pollution-on-error fix found while
implementing it, wiring behind a config flag with default behavior unchanged, hydration
hardening against corrupted/torn files and non-terminal jobs, a stale-JSDoc fix found
while reviewing that hardening, config validation with backward-compatible defaults, and
real crash/restart end-to-end tests plus a measured benchmark). 212/212 tests passing
(185 pre-existing + 27 new this sprint).

### Added
- **`FileJobStore`** (`src/services/fileJobStore.js`): a file-backed implementation of the
  `JobStore` interface (`src/services/jobStore.js`'s `@typedef`, newly made explicit this
  sprint) — one JSON file per job under a configurable directory, atomic writes (temp file +
  `rename()`, never a direct write), and an in-memory cache hydrated once at construction so
  read performance matches `InMemoryJobStore`. On hydration, any non-terminal job
  (`queued`/`starting`/`running`) recovered from a prior process is deterministically
  rewritten to `failed` — there is no live subprocess left to ever complete it — and a
  corrupted or unrecognized-`storeVersion` file is skipped and logged, never thrown.
- **`jobStore` / `jobStoreDir` config fields** (`src/config/index.js`), env
  `CLAUDE_DELEGATE_JOB_STORE` (default `"memory"`, accepts `"memory"`/`"file"`) and
  `CLAUDE_DELEGATE_JOB_STORE_DIR` (default `<project>/job-store`). `mcpServer.js` constructs
  `new FileJobStore({dir: config.jobStoreDir})` only when `config.jobStore === "file"`;
  otherwise `JobManager`'s existing `InMemoryJobStore` default is untouched.

### Compatibility
Zero MCP schema change. No frozen contract touched (`RuntimeEventBus`, the Job lifecycle
enum, `ExecutionContext`'s shape, `docs/FOUNDATION_FREEZE.md`/`docs/OBSERVABILITY_FREEZE.md`
guarantees). Both new config fields default to today's exact behavior — an existing
deployment that never sets `CLAUDE_DELEGATE_JOB_STORE` keeps using `InMemoryJobStore`,
byte-identical to before this sprint. Full design detail, amendment log, and out-of-scope
boundaries in [ADR-0005](docs/adr/ADR-0005-persistent-job-store.md). 212/212 tests passing
(185 pre-existing + 27 new).

## [2.2.2] - 2026-07-15

Dogfooding Sprint — implements ADR-0004's recommended stdin-close self-shutdown fix
(deferred in 2.2.1), plus a bug found and fixed while resuming that work. Full sprint
evidence in `docs/superpowers/plans/dogfooding-stdin-shutdown.md`.

### Added
- **Stdin-close self-shutdown** (ADR-0004's recommended fix, implemented this sprint):
  the server now treats its own `stdin` ending as a third graceful-shutdown trigger,
  alongside `SIGINT`/`SIGTERM`, all routed through the same `shutdown()` path. Closes the
  scenario ADR-0004 root-caused: an MCP host disconnecting without delivering a signal
  this process can catch (unreliable on Windows) previously left the process orphaned
  indefinitely, still holding stale job state — the confirmed root-cause candidate for
  the known concurrent-dispatch job-tracking limitation. The shutdown wiring is
  extracted into an exported, dependency-injectable `registerShutdownHandlers()`
  (`src/cli/entry.js`), covered by 6 unit tests exercising all three triggers.
  **Live MCP-host (Claude Desktop) disconnect behavior is unverified** — the tests prove
  the mechanism fires correctly against injected fakes, not against a real host; that
  verification is explicitly out of scope for this sprint (see
  `docs/superpowers/plans/dogfooding-stdin-shutdown.md`'s Global Constraints).

### Fixed
- **`entry.js` started a live server as an import-time side effect.** Discovered while
  resuming this sprint's own plan: `main().catch(...)` ran unconditionally at module
  load, so merely importing `registerShutdownHandlers` for unit testing also started a
  real, `stdio`-connected MCP server that never exits — hanging `npm test` indefinitely
  and leaving orphaned `node.exe` processes (reproduced directly this sprint). The
  standard `import.meta.url`-based entrypoint-detection idiom does not work for this
  repo's structure (`server.js` re-exports `entry.js`, so `process.argv[1]` is always
  `server.js`'s path, never `entry.js`'s own). Fixed by making `entry.js` a pure module —
  it no longer calls `main()` itself; `server.js` (the documented, sole real entrypoint)
  now imports and calls it explicitly. Zero production behavior change, verified via MCP
  Inspector before and after.

### Compatibility
Zero MCP schema change. No frozen contract touched (`RuntimeEventBus`, the Job lifecycle
enum, `ExecutionContext`'s shape, `docs/FOUNDATION_FREEZE.md`/`docs/OBSERVABILITY_FREEZE.md`
guarantees — confirmed untouched via diff, not assumed). 185/185 tests passing
(179 pre-existing + 6 new).

## [2.2.1] - 2026-07-14

Critical Stability Sprint — one reproduced High-severity crash fix, plus an investigation
(ADR, no code change) into the known concurrent-`delegate_*`-dispatch job-tracking
limitation. Full sprint evidence in
`docs/superpowers/plans/critical-stability-sprint.md` and the sprint/review/value/
performance reports in the repository root.

### Fixed
- **Debug Mode's terminal launcher could crash the entire MCP server.**
  `launchDebugTerminal()` never attached an `"error"` listener to the spawned terminal
  process; an async spawn failure (a stale/broken terminal binary, a permissions/AV
  block, or any other reason the PATH-probe-detected command turned out not to actually
  be executable) fired an unhandled `"error"` event, which Node treats as an uncaught
  exception — killing the whole server process and every other in-flight job with it,
  not just the debug job that triggered it. Reproduced on a real machine before the fix.
  Fixed by attaching `child.once("error", () => {})`; a launch failure now surfaces as a
  normal job timeout (`DEBUG_TIMEOUT`, already existed) instead of a server crash.

### Investigated (no code change)
- **Duplicate `server.js` instances silently splitting job-tracking state** (the known
  limitation documented in the prior sprint's `SPRINT_REPORT.md`/`DELEGATE_VALUE_REPORT.md`):
  see [ADR-0004](docs/adr/ADR-0004-server-instance-lifecycle.md) for the full root-cause
  investigation. Confirmed: no startup single-instance guard exists, and the MCP SDK's
  `StdioServerTransport` never detects its own `stdin` closing to self-shut-down. A naive
  global instance lock is rejected as likely wrong (would break legitimate concurrent
  multi-window usage, since `stdio` transport is inherently per-client). The recommended
  fix (`stdin`-close self-shutdown) is deferred to a future wave pending verification of
  actual MCP-host process-lifecycle behavior. The operating mitigation is unchanged:
  avoid batching `delegate_*` MCP calls in a single message.

### Compatibility
Zero MCP schema change. No frozen contract touched (`RuntimeEventBus`, the Job lifecycle
enum, `ExecutionContext`'s shape, `docs/FOUNDATION_FREEZE.md`/`docs/OBSERVABILITY_FREEZE.md`
guarantees — confirmed untouched via diff, not assumed). 179/179 tests passing
(178 pre-existing + 1 new regression test for the crash fix).

## [2.2.0] - 2026-07-14

Production validation sprint — three verified-defect fixes, no architecture change. Full
sprint evidence in `docs/superpowers/plans/production-validation-sprint.md` and the
sprint/evaluation/value reports in the repository root.

### Added
- `ConsumerRegistry.pruneStale(maxAgeMs)`: removes every consumer whose `lastSeenAt` is older
  than `maxAgeMs`, returning the number removed. `getStatistics()`'s `totalRegistered` stays
  all-time (never decremented by pruning), matching `unregister()`'s existing semantics. No
  consumer wires this in yet — the primitive closes the previously-documented "no auto-expiry"
  gap; scheduling a sweep is future work (see `docs/releases/KNOWN_LIMITATIONS.md`).
- `delegate_cancel` now forcibly stops a running Debug Mode job. `invokeInDebugMode()` accepts
  the same `{signal}` production's `invoke()` already does; on abort it rejects promptly with
  an `AbortError`-named error and writes a `<logsDir>/cancel.request` sentinel, which
  `debugRunner.js` polls for and converts into an abort of its own spawned child — routing
  through the same `spawnAndCollect`/`shouldCleanupProcessTree`/`killWindowsProcessTree`
  tree-kill path production cancellation already uses. Debug OFF is unaffected.

### Fixed
- `MetricsCollector.getWorkspaceUsage()`'s artifact-count walk now reuses `isValidJobId()`
  (matching `pruneWorkspaces()`'s existing filter) instead of treating every subdirectory of
  `workspace/jobs/` as a job directory. A non-UUID directory manually placed there no longer
  has its contents miscounted as artifacts. `workspaceSizeBytes` is unchanged by design — it
  still sums the whole `jobs/` tree.

### Compatibility
Zero MCP schema change. No change to `RuntimeEventBus`'s `{publish, subscribe, subscribeAll}`
contract, the Job lifecycle enum, or `ExecutionContext`'s shape. 178/178 tests passing
(171 pre-existing + 7 new — 3 for `pruneStale`, 1 for the artifact-count filter, 3 for Debug
Mode cancellation including the abort-listener-leak regression test found in task review).

## [2.1.0] - 2026-07-14

Debug Mode (development only) — new, opt-in capability. Production behavior is unchanged when
`DELEGATE_DEBUG` is unset (the default) — every existing test still passes unmodified.

### Added
- **`DELEGATE_DEBUG=true`**: when set, `claudeCliService.invoke()` runs the real CLI
  invocation inside a visible, native terminal window instead of a hidden pipe-captured
  subprocess — Windows Terminal (falls back to `cmd.exe` if absent), the detected Linux
  terminal emulator, or `Terminal.app` on macOS.
- Full log set at `workspace/jobs/<job-id>/logs/`: `prompt.txt`, `command.txt`, `stdout.log`,
  `stderr.log`, `stream.jsonl` (every stream-json event, timestamped, in arrival order),
  `response.json`, `metadata.json`.
- The visible terminal displays a banner with the exact command, working directory, model,
  tools, and budget before running, and pauses ("Press Enter to close...") after finishing so
  fast-completing jobs' output doesn't vanish the instant the window would otherwise
  auto-close — found via a real live test, not assumed.
- Live progress notifications (the same `notifications/progress` behavior production already
  has) keep working in Debug Mode too: the parent process tails `stream.jsonl` and republishes
  `JobProgress` exactly as the hidden-pipe path does.
- New files: `src/services/debugTerminalLauncher.js`, `src/services/debugInvoke.js`,
  `src/debug/debugRunner.js`.
- 26 new tests covering: per-OS terminal detection, argv-safety (the prompt is structurally
  never part of any terminal-launch command line — verified, not just documented), Debug
  OFF/ON branching in `invoke()`, log-file creation and content, live stream-tailing and
  JobProgress publishing, timeout handling, and the runner's own log-writing logic (chunk
  reassembly, ordering, timestamps, failure handling).

### Security note
The core invariant this project has maintained throughout (`prompt` never touches a shell) is
preserved in Debug Mode: no terminal-launch command line ever contains the prompt text — only
job ids and filesystem paths this process itself constructed. The prompt reaches the actual
`claude` invocation solely via `invocation.json`, read by the runner script, which spawns
`claude.exe` the same shell-free way production always has. Full reasoning in
`src/services/debugTerminalLauncher.js`'s header comment and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#debug-mode-development-only).

### Known limitation
`delegate_cancel` cannot forcibly stop a Debug Mode job — the actual subprocess is owned by a
detached runner process (so a debug session survives if the MCP server restarts), so there is
no direct process handle to kill from the main server. The visible terminal must be closed
manually to actually stop it.

### Compatibility
Zero MCP schema change — this wave didn't need to re-verify Inspector, since nothing about the
6 tools' schemas changed; re-verified anyway as part of full validation. 171/171 tests passing
(145 pre-existing, unmodified, + 26 new).

## [2.0.0] - 2026-07-13

Official "v1.0.0" release milestone — release engineering only, no functional change.

### Versioning note
This wave's release engineering spec refers to it as "v1.0.0" (the first official/certified
release milestone — see
[docs/releases/RELEASE_NOTES_v1.0.0.md](docs/releases/RELEASE_NOTES_v1.0.0.md)). Because
`package.json` had already reached 1.9.0 through this project's prior wave-by-wave versioning,
setting it literally to `1.0.0` would be a semver regression against that existing history.
Bumping forward to **2.0.0** instead preserves strict version ordering while still marking
this as a major, deliberate milestone. "v1.0.0" throughout `docs/releases/` is the *milestone
name*; `2.0.0` is the actual `package.json`/npm-semver version. There is no functional
difference between v1.9.0 and v2.0.0 — this bump is release-engineering/documentation only.

### Added
- `docs/releases/` — `RELEASE_NOTES_v1.0.0.md`, `MIGRATION_GUIDE.md`, `SUPPORTED_FEATURES.md`,
  `KNOWN_LIMITATIONS.md`, `ROADMAP_v1.1.md`.
- `docs/RELEASE_CHECKLIST.md`.
- Root `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (previously missing), scoped
  honestly to this being a private, single-maintainer, no-remote repository rather than
  generic open-source boilerplate.

### Compatibility
Zero MCP schema change — all 6 tools re-verified byte-identical via Inspector. No production
source file changed in this wave (release engineering only; the one certification-report-
documented defect from the prior wave was already fixed then, not here).

### Added (Official Open Source Release follow-up, same 2.0.0 — not yet tagged/pushed)
- `LICENSE` (MIT).
- `SUPPORT.md`.
- `package.json`: `description`, `keywords`, `homepage`, `repository`, `bugs`, `license`,
  `author` — previously absent (the package had no remote/license decision until now).
- `docs/releases/RELEASE_NOTES_v2.0.0.md` — the canonical, self-contained GitHub Release notes
  (`RELEASE_NOTES_v1.0.0.md` is kept as the original milestone-named draft).
- Root `ROADMAP.md` — a short pointer into `docs/releases/ROADMAP_v1.1.md` (avoids duplicating it).
- `CONTRIBUTING.md`/`SECURITY.md` rewritten for an actual public repository (they previously
  assumed no remote existed); `CODE_OF_CONDUCT.md` upgraded from a placeholder to the real
  Contributor Covenant v2.1, now that this project is genuinely going public.

### Fixed (verified open-source-readiness blocker)
- **`DEFAULT_BIN` hardcoded the maintainer's real Windows username** in `src/config/index.js`
  and in `examples/desktop-config-snippet.json`'s example path — would have leaked personal
  information in a public repository. Fixed by deriving `DEFAULT_BIN` from `%APPDATA%` at
  runtime (mirrors the existing `baseCwd`/`process.cwd()` pattern already in the same
  function) instead of a literal path; the example config now uses a generic placeholder path.
  Zero behavior change on any machine with `APPDATA` set (the normal case).
- **The same leak existed in ~13 prior commits' history**, not just the current snapshot.
  Since no remote had ever been pushed, history was rewritten with `git filter-repo
  --replace-text` to redact the username from every historical blob before this project's
  first public push — a full local backup was taken first. Re-verified: zero occurrences of
  the real name anywhere in `git log --all -p` after the rewrite.

## [1.9.0] - 2026-07-13

Observability Platform, Phase 2 — final capability wave before v1.0
([ADR-0003](docs/adr/ADR-0003-observability-architecture.md),
[docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md)).

### Added
- **`ReplayEngine`** (`src/services/replayEngine.js`): reconstructs a job's event history for
  viewing — read-only, deterministic, zero side effects. Sources, in priority order: runtime
  (`TimelineStore`, full fidelity) → workspace (`metadata.json`, coarse, entries marked
  `synthetic: true`) → `unavailable`. Never duplicates stored data — only reads.
- **`SnapshotBuilder`** (`src/services/snapshotBuilder.js`): immutable point-in-time snapshots
  (`{takenAt, metrics, activeJobs}`) via `structuredClone()` + recursive `Object.freeze()` —
  every level of a snapshot is frozen, not just the top level. Pull-only, no background timer.
- **`ConsumerRegistry`** (`src/services/consumerRegistry.js`): registration, unregistration,
  health (`active`/`registeredAt`/`lastSeenAt`), statistics (`activeCount`/`totalRegistered`),
  and consumer metadata — pure in-memory bookkeeping, no transport layer.
- **`MetricsCollector.getActiveJobs()`**: new event-derived read of currently non-terminal
  jobs (`{jobId, status, queuedAt, startedAt}`), sourced entirely from the same
  RuntimeEvent-driven bookkeeping `getMetrics()` already used — never queries `JobManager`.
  Backing this required refactoring the collector's internal `queuedAt` map into a `jobMeta`
  map kept alive for a job's whole non-terminal lifetime (previously cleared right after the
  "starting" transition); `getMetrics()`'s output is unchanged, verified by the full pre-
  existing metricsCollector test suite passing unmodified.
- `ObservabilityService` gains `replay()`, `getSnapshot()`, `registerConsumer()`,
  `unregisterConsumer()`, `touchConsumer()`, `listConsumers()`, `getConsumerHealth()`,
  `getConsumerStatistics()` — still zero MCP exposure, no Dashboard/REST/plugin consumes any
  of this yet.
- 39 new tests (`replayEngine`, `snapshotBuilder`, `consumerRegistry`, plus 6 new
  `observabilityService` integration/concurrency tests covering the full new surface
  end-to-end).
- **`docs/OBSERVABILITY_FREEZE.md`**: freezes Observability's public contracts (structural,
  not implementation) ahead of v1.0.

### Fixed (found during this wave's review, evidence-based)
- **`ConsumerRegistry` metadata aliasing**: caller-supplied `metadata` was stored and returned
  by reference, not cloned — mutating a `list()` result's `.metadata`, or the caller's own
  original object after `register()`, silently corrupted the registry's internal state.
  Fixed by shallow-cloning `metadata` on both the way in (`register()`) and the way out
  (`list()`). Two regression tests added.

### Compatibility
Zero MCP schema change — all 6 tools re-verified byte-identical via Inspector.
`RuntimeEventBus`, `JobManager`, `Workspace`, streaming, and Phase 1 Observability behavior
are all untouched; `MetricsCollector.getMetrics()`'s output shape and values are unchanged
despite the internal `jobMeta` refactor (verified by the unmodified Phase 1 test suite).

## [1.8.0] - 2026-07-13

ADR-0003 Approval & Observability Platform, Phase 1
([ADR-0003](docs/adr/ADR-0003-observability-architecture.md)).

### Added
- **ADR-0003 accepted**, amended during review with five mandatory sections closing a gap in
  the original Proposed draft — Passive Observation Rule, Dependency Direction, Non-Goals,
  Data Ownership, Extension Rules — each stating as an explicit, checkable rule what the
  original draft only implied through component descriptions.
- **`ObservabilityService`** (`src/services/observabilityService.js`): a second, independent
  `RuntimeEventBus.subscribeAll()` consumer, read-only by construction — it holds no reference
  to `JobManager`, `claudeCliService`, or `bus.publish`, so nothing in this layer can cancel a
  job, execute a command, or mutate Workspace, even by accident. `getMetrics()`/`getTimeline()`
  are its entire public surface for this phase.
- **`MetricsCollector`** (`src/services/metricsCollector.js`): O(1) incremental aggregates —
  queued/running/completed/failed/cancelled job counts, average/maximum runtime, average queue
  wait, streaming-event/output-chunk/total-event counters, progress rate. Workspace size and
  artifact count are the one on-demand exception (no stored history, computed from disk via
  `workspaceManager`'s own `getWorkspaceRoot()` when `getMetrics()` is called).
- **`TimelineStore`** (`src/services/timelineStore.js`): per-job, append-only event history in
  deterministic (recorded) order, filterable by type/timestamp, bounded by
  `maxTimelineHistory` with the same oldest-terminal-first eviction shape `JobManager`/
  `workspaceManager` already use — an in-flight job's timeline is never evicted.
- Wired into `mcpServer.js` alongside the existing `workspaceEventBridge` subscriber — not
  exposed via any MCP tool yet (no schema change).
- 27 new tests: `metricsCollector.test.js` (incremental math, workspace-usage queries),
  `timelineStore.test.js` (ordering, filtering, retention), `observabilityService.test.js`
  (full lifecycle integration against a real `JobManager`, concurrency, retention end-to-end,
  and two explicit Passive-Observation-Rule regression tests: no mutator methods exposed, and
  observing a job never affects `JobManager`'s own state).

### Not implemented (deliberately, per this wave's scope)
`ReplayEngine`, `SnapshotBuilder`, `ConsumerRegistry`, and any Dashboard/API surface remain
ADR-0003 design only — Phase 2.

### Compatibility
Zero MCP schema change — all 6 tools re-verified byte-identical via Inspector.
`RuntimeEventBus`, `JobManager`, `Workspace`, and streaming are untouched.

## [1.7.0] - 2026-07-13

Streaming Activation & Protocol Validation
([ADR-0002](docs/adr/ADR-0002-streaming-and-event-architecture.md#observed-protocol-v170--real-captures-not-assumptions) —
"Observed protocol" section).

### Added
- **Real protocol capture**: two live `claude -p --output-format stream-json --verbose`
  captures (one auth-failure path, one successful task on a real account) used to validate
  ADR-0002's assumptions before activating anything. Key finding: the terminal `type:"result"`
  line is field-for-field identical to the old non-streaming `--output-format json` output —
  confirmed, not assumed, in both captures.
- **`--output-format stream-json --verbose` is now `buildArgs()`'s default.** (`--verbose` is
  required by the CLI itself when streaming — discovered via a real error message.)
- **`createStreamJsonTracker()`** (`claudeCliService.js`): incrementally parses stdout via
  `streamJsonParser.js`, captures the terminal result line to reconstruct `raw` for
  `parseResult()` (gracefully falls back to `parsed: null` if none was ever seen), and
  publishes real `JobProgress` for the two categories a capture confirmed both exist and are
  useful: `system/thinking_tokens` (live token-count ticks during extended thinking) and
  `assistant` events carrying a `text` content block. Deliberately does not surface hook/
  session bookkeeping, rate-limit telemetry, or the model's raw `thinking` content.
- 10 new tests (`tests/claudeCliServiceStreamJson.test.js`) using the real observed line
  shapes: progress-per-category, silence for non-progress types, malformed-line recovery,
  chunk-boundary reassembly, concurrent-job isolation, standalone (no-bus) safety.
- **Live end-to-end verification**: a real `delegate_task` call produced 17 genuine
  `notifications/progress` pushes (`"Job running"` → 15× `"Thinking… (~N tokens)"` → the
  actual response text → `"Job completed"`) while returning a response byte-compatible with
  the pre-streaming format.

### Also observed (documented, not acted on)
- `result.subtype` can be `"error_max_budget_usd"` with an `errors: [...]` array — the CLI's
  own cost tracking can spend slightly over `max_budget_usd` before stopping. Pre-existing
  CLI behavior, not a regression from this change; noted in the ADR's risk table.
- Not yet observed: `tool_use`/`tool_result` content blocks, multi-turn behavior. The tracker
  only branches on confirmed shapes — anything else is silently skipped, never guessed at.

### Compatibility
Zero MCP schema change — all 6 tools re-verified byte-identical via Inspector. `delegate_task`
response shape verified twice: once via the full test suite (95/95 passing), once live
against the real CLI. `RuntimeEventBus` contract, `FOUNDATION_FREEZE.md`, and `JobManager`'s
public methods untouched.

## [1.6.0] - 2026-07-13

RuntimeEventBus & Streaming Foundation
([ADR-0002](docs/adr/ADR-0002-streaming-and-event-architecture.md), amended in this wave —
see its Amendment Log).

### Added
- **`RuntimeEventBus`** (`src/services/runtimeEventBus.js`): implementation-independent
  `{publish, subscribe, subscribeAll}` contract; default backed by `node:events`, but that
  import is confined to this one file — no other module depends on `EventEmitter` directly.
  Per-listener isolation (a throwing subscriber is logged and skipped, never affects siblings
  or the publisher).
- **10 event types** (`src/models/runtimeEvent.js`): `JobQueued`, `JobStateChanged` (replaces
  the originally-proposed `JobStarting`/`JobRunning` — a state transition isn't progress, but
  `starting`/`running` don't need distinct types either, since neither carries a distinct
  payload), `JobProgress`, `OutputChunk` (replaces `StdoutReceived`/`StderrReceived` — same
  shape, differ only by a `stream` field), `JobCompleted`, `JobFailed`, `JobCancelled`,
  `ArtifactCreated`, `WorkspaceCreated`, `WorkspaceDeleted`. Every transition publishes
  exactly one event type — mechanically verifiable "no duplicate events" (see tests).
- **`JobManager`** now publishes a `RuntimeEvent` at every transition (`bus` is
  constructor-injected, defaulted if not given — fully backward compatible with every
  existing test construction).
- **`execFile` → `spawn()` migration** in `claudeCliService`: incremental stdout/stderr via
  `OutputChunk` events, manually re-implemented `maxBufferBytes` enforcement (spawn has no
  native `maxBuffer`), preserved `invoke()`'s resolved shape and error semantics exactly.
  Transport mechanics extracted into a new `spawnAndCollect()`, decoupled from
  claude-specific `buildArgs()` — this is what made it possible to test real `spawn()`
  behavior (abort, timeout-equivalent kill, maxBuffer, ENOENT) against `node` itself instead
  of only through stubs.
- **`streamJsonParser.js`**: incremental newline-delimited JSON parser for
  `stream-json`, built and unit-tested (multi-chunk line reassembly, malformed-line handling)
  but **not wired into the live `--output-format` argument** — see Deferred below.
- **Workspace is now bus-driven** (`workspaceEventBridge.js`): terminal-side persistence
  (`persistJobArtifacts`/`pruneWorkspaces`) subscribes to `JobCompleted`/`JobFailed`/
  `JobCancelled` instead of being called directly from `delegationService`.
- **MCP progress notifications** (`mcpProgressAdapter.js`): `delegate_task` forwards its
  job's lifecycle events as `notifications/progress` when the caller supplies
  `_meta.progressToken` (verified against the installed MCP SDK's actual API). Purely
  additive — a caller that doesn't request progress sees no behavior change.
- 43 new tests: 6 new files (`runtimeEventBus`, `jobManagerEvents` — ordering/no-duplicates/
  concurrency, `streamJsonParser`, `claudeCliServiceSpawn` — 11 tests against real child
  processes, `workspaceEventBridge`, `mcpProgressAdapter`) plus 2 new cases in the existing
  integration suite (progress-notification forwarding, with/without a `progressToken`).
  Total: 85 tests, up from 42.

### Deliberately deferred (see ADR-0002 for full reasoning)
- `stream-json` is not the live `--output-format` — the parser is built and tested, but
  switching the argument a frozen response shape depends on isn't verifiable against a real,
  logged-in CLI session in this environment, and an unverified guess isn't an acceptable risk.
- `createJobWorkspace()` stays a direct call, not bus-wired — a **security-motivated**
  boundary: it needs the unredacted `ExecutionContext` (`environment`/`process.env`), which
  must never be duplicated into `JobManager`'s job record (`job.metadata` is returned
  verbatim in `delegate_status`'s MCP response).
- `OutputChunk` is not forwarded to MCP progress notifications — too high-frequency for a
  protocol channel; no production subscriber for it exists yet at all.
- Dashboard and plugin consumers: explicitly out of scope, "just" future bus subscribers.

### Compatibility
Zero change to any MCP tool schema — all 6 tools re-verified byte-identical via Inspector
against the pre-wave snapshot. `delegate_task`/`delegate_submit` response shapes unchanged.
Live end-to-end run against the real `claude.exe` confirmed the full pipeline (spawn,
OutputChunk, workspace persistence, stderr capture) still works correctly. 85 tests total,
all passing.

## [1.5.0] - 2026-07-13

Foundation Freeze certified ([docs/FOUNDATION_FREEZE.md](docs/FOUNDATION_FREEZE.md)) plus the
Workspace & Artifact wave ([ADR-0001](docs/adr/ADR-0001-workspace-and-artifact-architecture.md)).

### Added
- **Workspace persistence layer** (`src/services/workspaceManager.js`): every job gets
  `<workspaceRoot>/jobs/<job-id>/{metadata.json, context.json, stdout.log, stderr.log,
  result.json, artifacts/}`, written once at settle time as a best-effort mirror of
  `JobManager`'s state — never a second source of truth. Wired into the shared
  `delegationService.submitDelegation()`, so both `delegate_task` and `delegate_submit` get
  it identically with no duplicated logic.
- Two new config fields: `workspaceRoot` (`CLAUDE_DELEGATE_WORKSPACE_DIR`, default
  `<project>/workspace`) and `maxWorkspaceHistory` (`CLAUDE_DELEGATE_MAX_WORKSPACE_HISTORY`,
  default 100) — oldest completed workspaces beyond the cap are pruned automatically, never
  touching an in-flight job's directory.
- `claudeCliService.invoke()`'s resolved result gains a `stderr` field (previously discarded
  entirely) so it can be persisted to `stderr.log`.
- 13 new tests: `tests/workspaceManager.test.js` (unit — path-traversal rejection, context
  redaction, artifact writes, pruning) and 5 new integration tests (workspace creation,
  concurrent jobs get isolated directories, failed/cancelled jobs persist correctly, pruning
  under load).

### Fixed (test hygiene, found while wiring this wave)
- The integration test suite was writing real job directories into the project's own
  `workspace/` folder (no `workspaceRoot` override) — fixed by pointing tests at an isolated
  `os.tmpdir()` location, cleaned up via `node:test`'s `after()`.

### Security
- `isValidJobId()` rejects any non-UUID string before it's used to build a filesystem path
  (defense in depth — job ids are always `JobManager`-generated `randomUUID()` output).
- `context.json` never contains `ExecutionContext.environment` (`process.env`) — redacted to
  a placeholder string, since persisting it verbatim would write secrets to disk.
- All workspace I/O is wrapped to fail safe: a write/prune error is logged and swallowed,
  never surfaces as a tool error or affects a job's actual outcome.

### Compatibility
Zero change to any MCP tool schema, `ExecutionContext`'s shape, or `JobManager`'s public
methods — re-verified via Inspector (`tools/list` byte-identical to the pre-wave snapshot)
and a live end-to-end `delegate_task` call (workspace files confirmed written for a real,
non-stubbed job).

## [1.4.3] - 2026-07-13

Zero-defect hardening pass (second consecutive audit; see 1.4.2 for the first).

### Fixed
- **Duplicated model/effort constants**: `["haiku","sonnet","opus","fable"]` and
  `["low","medium","high","xhigh","max"]` were each hand-typed twice — once in
  `schemas.js`'s zod enum, once in `delegateModelsHandler.js`. Exported `MODELS`/`EFFORTS`
  from `schemas.js` as the single source; the handler now imports them. Regression test
  asserts the schema's enum options and the handler's listing both derive from the same array.
- **Dead config field**: `config.readonlyTools` was computed by `loadConfig()` but never
  read anywhere (`schemas.js` already imported the `READONLY_TOOLS` constant directly) —
  same class of defect as `maxBufferBytes` fixed in 1.4.2. Removed.

### Verified, not changed
Re-audited for TODO/FIXME/HACK markers, `shell: true`, `eval`/`exec`/insecure-randomness
patterns, and unreachable exports — none found. `DelegateError` (base class of `ConfigError`)
has no direct call sites but is an active, used superclass, not dead code.

## [1.4.2] - 2026-07-13

Self-Harness-style audit of the current implementation (no PR existed to review — see below).

### Fixed
- **Documentation drift in live tool descriptions**: `delegate_status`, `delegate_history`,
  `delegate_cancel`, and the shared `job_id` field description still said "delegate_task job"
  and omitted the `starting` status — stale since `delegate_submit` and `starting` were added
  in 1.4.0. These are LLM-facing strings read via `tools/list`, not just human docs. Fixed;
  `delegate_task`'s own schema re-verified unchanged.
- **Dead/duplicated config**: `config.maxBufferBytes` was computed but never read —
  `claudeCliService.js` had its own separate hardcoded `MAX_BUFFER_BYTES` constant instead
  (confirmed via grep). Extracted a testable `buildExecOptions()` so config is the actual
  source of truth again, with a regression test proving it.
- **Inconsistent error-handling coverage in `JobManager._run()`**: the `starting` transition's
  store write happened before the try/catch that covers every other transition, so a store
  failure there would be an unhandled rejection (`_drain()` calls `_run()` without awaiting or
  `.catch()`ing it) — currently benign only because `InMemoryJobStore` never throws, but the
  architecture explicitly anticipates a swappable/persistent store that could. Moved inside
  the try; regression test simulates a throwing store and confirms the job now lands in
  `failed` instead of hanging silently at `queued`.
- **`_trimHistory()` duplicated work**: re-called `store.list()` (O(n)) on every eviction-loop
  iteration instead of tracking a decrementing count, making a bulk eviction O(n²). Fixed to
  a single O(n) pass; also closes a real test-coverage gap — this eviction feature (since
  1.2.0) had zero prior tests.

### Note
`/review`'s invocation named a GitHub PR `Use` to diff — no such PR exists (repo has no
remote; confirmed via `git remote -v`/`gh pr view`). Reviewed the current implementation
(local commits) instead, per user confirmation.

## [1.4.1] - 2026-07-13

### Fixed
- **`max_budget_usd` accepted zero/negative values** — added `.positive()` to the zod schema
  (`delegate_task`/`delegate_submit`, shared shape). Minor, backward-compatible schema
  tightening: default unchanged, no legitimate caller was ever relying on a non-positive
  budget. Verified via `tools/list` diff — only this field's JSON Schema changed.
- **Orphaned subprocess on Windows cancellation/timeout** — killing `claude.exe` (via
  `AbortSignal` or the CLI call's `timeout`) did not kill any child process it had spawned
  (Windows has no POSIX process groups), which could leak a running process past job
  cancellation. `claudeCliService.invoke()` now runs a best-effort `taskkill /t /f` on the
  whole process tree when this applies (win32 + aborted/force-killed) via the new, unit-tested
  `shouldCleanupProcessTree()` predicate.

## [1.4.0] - 2026-07-13

### Added
- **`delegate_submit`**: same input schema as `delegate_task`, but returns immediately
  (`{ success, job_id, status }`) instead of waiting for the job to finish.
- **`ExecutionContext`** (`src/models/executionContext.js`): the single object
  `claudeCliService.buildArgs()`/`invoke()` now consume (model, effort, timeoutMs,
  workingDirectory, allowedTools, trustAll, maxBudgetUsd, metadata, environment) — built once
  by the new shared `src/services/delegationService.js`, used by both `delegate_task` and
  `delegate_submit` so neither duplicates context-building or job-submission logic.
- **`starting` job status**, inserted between `queued` and `running`. `running` is now
  reached via a real signal — Node's child_process `'spawn'` event — not assumed the instant
  a job is dequeued.
- **`phase` / `progressMessage`** fields on every job (static per-phase text, e.g.
  `"executing"` / `"Executing claude CLI"`). No streaming — just metadata ready for a future
  incremental-progress feature to update without a schema change.
- **Continuous runtime tracking**: `models/job.js`'s `deriveRuntimeMs()`/`toJobView()` compute
  live elapsed time for in-flight jobs (verified end-to-end: `runtime=15ms` while running,
  final `runtimeMs=5091` once completed) instead of `null` until the job finishes.
- `delegate_cancel` now also aborts jobs in the `starting` phase (previously only
  `queued`/`running` were handled).
- Integration test suite (`tests/asyncExecution.integration.test.js`): full submit → status →
  history → cancel(queued) → cancel(running) → completed lifecycle, plus explicit checks that
  `delegate_task` still blocks with an unchanged response shape and that `delegate_submit`
  never blocks regardless of task duration.

### Changed
- `claudeCliService.buildArgs()`/`invoke()` signature changed from `(input, config)` to
  `(prompt, context, config)` — an internal refactor to consume `ExecutionContext`, not a
  behavior change. `delegate_task`'s external contract (name, schema, response shape,
  blocking behavior) is unchanged and was re-verified via `tools/list` diffed byte-for-byte
  against the Sprint 3 snapshot, plus a live end-to-end run.

## [1.3.0] - 2026-07-13

### Added
- Four new MCP tools, all backed by the existing `JobManager`/`claudeCliService` (no
  duplicated logic): `delegate_status` (look up a job by id), `delegate_history` (list
  recent jobs, filterable by status), `delegate_models` (list model tiers, fallbacks,
  effort levels, defaults), `delegate_cancel` (cancel a queued or running job).
- `delegate_task` now submits through the shared `JobManager` instead of calling
  `claudeCliService` directly, so the new tools have real job data to report. Its external
  contract — name, schema, response shape, synchronous blocking behavior — is unchanged;
  verified via `tools/list` and an end-to-end multi-tool session before/after.
- `JobManager.waitForCompletion()` and history eviction (`maxJobHistory`, default 500, via
  `CLAUDE_DELEGATE_MAX_JOB_HISTORY`) so the in-memory job store doesn't grow unbounded.

### Fixed
- **Command injection risk removed.** The CLI was being spawned via the `claude.cmd` shim
  with `shell: true` (required to work around Windows EINVAL on `.cmd` files), which passed
  `prompt` — arbitrary, caller-controlled text — through cmd.exe without safe escaping
  (flagged by Node's own `DEP0190` warning). Fixed by spawning the real `claude.exe`
  directly with no shell at all; `CLAUDE_DELEGATE_BIN` now defaults to that executable.
  Regression test added (`buildArgs keeps prompt as a single literal argv entry`).

## [1.2.0] - 2026-07-13

### Added
- Internal job manager (`src/services/jobManager.js`): submit/get/list/cancel, in-memory
  `Job` records (`src/models/job.js`) with status lifecycle (queued/running/completed/
  failed/cancelled), timestamps, runtime, exit code, metadata, result/error.
- Bounded concurrency queue (`CLAUDE_DELEGATE_MAX_CONCURRENT_JOBS`, default 2).
- Storage seam for future persistence (`src/services/jobStore.js`'s `InMemoryJobStore`) —
  swap the `store` dependency to persist without touching `JobManager`.
- `claudeCliService.invoke()` now accepts an `AbortSignal` so a cancelled job can actually
  kill its subprocess.
- Unit tests for the full job lifecycle, cancellation (queued and running), and concurrency
  limiting (`tests/jobManager.test.js`).

### Unchanged
- `delegate_task` remains fully synchronous and is not wired to the job manager yet — no new
  MCP tool was added this sprint.

## [1.1.0] - 2026-07-13

### Changed
- Refactored into a layered `src/` structure (server/handlers/services/cli/config/models/utils/logging/validation). No change to the `delegate_task` tool schema, defaults, or observed behavior — verified via `tools/list`/`tools/call` before and after.
- `server.js` is now a thin backward-compatible shim; `claude_desktop_config.json` does not need to change.

### Added
- Structured JSON logging to stderr (`src/logging/logger.js`).
- Startup config validation (`src/validation/configValidation.js`).
- Non-blocking health check for the configured `claude` binary (`src/server/health.js`).
- Graceful shutdown on SIGINT/SIGTERM.
- `VERSION` constant sourced from `package.json`.
- Unit tests (`node --test`) for arg-building, config validation, and the input schema.

## [1.0.0] - 2026-07-12
- Initial single-file `delegate_task` MCP server.
