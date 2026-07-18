# REST Stage 1b — Implementation Design Package

**Scope:** the concrete implementation design for `docs/adr/ADR-0011-rest-api-foundation.md`
(frozen, approved architecture — not redesigned here) and `REST_FOUNDATION_REVIEW_PACKAGE.md`
(frozen, approved implementation governance — not redesigned here). This document exists to
resolve exactly what ADR-0011 itself named as deliberately left open ("Recommended next step"):
the exact module layout, the exact `createDelegationBackend` file location (already pinned by the
Review Package — reused here, not re-decided), the exact HTTP status-mapping module shape, the
exact default port and env var names, the `limit` clamp value, whether `ConsumerRegistry` is wired
in at Stage 2 or deferred, and the exact TDD test list per Testing Strategy.

**Design only — no production code, no tests written, in this document or this sprint.** Gated for
review before any implementation begins. Stage 1 Characterization (`tests/
fileJobStoreCoexistence.characterization.test.js`, `tests/handlerGaps.characterization.test.js`'s
new tests) is reused verbatim as the pre-implementation baseline — not reproduced here.

---

## 0. What this document does not re-derive

Per "never rediscover certified work": the following are settled and reused by reference, not
restated in full:

- **Implementation Scope / Non-Scope / Risk Register / Migration Checkpoints / Rollback
  Checkpoints / Release Gates** — `REST_FOUNDATION_REVIEW_PACKAGE.md` §1, §2, §6, §5, §10, §11.
  Unchanged by this document.
- **Every architectural decision, disclosed divergence, and rationale** — `ADR-0011` in full.
  Unchanged by this document.
- **`createDelegationBackend()`'s file location** (`src/services/delegationBackend.js`, sibling to
  `delegationService.js`) — Review Package §1. Unchanged.

This document's job is narrower: turn "a `src/rest/` module tree, name TBD" and "decided at Stage 2
implementation-plan time" into actual file paths, function signatures, and default values.

---

## 1. Module Layout

```
src/
  rest/
    restServer.js          — createRestServer({backend, config, logger}) → {server, close()}
    router.js               — matchRoute(method, pathname, table) — minimal :id-param matcher
    auth.js                 — resolveOrGenerateRestToken(), checkBearerToken()
    bodyLimit.js             — checkContentLengthLimit(), streamBoundedBody()
    errors.js                — createErrorMapper({logger}) → toHttpError(), PayloadTooLargeError, MalformedBodyError
    parsing.js               — parseJobIdParam(), parseListQuery(), parseTimelineQuery(), MAX_LIST_LIMIT
    routes/
      jobs.js                — createJobRoutes({delegationService}) → {handleSubmit, handleGetJob, handleListJobs, handleCancelJob}
      observability.js       — createObservabilityRoutes({observabilityService}) → {handleReplay, handleTimeline, handleMetrics, handleSnapshot}
      models.js               — createModelsRoute({config}) → {handleModels}
  services/
    delegationBackend.js    — createDelegationBackend({config, logger}) (new; Review Package §1)
  cli/
    restEntry.js            — standalone entry point + registerRestShutdownHandlers()
```

9 new files under `src/rest/`, matching — file for file — the 6 unit-test categories ADR-0011's
Testing Strategy > Unit already names (route-to-service mapping, status-code mapping, path/query
parsing, auth predicate, body-size check) plus the DelegationService/ObservabilityService route
split the ADR's own Transport independence section insists on architecturally. This is not
speculative structure: each file exists because the ADR already committed to testing that exact
concern in isolation.

**Pinned calling convention (closes an ambiguity an independent review found):** every route
module exports a **factory**, not bare functions — `createJobRoutes({delegationService})`,
`createObservabilityRoutes({observabilityService})`, `createModelsRoute({config})` — each returning
an object of handler functions closing over its injected dependency. This mirrors
`createDelegateStatusHandler({delegationService})`'s exact existing shape, which is also what
ADR-0011's Testing Strategy > Unit already assumes ("tested with a fake/spy `DelegationService`...
injected via constructor"). `restServer.js` calls all three route factories **plus**
`createErrorMapper({logger})` (§9) once, at `createRestServer()` construction time, and builds its
inline route table from the returned handler objects — WP3 and WP4 both target this one pinned
signature, so their independently-built route files compose without reconciliation at integration
time.

**Deliberately not created**, per the ponytail ladder ("does this need to exist at all?"):

- **No CORS module.** Default-deny CORS costs zero code: `restServer.js` never sets any
  `Access-Control-Allow-*` header, and there is no route registered for `OPTIONS`. A browser
  preflight against any route gets a plain 404 with no CORS headers, which is by itself a complete,
  correct default-deny — nothing to build, nothing to test beyond "no such header appears" (already
  covered by the Security test suite, `REST_FOUNDATION_REVIEW_PACKAGE.md` §7).
  Do add one if a future Dashboard ADR needs a real, narrow allowlist.
- **No separate `routeTable.js`.** The 9-route table is a plain array literal, assembled by one
  function (`buildRouteTable()`) — mirroring `mcpServer.js`'s own precedent of inlining all 9
  `server.registerTool()` calls in one function body, no separate "tool table" file. **Home
  corrected during WP2/WP3 implementation**: `createRestServer()` (`restServer.js`) takes
  `routes` as an injected parameter rather than hardcoding the table internally — necessary so
  WP2's own tests could exercise the full request pipeline via a stub route before any real
  route existed. `buildRouteTable()` itself (the actual array-literal assembly) therefore lives
  in `restEntry.js`, the one place that both constructs the real route factories and calls
  `createRestServer()` — still exactly one file, still no separate route-table file, just not
  the file this bullet originally named.
- **No router library, no Express/Fastify/Koa dependency.** `router.js` is one small hand-rolled
  function; ADR-0011 pins "Node's built-in `http` module only" as a hard constraint, matching
  `ADR-0005`'s own "no new production dependency" precedent for `FileJobStore`.

## 2. Class / Function Responsibilities

