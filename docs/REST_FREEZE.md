# REST Freeze

Status as of `v2.8.0` (`ADR-0011` accepted and fully implemented, WP0–WP6). This document
freezes REST's **HTTP contract** — paths, methods, status codes, JSON body shapes, query-param
semantics, the auth-header contract, CORS policy, default bind address. It does not re-govern
`DelegationService`/`ObservabilityService`'s own contracts (those stay under
`FOUNDATION_FREEZE.md`/`OBSERVABILITY_FREEZE.md`); a route can change without any MCP tool
changing, and vice versa. Sibling to `docs/FOUNDATION_FREEZE.md` and
`docs/OBSERVABILITY_FREEZE.md`, which this document does not restate or override.

REST is entirely **opt-in**: a separate, standalone process (`src/cli/restEntry.js`), never a
flag on the existing stdio MCP process (`src/cli/entry.js`). An MCP-only deployment that never
runs `restEntry.js` sees zero behavioral change from this document's existence.

## Frozen route table

Base path `/v1`. All bodies `application/json`. Every route requires
`Authorization: Bearer <token>`, including reads. Pinned by `tests/restRoutes.contract.test.js`
against a direct service call for every route — a full-body comparison except where the response
legitimately contains a value no direct call could predict in advance (`POST /jobs`'s random
`job_id`, `GET /snapshot`'s live `takenAt`), where the deterministic fields are compared instead.

| Method | Path | Service call (verbatim) | Status | Response body |
|---|---|---|---|---|
| `POST` | `/v1/jobs` | `delegationService.submit(body, "rest")`, then `getJob(jobId)` | `202` | `{job_id, status}`; `Location: /v1/jobs/{job_id}` header |
| `GET` | `/v1/jobs/:id` | `delegationService.getJob(id)` | `200` / `404` | `200` = `JobView` verbatim (+ `Retry-After: 2` header while non-terminal); `404` = `{error: {code: "JOB_NOT_FOUND", ...}}` |
| `GET` | `/v1/jobs?status=&limit=` | `delegationService.listJobs({status, limit})` | `200` | `{jobs: JobSummary[], count, limit}` — `limit` defaults to 20 when omitted, clamped to 500 (`MAX_LIST_LIMIT`) when it exceeds it, rejected (`400 INVALID_QUERY_PARAM`) only when non-numeric or ≤0 |
| `DELETE` | `/v1/jobs/:id` | `delegationService.cancelJob(id)` (+ `getJob` before/after) | `200` / `404` / `409` | `200` = `{job_id, status}` (includes the idempotent repeat-DELETE-on-already-cancelled case); `404` = `JOB_NOT_FOUND`; `409` = `{error: {code: "JOB_NOT_CANCELLABLE", ...}}` |
| `GET` | `/v1/jobs/:id/replay` | `observabilityService.replay(id)` | `200` always | `{source, timeline}` — never `404`, even `source: "unavailable"` (`ADR-0007` parity) |
| `GET` | `/v1/jobs/:id/timeline?type=&since=` | `observabilityService.getTimeline(id, {type, since})` | `200` | raw `TimelineEntry[]` — **no `source` field**, unlike `/replay` (disclosed asymmetry, `ADR-0011` Filtering); `type` validated against `EVENT_TYPES`, invalid → `400 INVALID_QUERY_PARAM` |
| `GET` | `/v1/metrics` | `observabilityService.getMetrics()` | `200` | `Metrics` verbatim (`OBSERVABILITY_FREEZE.md`) — **process-scoped**, see Compatibility guarantees |
| `GET` | `/v1/snapshot` | `observabilityService.getSnapshot()` | `200` | `Snapshot` verbatim (`OBSERVABILITY_FREEZE.md`) |
| `GET` | `/v1/models` | `buildModelsInfo(config)` (`src/models/schemas.js`) | `200` | `{models, efforts, defaults}` — structured data only, no MCP text formatting |

`delegate_task`'s blocking behavior has **no REST mirror** — `POST /v1/jobs` always behaves like
`delegate_submit` (async, `202`, never blocking). Client polls `GET /v1/jobs/:id` at its own
cadence, honoring `Retry-After` while non-terminal.

## Frozen error model

One JSON shape across every route: `{error: {code, message, details?}}`. `details` (the
underlying `ZodError`'s `issues`) is appended only for `INVALID_INPUT`.

| Condition | Status | `code` |
|---|---|---|
| Unknown job id (`GET`/`DELETE /v1/jobs/:id`) | 404 | `JOB_NOT_FOUND` |
| No such route | 404 | `NOT_FOUND` |
| `cancelJob()` returns `false`, job genuinely terminal | 409 | `JOB_NOT_CANCELLABLE` |
| Invalid submit body (`ZodError` from `DelegateTaskInputSchema.parse()`) | 400 | `INVALID_INPUT` (+ `details`) |
| Bad query param (`status`/`limit`/`type` enum) | 400 | `INVALID_QUERY_PARAM` |
| Malformed JSON body | 400 | `MALFORMED_BODY` |
| Request body exceeds the configured limit | 413 | `PAYLOAD_TOO_LARGE` |
| Missing or wrong bearer token | 401 | `UNAUTHORIZED` |
| Unexpected internal error | 500 | `INTERNAL_ERROR` (generic message, never `err.message`/`err.stack`) |

A malformed (non-UUID-shaped) `:id` is **indistinguishable from an unknown one** — both produce
`404 JOB_NOT_FOUND` — never a `400`, per `DelegationService`'s shared `isValidJobId()` guard
(`ADR-0011` Compatibility with DelegationService).

## Frozen authentication contract

- Single shared-secret bearer token, `Authorization: Bearer <token>` header only — never a
  query string.
- Resolved at boot (`resolveOrGenerateRestToken`, `src/rest/auth.js`): `CLAUDE_DELEGATE_REST_TOKEN`
  verbatim if set; otherwise the token already persisted at `CLAUDE_DELEGATE_REST_TOKEN_FILE`
  (default `<project>/.delegate-rest-token`) if that file exists; otherwise a freshly generated
  `crypto.randomBytes(32)` token, persisted to that file for the next boot.
- Compared with `crypto.timingSafeEqual` after an explicit length check — never `===`.
- Required on **every** route, including reads.
- The token value is never logged — only that one was generated and where.
- Distinct from the Anthropic billing/subscription credential — this token authenticates local
  callers of this tool's own REST listener, nothing else.

## Frozen bind/network defaults

- Default host: `127.0.0.1` (`CLAUDE_DELEGATE_REST_HOST`) — never `0.0.0.0` without an explicit
  operator opt-in.
- Default port: `8787` (`CLAUDE_DELEGATE_REST_PORT`).
- No CORS allowance by default — no `Access-Control-Allow-*` header is ever set, no `OPTIONS`
  route is registered. Default-deny.
- Request body size limit: `1 MiB` default (`CLAUDE_DELEGATE_REST_MAX_BODY_BYTES`), enforced via
  a synchronous `Content-Length` gate on every route (413 before any route logic runs,
  `Connection: close`) plus a streaming bound scoped to `POST /v1/jobs`'s own body-reading
  handler (`streamBoundedBody`, `req.socket.destroy()` on overflow).
- Graceful shutdown: `CLAUDE_DELEGATE_REST_SHUTDOWN_GRACE_MS` (default 5000) → force-cancel any
  still non-terminal job → `CLAUDE_DELEGATE_REST_SHUTDOWN_FORCE_EXIT_MS` (default 2000) bounded
  wait for settlement → exit. Triggered by `SIGINT`/`SIGTERM` only — no `stdin`-close trigger
  (REST has no client pipe to watch, unlike stdio MCP).

## Compatibility guarantees

- **Zero MCP schema impact.** `docs/FOUNDATION_FREEZE.md`'s nine frozen tool schemas, execution
  contract, job lifecycle, and `ExecutionContext` contract are all unaffected — REST is purely
  additive, calling the same two already-frozen services (`DelegationService`,
  `ObservabilityService`) every MCP handler already calls.
- **REST and MCP are separate job universes by default.** `createDelegationBackend()`
  constructs a fresh `JobManager`/`RuntimeEventBus` per call; `restEntry.js` and `entry.js` each
  call it independently, sharing no module-level state (verified: `tests/
  fileJobStoreCoexistence.characterization.test.js`, `tests/delegationBackend.test.js`'s
  independent-instance-isolation test). `config.jobStore="file"` (`ADR-0005`) makes both
  processes see any job that existed on disk *as of their own last hydration* — not live
  cross-process visibility.
- **`getMetrics()`/`getSnapshot()` are process-scoped.** A REST `GET /v1/metrics` call reports
  only REST's own process's accumulated counters since its own boot — a different counter set
  from a concurrently running MCP session's `delegate_metrics`, `jobStore=file` or not. This is
  the single most likely user-visible surprise if undocumented — see
  `docs/releases/KNOWN_LIMITATIONS.md`.
- **Disclosed REST/MCP behavioral divergences** (deliberate, not bugs):
  - A repeat `DELETE` on an already-cancelled job is idempotent (`200`) under REST; MCP's
    `delegate_cancel` treats the identical state as a failure (`isError: true`).
  - REST's `1 MiB` request body limit has no MCP mirror — `DelegateTaskInputShape.prompt` (MCP)
    is a bare `z.string()` with no length limit.
  - `delegate_task`'s blocking behavior has no REST mirror (see Frozen route table).
- **One shared `DelegationService` instance, proven both directions**: `tests/
  restIntegration.test.js`'s shared-instance-parity test submits via REST, observes via a real
  MCP handler wired to the same `backend.delegationService`, cancels via MCP, and observes the
  cancellation via REST — the "same backend, two transports" claim, proven, not asserted.

## Extension points

- **New routes**: add one entry to `buildRouteTable()` (`src/cli/restEntry.js`) plus a handler
  in the relevant `src/rest/routes/*.js` factory — additive, non-breaking, as long as it calls
  only `DelegationService`/`ObservabilityService` (`ADR-0011` Responsibilities).
- **Cursor-based pagination**: `GET /v1/jobs`'s `limit`/`count` shape has no cursor field in v1
  — deferred until `DelegationService.listJobs()` itself grows one (a service-layer decision,
  not a REST-route one).
- **`type`/`since` filtering on `/replay`**: deliberately not added — `/timeline` is the
  additive, REST-only endpoint for this instead, keeping `/replay`'s cross-transport contract
  byte-identical between MCP and REST.
- **SSE/WebSocket streaming**: explicitly deferred to Stage 3 (Dashboard), when
  `subscribeToJob()` gets its first concrete consumer (`ADR-0011` Streaming).
- **Dashboard (Stage 3)**: designed to consume this exact route table as a thin UI — no route
  shape here is Dashboard-specific.

## Non-goals

Per `ADR-0011`'s own Non-goals: not a second execution engine, not multi-tenant, not a
public-internet API (binds `127.0.0.1` by default), not a streaming/push transport, not
rate-limited/quota-managed, not horizontally scaled, not yet OpenAPI/Swagger-documented (this
document is the documentation until a second concrete external consumer needs machine-readable
discovery).

## Versioning policy

Semver against this document, mirroring `FOUNDATION_FREEZE.md`'s and
`OBSERVABILITY_FREEZE.md`'s policy. Only the **major** version number appears in the URL
(`/v1`) — there may never be a `/v2`.

- **patch**: internal refactor, doc correction, non-behavioral change.
- **minor**: new route or optional field/query-param with no shape change to an existing one.
- **major**: any change to an existing route's path, method, status code, or response shape;
  any change to the default bind address or auth requirement.

## Breaking-change policy

No entry above changes without an ADR amendment (`ADR-0011` or a successor) and a version bump
reflecting it. The default-`127.0.0.1`-bind and mandatory-bearer-token-on-every-route guarantees
are the highest-scrutiny surfaces — any change there requires explicit user sign-off, same
precedent `FOUNDATION_FREEZE.md` established for `delegate_task`'s blocking behavior.

## Deprecation policy

No route has been deprecated yet. When one is: it stays functional for at least one minor
version, is marked deprecated in its own JSDoc/route registration comment, and its removal is
itself a major version / breaking change requiring an ADR.

## Release quality gates

Per `REST_FOUNDATION_REVIEW_PACKAGE.md` §11, satisfied for this freeze:
1. Full test suite green — 440 total (313 pre-existing at `v2.7.1` + 127 new: pre-implementation
   MCP characterization plus every WP0–WP5 unit/integration/contract/security test).
2. Live Inspector-equivalent check: `server._registeredTools` byte-identical across all 9 MCP
   tools.
3. A live boot of `restEntry.js`, driven by a real HTTP client, confirming actual route
   responses match this document's table exactly.
4. The four non-negotiable regression/proof tests passing: malformed-id regression (WP1),
   independent-instance isolation (WP0), shared-instance parity (WP5), shutdown-behavior (WP5).
5. Independent adversarial review passing clean, at every WP.