| File | Export(s) | Responsibility | Calls into |
|---|---|---|---|
| `delegationBackend.js` | `createDelegationBackend({config, logger})`, plus `selectJobStore`/`selectEventHistoryStore`/`wireEventHistoryIfEnabled` (all three moved here — see below) | Extract-Function refactor of `createMcpServer`'s construction block (lines 94–141 today). Returns `{jobManager, bus, observabilityService, delegationService, eventHistoryStore}`. Zero new logic — behavior-preserving by construction. | `JobManager`, `createObservabilityService`, `createDelegationService`, `wireWorkspaceToEventBus`, `wireEventHistoryToEventBus` |
| `restEntry.js` | `main()`, `registerRestShutdownHandlers(...)` | Boot sequence: load config → resolve/generate token → `createDelegationBackend` → `createRestServer` → register shutdown handlers → listen. Mirrors `entry.js`'s own shape exactly (same function names/pattern, new process). | `delegationBackend.js`, `rest/restServer.js`, `rest/auth.js` |
| `rest/restServer.js` | `createRestServer({backend, config, logger})` → `{server, close()}` | Owns the raw `http.Server`, the inline 9-route table, and the request pipeline (body-limit gate → auth check → route match → handler → error mapping → response). `close()` wraps `server.close()` + `server.closeIdleConnections()` (§10) so callers never need to know that detail. Zero business logic — every branch either rejects with a fixed HTTP error or calls exactly one handler. | `router.js`, `auth.js`, `bodyLimit.js`, `errors.js`, `routes/*.js` |
| `rest/router.js` | `matchRoute(method, pathname, table)` | Pure pattern match: `{status: "not-found"}` or `{handler, params}`. No I/O. | none |
| `rest/auth.js` | `resolveOrGenerateRestToken({config, logger})`, `checkBearerToken(req, token)` | Token generation-at-boot-if-unset + persistence (side-effecting, called once from `restEntry.js`); `checkBearerToken` is a pure `crypto.timingSafeEqual` predicate. | `node:crypto`, `node:fs` |
| `rest/bodyLimit.js` | `checkContentLengthLimit(req, maxBytes)`, `streamBoundedBody(req, maxBytes)` | `checkContentLengthLimit`: header-based pre-check (pure). `streamBoundedBody`: the **one** function that attaches the byte-counting guard — called for **every** request regardless of route (see §8); its returned Promise resolves with the full accumulated `Buffer` once the body ends (only `POST /v1/jobs`'s handler awaits and parses it) or rejects with `PayloadTooLargeError` the moment the count crosses the limit, destroying the socket. | `errors.js` (constructs `PayloadTooLargeError`) |
| `rest/errors.js` | `createErrorMapper({logger})` → `toHttpError(err)`; `PayloadTooLargeError`, `MalformedBodyError` | Factory returning the mapping function — `logger` is a real dependency (the 500 branch logs server-side), so it is injected explicitly, not assumed as an ambient global. REST's `toToolErrorContent()` analog. Never leaks `err.message`/`stack` for unrecognized errors. | `logger` (injected) |
| `rest/parsing.js` | `parseJobIdParam`, `parseListQuery`, `parseTimelineQuery`, `MAX_LIST_LIMIT`, `InvalidQueryParamError` | Pure parsing of path + query params. **`parseJobIdParam` performs no validation** — it extracts the raw `:id` path segment as a string, nothing more (see §8/§9 for why). `parseListQuery`/`parseTimelineQuery` do validate their own params (`status`/`limit`/`type`/`since`) against known enums/shapes, throwing `InvalidQueryParamError` on an invalid value (class added during WP1; `toHttpError`'s own mapping for it added during WP3, alongside the first real handler — `handleTimeline` — that can actually throw it; `PayloadTooLargeError`/`MalformedBodyError`/`ZodError` were already mapped since WP1). | `EVENT_TYPES` (for `type` enum validation) |
| `rest/routes/jobs.js` | `createJobRoutes({delegationService})` → `{handleSubmit, handleGetJob, handleListJobs, handleCancelJob}` | Each: parse params (via `parsing.js`) → call exactly one `DelegationService` method → shape the response envelope. `handleSubmit` additionally constructs `MalformedBodyError` on a `JSON.parse` failure (§8/§9). No logic beyond that. | `delegationService` (injected via factory), `errors.js` (constructs `MalformedBodyError`) |
| `rest/routes/observability.js` | `createObservabilityRoutes({observabilityService})` → `{handleReplay, handleTimeline, handleMetrics, handleSnapshot}` | Same shape, calling exactly one `ObservabilityService` method each. | `observabilityService` (injected via factory) |
| `rest/routes/models.js` | `createModelsRoute({config})` → `{handleModels}` | Calls the shared `buildModelsInfo(config)` (extracted from `schemas.js`, §12), returns its structured result as the JSON body directly — no MCP-specific text formatting. | `buildModelsInfo` |

## 3. REST Entry Architecture

`src/cli/restEntry.js`'s `main()`, mirroring `entry.js`'s own `main()` shape line-for-line:

```
1. logger = createLogger("claude-delegate-rest")
2. config = loadConfig(process.env); validateConfig(config)
3. token = resolveOrGenerateRestToken({config, logger})   // generates + persists if unset
4. backend = createDelegationBackend({config, logger})     // {jobManager, bus, observabilityService,
                                                             //  delegationService, eventHistoryStore}
5. restServer = createRestServer({backend, config, logger, token})
6. registerRestShutdownHandlers(restServer, backend.jobManager, logger, {
     observabilityService: backend.observabilityService,
     graceMs: config.restShutdownGraceMs,
     forceExitMs: config.restShutdownForceExitMs,
   })
7. restServer.server.listen(config.restPort, config.restHost)
8. logger.info("claude-delegate REST listening", { host: config.restHost, port: config.restPort })
```

Never imports `src/cli/entry.js` or `src/server/mcpServer.js` — a fully independent process, per
ADR-0011's Compatibility with existing MCP transport ("never a flag inside the existing
`src/cli/entry.js` stdio process, and never a code path reachable from stdio's `main()`").

## 4. DelegationBackend Responsibilities

Exactly the Extract-Function refactor Review Package §1 already pinned. `mcpServer.js`'s
`createMcpServer()` becomes:

```js
export function createMcpServer({ config, logger, version }) {
  const server = new McpServer({ name: "claude-delegate", version }); // stays the first statement, unchanged from today
  const backend = createDelegationBackend({ config, logger });        // then everything that block used to inline
  server.registerTool("delegate_task", {...}, createDelegateTaskHandler({ logger, jobManager: backend.jobManager, delegationService: backend.delegationService }));
  // ...all 9 registerTool calls, now reading from `backend.*` instead of local consts
  return { server, observabilityService: backend.observabilityService, eventHistoryStore: backend.eventHistoryStore };
}
```

**Construction order preserved deliberately, not merely asserted safe** (an independent review
correctly flagged an earlier draft that silently reordered this): `new McpServer(...)` remains the
literal first statement, exactly as today. `createDelegationBackend()` then runs everything that
today's inline block runs next (`bus` → `jobManager` → `wireWorkspaceToEventBus` → `eventHistoryStore`
→ `observabilityService` → `wireEventHistoryIfEnabled` → `delegationService`), in the same relative
order to each other, just wrapped in one function call. The only thing that changes is that these
steps now happen inside a function call instead of inline — their order relative to `server`
construction and to each other is byte-identical to today. WP0's acceptance criterion (full suite
green, `server._registeredTools` unchanged) is what a passing implementation looks like; this
paragraph is why the order is safe to begin with, not just what to check afterward.

`selectJobStore`/`selectEventHistoryStore` (currently exported from `mcpServer.js`, independently
unit-tested by `tests/mcpServer.test.js`) **move into `delegationBackend.js`** since they're
construction-time concerns of the backend, not the MCP transport — `mcpServer.js` no longer needs
them at all.

**`wireEventHistoryIfEnabled` moves too — a necessary correction found during implementation, not
in the original draft.** This function is called from inside the construction block being
extracted, so leaving it defined in `mcpServer.js` (as an earlier draft of this section implied)
would make `delegationBackend.js` import it *from* `mcpServer.js`, which itself imports
`createDelegationBackend` *from* `delegationBackend.js` — a circular import between the two files.
Moving all three functions together avoids this; `delegationBackend.js` now imports
`wireEventHistoryToEventBus` directly from `eventHistoryBridge.js` instead (a leaf dependency, no
cycle).

`tests/mcpServer.test.js`'s existing imports of `selectJobStore`/`selectEventHistoryStore`/
`wireEventHistoryIfEnabled` from `mcpServer.js` are updated to import from `delegationBackend.js`
instead — three functions' worth of import-path edits in one line change, not the "one" originally
named, called out explicitly here (and in the implementation's own Final Check) rather than left
implicit.

`restEntry.js` calls the exact same `createDelegationBackend({config, logger})` — a second,
independent call, sharing no module-level state with `mcpServer.js`'s call (proven by the
independent-instance isolation test, Review Package §7 item 3).

## 5. DelegationService Integration

Zero new methods. REST routes call `submit(body, "rest")`, `getJob(jobId)`,
`listJobs({status, limit})`, `cancelJob(jobId)` — the same four methods, same signatures, same tool
label pattern MCP already uses (`"delegate_task"`/`"delegate_submit"` → `"rest"`).

**The one addition, inside `delegationService.js` itself** (not a new file): `getJob`/`cancelJob`
gain a leading `isValidJobId()` check —

```js
getJob(jobId) {
  if (!isValidJobId(jobId)) return undefined;
  const job = jobManager.getJob(jobId);
  return job ? toJobView(job) : undefined;
},
cancelJob(jobId) {
  if (!isValidJobId(jobId)) return false;
  return jobManager.cancelJob(jobId);
},
```

reusing `workspaceManager.js`'s existing exported `isValidJobId()` (already used by `fileJobStore.js`
and `workspaceManager.js` itself — no new validation logic invented, an existing predicate reused a
third time). Import added to `delegationService.js`; **zero other line in the file changes.** This
is the exact guard ADR-0011's Compatibility with DelegationService section specifies:
never throws, returns exactly `undefined`/`false` — the same values the pre-existing unknown-id path
already returns, so the malformed-id regression test (baseline already captured in Stage 1
characterization, `tests/handlerGaps.characterization.test.js`) passes byte-identical before and
after this change lands.

## 6. FileJobStore Interaction

**No REST-specific `FileJobStore` code of any kind.** REST consumes `jobManager`/`delegationService`
from `createDelegationBackend()` exactly as MCP does; `FileJobStore`'s hydrate-once/cache-only
behavior is unchanged, untouched, and already proven by Stage 1 Characterization
(`tests/fileJobStoreCoexistence.characterization.test.js`) at both the store layer and the
`DelegationService`-stack layer, including cross-stack `cancelJob()` isolation. Stage 2 must not
introduce any live-refresh/reconciliation logic at any layer (`FileJobStore`, `JobManager`,
`DelegationService`) that would make those three characterization tests fail — they are this
design's regression guard for MCP coexistence, reused, not reproduced.

## 7. Authentication Flow

1. **At boot** (`restEntry.js`, step 3): `resolveOrGenerateRestToken({config, logger})` —
   if `config.restToken` is set (from `CLAUDE_DELEGATE_REST_TOKEN`), use it verbatim; otherwise
   `crypto.randomBytes(32).toString("hex")`, write to `config.restTokenFile`, log only that a token
   was generated and where (never the value — extending `ADR-0001`'s environment-redaction
   discipline, per ADR-0011's Authentication section).
2. **Per request** (`restServer.js`'s pipeline, run *before* route dispatch, *after* the body-size
   Content-Length gate — see §8 for why that order): `checkBearerToken(req, token)` reads the
   `Authorization` header, rejects (401 `UNAUTHORIZED`) if missing/malformed/wrong, using
   `crypto.timingSafeEqual` after an explicit length check (never `===`, never a short-circuit
   string compare).
3. Applied to **every** route, including reads — no route is exempt (ADR-0011, Authentication).

**Auth runs before route matching (step 2 before step 3) — a deliberate choice, stated explicitly
here because a fresh review round correctly noted it has a real, previously-unstated consequence:**
an unauthenticated or wrong-token request to *any* undefined path also gets 401, never 404 — route
existence is only observable to a caller who already holds a valid token. This is intentional, not
an oversight: it avoids letting an unauthenticated prober enumerate which paths exist on this
project's first-ever network listener, a strictly more conservative posture than leaking route
existence pre-auth. **Consequence for the future `/health` liveness endpoint** (ADR-0011, Future
extensibility — genuinely deferred, no concrete consumer yet): if it is ever built, it must be
special-cased as an explicit auth-exempt path checked *before* step 2 (a short allowlist check, not
a restructuring of this pipeline) — stated here so that future work isn't surprised to find auth
unconditionally gating every path today.

## 8. Request Validation Flow

Fixed pipeline order in `restServer.js`, applied to every incoming request:

```
1. Body-size Content-Length gate (bodyLimit.js: checkContentLengthLimit) → 413, socket destroyed,
   no buffering at all (see below for why the socket is destroyed, not kept alive)
2. Bearer-token check (auth.js)                          → 401 UNAUTHORIZED
3. Route match (router.js)                               → 404 (no such route — distinct from JOB_NOT_FOUND)
4. Query-param parsing (parsing.js: parseListQuery/parseTimelineQuery only) → 400 INVALID_QUERY_PARAM
   (parseJobIdParam extracts the raw :id segment only — it validates nothing; see below)
5. streamBoundedBody(req, maxBytes) called ONLY by POST /v1/jobs's own handler (handleSubmit) --
   the one route that ever reads a request body → 413 + socket destroyed if accumulated bytes
   cross the limit while streaming (e.g. absent/understated Content-Length); its resolved Buffer
   is JSON.parsed → 400 MALFORMED_BODY on parse failure. Every other route never attaches to the
   body stream at all (see below for why this scoped approach replaced an earlier universal one)
6. Service call (submit/getJob/listJobs/cancelJob/replay/getTimeline/getMetrics/getSnapshot)
                                                           → 400 INVALID_INPUT (ZodError from submit())
                                                             200/202/404/409 (route-specific, §9)
7. Response envelope
```

**Step 1 runs before step 2, deliberately** — this is the one ordering decision this document adds
that ADR-0011 left implicit. Rationale: ADR-0011's own Security testing requirement states the
body-size limit "applies regardless of authentication state ... a large body from an authenticated
caller is bounded exactly as strictly as one from an unauthenticated one." Running the
Content-Length check first (a zero-cost header inspection, no `timingSafeEqual` call spent yet)
makes this trivially, structurally true — the check is never reachable to skip based on auth
outcome, rather than merely "true in practice." It also means an oversized request from *any*
caller, token or no token, gets the cheapest possible rejection.

**`streamBoundedBody` is scoped to exactly the one route that reads a body, not attached
universally — a refinement made during WP4, replacing an earlier "attach to every request, tear
down after response" framing (itself a fix for a gap an independent review found in a still-earlier
draft).** The universal-attach approach required tearing the guard down the instant a non-`POST`
route's response was sent, to avoid a real risk: a slow-trickling oversized body arriving *after*
the response was already sent could still trip the limit and `socket.destroy()` — a TCP RST
discarding not-yet-ACKed bytes of that already-complete, unrelated response, truncating a
legitimate reply. Building the teardown mechanism (during WP4) surfaced a simpler resolution:
`streamBoundedBody` never needed to be attached for routes that don't read a body in the first
place. `POST /v1/jobs`'s own handler (`handleSubmit`) is the only caller of `streamBoundedBody`,
called only when that specific request is being handled — every other route (`GET`/`DELETE`)
never touches the body stream at all, so there is no listener to tear down and no truncation race
to guard against. `checkContentLengthLimit` (step 1) still bounds every request's *declared* size
regardless of route; a chunked/understated body on a non-body-reading route is left to Node's
default stream backpressure (an unconsumed, un-listened-to stream imposes no unbounded Node-process
memory cost) rather than actively monitored — a deliberate, disclosed choice matching this
project's "any caller with the token is a fully-trusted actor already" threat model (Security
section) and its repeated "don't build machinery ahead of a concrete need" discipline
(`ConsumerRegistry`, `subscribeToJob()`).

**Neither 413 path ever leaves the connection open for reuse — this closes a third gap a fresh
review round found — but the two paths achieve it by different, each-correct-for-its-own-moment
mechanisms, corrected during implementation.** An earlier draft said both paths "destroy the
socket"; building it revealed why that's only safe for one of them. Step 5's mid-stream abort fires
*before* any response has been sent for that request, so `req.socket.destroy()` is safe and
immediate. Step 1's immediate rejection is different: the 413 response itself still needs to be
written and flushed to the client, so calling `socket.destroy()` before responding was found (via a
failing test) to sever the connection before the client could ever see the 413 body — destroying
the very response meant to explain the rejection. Step 1 instead sets `Connection: close` and
responds normally; Node closes the socket once the response is fully flushed. Both paths end in the
same place — no keep-alive reuse, no leftover-bytes-misparse risk on a later request — just reached
correctly for whether a response is already in flight.

**`parseJobIdParam` deliberately performs no validation — this closes a real ambiguity an
independent review found.** It extracts the raw `:id` path segment as a plain string and passes it
through unchanged; it never rejects, never produces a 400. All `job_id`-shape validation lives in
exactly one place, `DelegationService.getJob()`/`cancelJob()`'s `isValidJobId()` guard (§5) — the
same guard MCP already shares. This is what makes ADR-0011's explicit "malformed and unknown are
deliberately indistinguishable... 404, not 400" rule (Compatibility with DelegationService)
mechanically true: a malformed `:id` reaches the service layer exactly like an unknown one, gets
`undefined`/`false` back, and the route returns 404 `JOB_NOT_FOUND` — never a 400. (ADR-0011's
Testing Strategy > Security phrase "re-applying the `isValidJobId()` UUID gate at the HTTP layer
too" refers to testing that REST callers get the same shared-guard protection MCP already has, not
to a second, HTTP-only validation step with different behavior — stated explicitly here so the two
mentions don't read as contradictory at implementation time.)

## 9. Error Mapping

`rest/errors.js`'s `createErrorMapper({logger})` — returns `toHttpError(err)`, the **only** function
that maps a thrown exception to `{status, body}`. `logger` is an explicit constructor dependency
(closed over, not an ambient global) because the 500 branch genuinely needs it — an earlier draft
referenced `logger` inside a bare, unparameterized `toHttpError(err)` with no way to reach it, which
would have thrown a `ReferenceError` on exactly the path meant to fail safely; fixed by making this
a factory, the same injection pattern every other `rest/*` module already uses:

```js
export function createErrorMapper({ logger }) {
  return function toHttpError(err) {
    if (err instanceof PayloadTooLargeError)
      return { status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: err.message } } };
    if (err instanceof MalformedBodyError)
      return { status: 400, body: { error: { code: "MALFORMED_BODY", message: "Request body is not valid JSON" } } };
    if (err instanceof ZodError)
      return { status: 400, body: { error: { code: "INVALID_INPUT", message: "Invalid request body", details: err.issues } } };
    logger.error("unhandled REST error", { message: err.message, stack: err.stack }); // server-side only
    return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } } };
  };
}
```

`restServer.js` calls `createErrorMapper({logger})` once at construction time, alongside the route
factories (§1), and uses the returned `toHttpError` throughout its pipeline.

**`JOB_NOT_FOUND` (404) and `JOB_NOT_CANCELLABLE` (409) are never thrown exceptions** — they are
constructed directly by `routes/jobs.js`'s `handleGetJob`/`handleCancelJob` bodies, following
ADR-0011's own Cancellation pseudocode verbatim (before/cancelled/after branching). `401`/`404`
(no-such-route)/`413`(Content-Length)/`400`(query-param) are similarly constructed directly by
`restServer.js`'s pipeline stages, not routed through `toHttpError`. `toHttpError` exists
specifically for the "a service call threw" case — matching `toToolErrorContent()`'s own scope
exactly (it doesn't handle MCP SDK-level validation either).

## 10. Shutdown Lifecycle

`entry.js`'s existing `registerShutdownHandlers()` is **untouched — zero edits** (it stays exactly
as `tests/entry.test.js`'s 8 characterization tests pin it). A new, separate, exported function in
`restEntry.js` implements REST's richer sequence, mirroring `registerShutdownHandlers`'s own
injectable-deps/testable shape:

```js
export function registerRestShutdownHandlers(
  restServer, jobManager, logger,
  { exit = () => process.exit(0), signalSource = process, observabilityService, graceMs = 5000, forceExitMs = 2000 } = {}
) {
  let shuttingDown = false; // re-entrancy guard — closes a gap an independent review found
  const shutdown = async (trigger) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("REST shutting down", { trigger });
    await restServer.close();                       // stop accepting new connections + close idle keep-alives (see createRestServer, §2)
    await new Promise((r) => setTimeout(r, graceMs));             // let non-terminal jobs finish naturally
    const stillRunning = jobManager.listJobs().filter((j) => !TERMINAL_STATUSES.has(j.status));
    stillRunning.forEach((j) => jobManager.cancelJob(j.id));       // force-cancel: queued→sync, running→abort()+async settle
    await Promise.race([
      Promise.all(stillRunning.map((j) => jobManager.waitForCompletion(j.id))),
      new Promise((r) => setTimeout(r, forceExitMs)),
    ]);
    observabilityService?.close?.();
    exit();
  };
  signalSource.on("SIGINT", () => shutdown("SIGINT"));
  signalSource.on("SIGTERM", () => shutdown("SIGTERM"));
  return shutdown;
}
```

**Two fixes an independent review's sequencing lens required, both closed above:**

- **Keep-alive connections don't block shutdown indefinitely.** Node's `http.Server.close()` alone
  only refuses *new* connections — its returned promise doesn't resolve until every already-open
  socket closes, and a well-behaved polling client (ADR-0011's own expected usage) may hold a
  keep-alive connection open indefinitely. `closeIdleConnections()` (a built-in Node API, available
  since Node 18.2, no new dependency — this project already requires Node >=20) closes any
  keep-alive socket that is idle *right now*, called immediately after `close()` so the grace-period
  clock isn't spent waiting on a client's own socket lifecycle. **Stated honestly, not guaranteed
  away** (a fresh review round correctly pushed back on an earlier, over-strong claim here, in the
  same spirit as `ADR-0004`'s own disclosed platform limits): a request a polling client sends on an
  existing keep-alive socket in the same instant `closeIdleConnections()` runs is, at the TCP level,
  briefly indistinguishable from a genuinely idle connection and could be reset before Node finishes
  parsing it into a request. This is a narrow, sub-millisecond race, not a design flaw to eliminate
  here — a REST client polling `GET /v1/jobs/:id` is already expected to tolerate an occasional
  connection reset and retry (no different in kind from any other transient network hiccup), and the
  window only exists during the brief moment shutdown begins, never during normal operation.
- **Re-entrancy guard.** A second `SIGTERM` arriving mid-grace-period previously re-entered
  `shutdown()` concurrently (a second `close()`, a second cancel-pass over jobs already cancelling,
  two racing `exit()` calls). The `shuttingDown` flag makes every signal after the first a no-op.

No `stdin`-close listener — REST has no client pipe to watch (ADR-0011: "A second MCP-analogous
instance question does not apply to REST... a second one appearing is unambiguously wrong, and is
caught for free by TCP port-bind"). Ungraceful termination (`kill -9`, crash) runs no code at all —
handled entirely by `FileJobStore`'s existing hydration-time recovery, per ADR-0011's Shutdown
semantics, reused verbatim.

## 11. Transport Boundaries

REST never imports `JobManager`, `RuntimeEventBus`, or `FileJobStore` directly in any `routes/*.js`
file — only `backend.delegationService`/`backend.observabilityService`, injected. Enforced by a new
structural test mirroring `tests/transportBoundary.test.js`'s existing import-boundary-checking
pattern, extended to `src/rest/routes/*.js` (WP5, see §13).

## 12. Dependency Boundaries

Zero new npm dependency. `src/rest/*` and `restEntry.js` import only: `node:http`, `node:crypto`,
`node:url` (for query-string parsing via the built-in `URL` class), plus this project's own
existing modules (`delegationBackend.js`, `EVENT_TYPES`, `TERMINAL_STATUSES`). `package.json`'s
`dependencies` block is unchanged by this design.

**`buildModelsInfo(config)` extraction** (ADR-0011, REST lifecycle table note): a new named export
added to `src/models/schemas.js`, returning **only structured data** —
`{models: [{model, fallback}...], efforts, defaults}` — with no MCP-specific text formatting. **This
scope is deliberately narrowed here to close an ambiguity an independent review found**: an earlier
draft claimed both `delegateModelsHandler.js` and `rest/routes/models.js` reuse the helper
"verbatim," without saying whether that included the handler's human-readable
`response.content[0].text` line-per-model formatting (which `tests/
handlerGaps.characterization.test.js`'s `delegate_models` test asserts on directly). Resolved as:
`buildModelsInfo` extracts only the **structured data construction** (today's reads of
`config.modelFallbacks` + `MODELS`/`EFFORTS`) — `delegateModelsHandler.js` keeps its own thin
text-formatting loop, now built *from* `buildModelsInfo(config)`'s return value instead of reading
`config`/`MODELS`/`EFFORTS` directly (still behavior-preserving; its existing characterization test
must stay green unmodified). `rest/routes/models.js`'s `handleModels` returns `buildModelsInfo(
config)`'s structured object as the JSON body directly — REST needs no text-line field at all. This
matches Responsibilities bucket 2 ("protocol-specific response envelope") cleanly: the shared helper
owns the data, each transport owns its own presentation.

## 13. Test Implementation Sequence

Concrete file list, extending `REST_FOUNDATION_REVIEW_PACKAGE.md` §7's obligations to actual paths:

| WP | New/modified test files |
|---|---|
| WP0 | `tests/delegationBackend.test.js` (new — shape assertion + independent-instance isolation, Review Package §7 item 3 — this is where that specific test lives and gates; nothing re-derives it later); `tests/mcpServer.test.js` (modified — update `selectJobStore`/`selectEventHistoryStore` import path only, per §4); full existing suite must stay green unmodified otherwise |
| WP1 | `tests/restErrors.test.js`, `tests/restAuth.test.js`, `tests/restParsing.test.js`, `tests/restBodyLimit.test.js` (all new, pure-function unit tests, no live server); `tests/delegationService.test.js` (modified — add the `isValidJobId()`-guard unit test, §5); `tests/handlerGaps.malformedIdRegression.test.js` (new — **moved here from WP5**, per `REST_FOUNDATION_REVIEW_PACKAGE.md` §3's own explicit exception: this test needs only WP1's guard plus the *existing* MCP handlers, not any REST route, so it starts as soon as WP1 lands, in parallel with WP2/WP3/WP4 — re-runs Stage 1's already-captured malformed-id baseline against the post-guard `delegateStatusHandler`/`delegateCancelHandler`, asserting byte-identical output) |
| WP2 | `tests/restServer.test.js` (new — boot, default-bind-host assertion, 401/413 on a stub route, full shutdown-sequence-within-bounds test including the re-entrancy-guard and idle-connection-close behavior, §10) |
| WP3 | `tests/restRoutes.observability.unit.test.js`, `tests/restRoutes.models.unit.test.js` (new — route handler calls the right service method with a fake service injected via the pinned factory signature, §1, mirroring `tests/handlerGaps.characterization.test.js`'s own handler-testing idiom) |
| WP4 | `tests/restRoutes.jobs.unit.test.js` (new — `createJobRoutes({delegationService})`'s four handlers, same idiom as WP3; **this file belongs here, not WP3** — `src/rest/routes/jobs.js` itself is a WP4 file, per the WP4 Work Package Design section below) |
| WP5 | `tests/restRoutes.contract.test.js`; `tests/restIntegration.test.js`, containing a **distinctly named** test — e.g. `test("REST and MCP observe identical job state via one shared DelegationService instance")` — for the shared-instance parity proof (Review Package §7 item 2), plus submit→poll→complete/cancel(queued)/cancel(running)/404-unknown-id/concurrent-submissions coverage; `tests/restBodySize.integration.test.js`; `tests/restShutdown.integration.test.js`; `tests/restSecurity.test.js` (auth, path-traversal, CORS-absence, secret-non-leakage, default-bind, body-size-regardless-of-auth); `tests/transportBoundary.test.js` (modified — extend existing import-boundary check to `src/rest/routes/*.js`, §11) |
| WP6 | none (documentation only) |
| WP7 | none (verification only — full suite + live boot + Inspector-equivalent check, Review Package §11) |

**Mapping to Review Package §7's four non-negotiable tests, made explicit** (an independent review
found the original mapping vague): (1) malformed-id regression → **WP1**; (2) shared-instance parity
→ **WP5** (needs the full route set); (3) independent-instance isolation → **WP0 only** — it is a
unit-level proof about `createDelegationBackend()` itself and nothing about it changes once REST
routes exist, so WP5 does not re-run or re-assert it; (4) shutdown-behavior → **WP5**'s integration
test, exercising the real bound server from WP2 with real routes from WP3/WP4.

## 14. Documentation Update Sequence

Unchanged from `REST_FOUNDATION_REVIEW_PACKAGE.md` §8 — reused by reference, not restated. Order:
`docs/REST_FREEZE.md` → `CHANGELOG.md` → `docs/ARCHITECTURE.md` → `docs/releases/
KNOWN_LIMITATIONS.md` → `docs/releases/MIGRATION_GUIDE.md` → `package.json` version bump, all at WP6.

## 15. Rollback Plan

Unchanged from `REST_FOUNDATION_REVIEW_PACKAGE.md` §10 — reused by reference. This document adds no
new rollback surface: every new file listed in §1 is additive, and the three existing-file edits,
across four files (§4's `mcpServer.js` refactor; §5's `delegationService.js` guard; §12's
`schemas.js` extraction plus `delegateModelsHandler.js`'s corresponding call-site update), are each
independently, behavior-preservingly revertible — each has its own full-suite acceptance gate (WP0/
WP1/WP3 respectively, see Work Package Design) proving zero regression before the next WP starts.

## 16. Migration Checkpoints

Unchanged from `REST_FOUNDATION_REVIEW_PACKAGE.md` §5 — reused by reference.

## 17. Open decisions this document resolves

Per ADR-0011's own "Recommended next step" list — resolved here, not deferred further:

- **Default REST port**: `8787` (`CLAUDE_DELEGATE_REST_PORT`). Uncommon enough to avoid the usual
  dev-server collisions (3000, 5173, 8000, 8080); no other significance.
- **`limit` clamp value**: `MAX_LIST_LIMIT = DEFAULT_MAX_JOB_HISTORY` (500, `rest/parsing.js`,
  imported from `src/config/index.js`) — tied to the store's own existing history cap rather than
  an invented number; `listJobs()` can never usefully return more than `maxJobHistory` jobs anyway.
  Not independently env-configurable in v1 — no concrete need yet (ADR-0011, Pagination).
- **`ConsumerRegistry` wiring**: **deferred to Stage 3 (Dashboard)**, not wired into Stage 2.
  Rationale, applying ADR-0011's own "not built speculatively" discipline directly: REST v1 has no
  concrete consumer needing lease/heartbeat registration — `ConsumerRegistry`'s shape was designed
  for "a long-lived REST/Dashboard backend process," and Dashboard (the concrete second consumer)
  doesn't exist yet. Wiring it into `restEntry.js` now would be registering against nothing real.
  Stage 3's own ADR decides this when Dashboard is a concrete consumer.
- **Config env-var names/defaults**: all six named in ADR-0011 verbatim
  (`CLAUDE_DELEGATE_REST_HOST`, `_PORT`, `_TOKEN`, `_TOKEN_FILE`, `_MAX_BODY_BYTES`,
  `_SHUTDOWN_GRACE_MS`, `_SHUTDOWN_FORCE_EXIT_MS`) — this document only supplies the numeric/string
  defaults not already fixed by the ADR (port 8787; the rest were already given exact defaults in
  ADR-0011's own Security/Authentication/Shutdown semantics sections).

---

## Work Package Design

Extending `REST_FOUNDATION_REVIEW_PACKAGE.md` §3's WP breakdown to this document's concrete file
paths. Dependencies/parallelization/risk sourcing are unchanged from the Review Package; this table
adds the acceptance-criteria/regression-risk/certification-evidence detail at file-level precision.

### WP0 — `createDelegationBackend()` extraction

- **Objective**: extract `createMcpServer`'s construction block into `src/services/
  delegationBackend.js`, behavior-preserving.
- **Affected files**: `src/services/delegationBackend.js` (new), `src/server/mcpServer.js`
  (modified — calls the new helper, moves `selectJobStore`/`selectEventHistoryStore` out),
  `tests/mcpServer.test.js` (modified — import path only), `tests/delegationBackend.test.js` (new).
- **Dependencies**: none.
- **Acceptance criteria**: full existing suite green unmodified (except the one import-path edit
  above); `server._registeredTools` byte-identical across all 9 tools; `tests/
  delegationBackend.test.js` proves the returned shape and independent-instance isolation.
- **Regression risks**: R1 (Review Package) — construction-order/timing change affecting an
  existing MCP tool. Mitigated by the full-suite-green gate being the acceptance criterion itself,
  not a separate check.
- **Certification evidence required**: `npm test` output (317+ tests, 0 fail), a diff showing
  `mcpServer.js`'s construction block is deleted (not duplicated) and replaced by one call.

### WP1 — Pure adapter primitives + `isValidJobId()` guard

- **Objective**: build every pure-function primitive REST needs, independent of any live server;
  add the malformed-id guard to `DelegationService`.
- **Affected files**: `src/rest/errors.js`, `src/rest/parsing.js`, `src/rest/auth.js` (the
  `checkBearerToken` predicate only — `resolveOrGenerateRestToken`'s fs side effects are exercised
  in WP2's integration test, not here), `src/rest/bodyLimit.js`, `src/services/delegationService.js`
  (guard added), `tests/restErrors.test.js`, `tests/restAuth.test.js`, `tests/restParsing.test.js`,
  `tests/restBodyLimit.test.js`, `tests/delegationService.test.js` (modified),
  `tests/handlerGaps.malformedIdRegression.test.js` (new — moved here from WP5, §13).
- **Dependencies**: none (parallelizable with WP0 — genuinely disjoint files, per Review Package §1).
- **Acceptance criteria**: each primitive has a passing unit test; the `isValidJobId()` guard test
  specifically proves no-throw + `undefined`/`false` for a malformed id; the malformed-id regression
  test independently re-proves the same thing end-to-end through the real
  `delegateStatusHandler`/`delegateCancelHandler`, byte-identical to the Stage 1 characterization
  baseline (`tests/handlerGaps.characterization.test.js`) — this is the gate, not a WP5 formality.
- **Regression risks**: R2 (Review Package) — guard implemented as a throw despite the ADR's
  explicit decision. Mitigated by both tests above landing in this same WP, not deferred past it.
- **Certification evidence required**: all five new/modified test files passing; a diff of
  `delegationService.js` showing exactly the two-line guard addition (§5), nothing else changed.

### WP2 — `restEntry.js` + `restServer.js` skeleton

- **Objective**: a booting REST server enforcing auth/body-limit/shutdown, zero routes registered.
- **Affected files**: `src/cli/restEntry.js` (new), `src/rest/restServer.js` (new, route table
  empty except a stub test route), `src/rest/router.js` (new), `src/config/index.js` (modified —
  new REST env vars, additive), `tests/restServer.test.js` (new).
- **Dependencies**: WP0, WP1.
- **Acceptance criteria**: binds `127.0.0.1:8787` by default (test asserts non-`0.0.0.0`); 401 on
  missing/wrong token; 413 on oversized body before any route logic runs; full shutdown sequence
  (grace → force-cancel → wait → exit) completes within configured bounds under test.
- **Regression risks**: none new — `src/config/index.js`'s additions are purely additive fields;
  existing config consumers untouched (verified by `tests/configValidation.test.js` staying green).
- **Certification evidence required**: `tests/restServer.test.js` passing; a live boot (manual or
  scripted) showing the process listens and responds 401/413 correctly.

### WP3 — Read-only routes

- **Objective**: `GET /v1/jobs/:id`, `/v1/jobs`, `/v1/metrics`, `/v1/snapshot`, `/v1/jobs/:id/replay`,
  `/v1/jobs/:id/timeline`, `/v1/models`.
- **Affected files**: `src/rest/routes/observability.js` (new), `src/rest/routes/models.js` (new),
  `src/models/schemas.js` (modified — `buildModelsInfo` extraction, §12),
  `src/handlers/delegateModelsHandler.js` (modified — calls the extracted helper),
  `src/rest/restServer.js` (modified — routes registered), `tests/restRoutes.observability.unit.test.js`,
  `tests/restRoutes.models.unit.test.js` (new).
- **Dependencies**: WP2. Parallelizable with WP4 with the R8 caveat (Review Package) — both touch
  `restServer.js`'s route-registration call site; sequential-in-one-worktree recommended.
- **Acceptance criteria**: each route's unit test proves it calls exactly one
  `ObservabilityService` method (or `buildModelsInfo`) with no additional logic.
- **Regression risks**: none beyond R8 (merge-conflict risk on `restServer.js`, process-level, not
  correctness-level).
- **Certification evidence required**: the two new unit test files passing; `delegateModelsHandler`'s
  existing characterization test staying green unmodified.

### WP4 — Write routes

- **Objective**: `POST /v1/jobs` (202 + `Location`), `DELETE /v1/jobs/:id` (before/cancel/after
  idempotency logic, ADR-0011 Cancellation).
- **Affected files**: `src/rest/routes/jobs.js` (new), `src/rest/restServer.js` (modified — routes
  registered), `tests/restRoutes.jobs.unit.test.js` (new).
- **Dependencies**: WP2. Same R8 caveat as WP3.
- **Acceptance criteria**: `handleSubmit` calls `submit(body, "rest")` then `getJob`, returns 202 +
  `Location` header; `handleCancelJob` implements the exact before/cancelled/after branching from
  ADR-0011's Cancellation pseudocode (§9 of this document), unit-tested for all three outcomes
  (200-cancelled, 200-idempotent-repeat, 409-conflict).
- **Regression risks**: R8, same as WP3.
- **Certification evidence required**: `tests/restRoutes.jobs.unit.test.js` passing, explicitly
  covering all three `DELETE` outcomes plus the 404 case.

### WP5 — Cross-cutting test suite

- **Objective**: every integration/contract/security test the ADR and Review Package name.
- **Affected files**: the 5 new/modified test files listed in §13's WP5 row (`restRoutes.contract`,
  `restIntegration`, `restBodySize.integration`, `restShutdown.integration`, `restSecurity`, plus
  `transportBoundary.test.js` extended).
- **Dependencies**: WP3, WP4. (The malformed-id regression test no longer depends on this WP — it
  moved to WP1, per §13's explicit mapping; independent-instance isolation is WP0-only and is not
  re-run here either.)
- **Acceptance criteria**: the two non-negotiable tests that gate at this WP pass — shared-instance
  parity (as a distinctly named test, §13) and shutdown-behavior; contract test's `deepEqual`
  cross-checks against direct service calls; security suite covers auth/path-traversal/CORS-absence/
  secret-non-leakage/default-bind/body-size-regardless-of-auth. The other two non-negotiable tests
  (malformed-id, independent-instance isolation) already passed at WP1/WP0 respectively and are not
  re-derived here — WP7's full-suite gate is what confirms they're still green.
- **Regression risks**: R3, R4, R7 (Review Package) — contract tests retrofitted after routes
  (mitigated: WP3/WP4's own unit tests are test-first; WP5's contract test is the suite-level proof,
  not the first test written for any route), performance baseline, Windows shutdown limits.
- **Certification evidence required**: full new-suite output; the contract test's pinned route
  table diffed against §1's actual file layout.

### WP6 — Documentation

- **Objective**: per §14.
- **Affected files**: `docs/REST_FREEZE.md` (new), `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/
  releases/KNOWN_LIMITATIONS.md`, `docs/releases/MIGRATION_GUIDE.md`, `package.json` (all modified).
- **Dependencies**: WP3, WP4, WP5.
- **Acceptance criteria**: `REST_FREEZE.md`'s frozen route table matches WP3/WP4's actual,
  contract-tested shapes exactly.
- **Regression risks**: none (docs only).
- **Certification evidence required**, checked file-by-file, not as one generic pass: `docs/
  REST_FREEZE.md`'s frozen route table diffed line-by-line against `tests/
  restRoutes.contract.test.js`'s pinned route list (WP5) — every path+method+status+shape entry
  must trace to a passing assertion in that file, none added or missing; `docs/releases/
  KNOWN_LIMITATIONS.md`'s five REST-specific entries (metrics/snapshot process-scoping, body-size
  MCP/REST divergence, ungraceful-shutdown platform limits, no ownership scoping, `FileJobStore`
  staleness) each cited against the ADR-0011 section that already discloses it; `CHANGELOG.md`
  contains one dated entry naming every WP0–WP5 file this document lists as new/modified, no more
  no less; `docs/ARCHITECTURE.md`'s file/directory diagram lists exactly the 9 `src/rest/` files
  plus `delegationBackend.js`/`restEntry.js` from §1, byte-comparable against that section;
  `docs/releases/MIGRATION_GUIDE.md` states REST is opt-in (a separate process) and names zero
  required changes for an MCP-only user — checkable by grep for any instruction implying MCP users
  must act; `package.json`'s version is bumped **minor** (per ADR-0011's own Versioning-section
  prediction, confirmed — not pre-assumed — against `docs/FOUNDATION_FREEZE.md`'s classification
  policy at this point, since zero frozen MCP contract changed).

### WP7 — Final certification gate

- **Objective**: per `REST_FOUNDATION_REVIEW_PACKAGE.md` §11, verbatim.
- **Affected files**: none (verification only).
- **Dependencies**: WP0–WP6.
- **Acceptance criteria / certification evidence required**: Review Package §11's 8 items, in full.
- **Regression risks**: none new.

---

## Final Check

**Design Package vs ADR-0011**: every module/function named above exists to implement a decision
ADR-0011 already made (Responsibilities' 6 buckets → 6 of the 9 `src/rest/` files; the Cancellation
pseudocode → `handleCancelJob` verbatim; the Shutdown semantics sequence →
`registerRestShutdownHandlers` verbatim; every named env var reused verbatim). No new architectural
decision is introduced — only the concrete values ADR-0011 explicitly deferred (port number, `limit`
clamp, `ConsumerRegistry` timing, exact file paths) are resolved, each with its reasoning traced
back to an existing ADR-0011 section or an existing codebase constant (§17).

**Design Package vs REST_FOUNDATION_REVIEW_PACKAGE.md**: WP0–WP7's objectives, dependencies, and
parallelization are unchanged from the Review Package; this document only adds file-level
granularity to acceptance criteria/regression risks/certification evidence, and extends §7's test
obligations to concrete file names. No WP is reordered, split, or merged.

**Intentional deviations**: "No deviations."

---

## Recommended next step

Stage C: a TDD implementation sprint executing WP0 → WP1 (parallel) → WP2 → WP3/WP4 (sequential,
per R8) → WP5 → WP6 → WP7, gated on the user's approval of this document. Not started here.
