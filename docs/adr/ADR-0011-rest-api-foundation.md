# ADR-0011: REST API Foundation

## Status

**Proposed — design only. No code changes in this ADR.** Named as the required next architecture
wave in two places already: `ADR-0010` §6 ("Stage 2 — REST API Foundation ADR + build. A thin
HTTP adapter mapping 1:1 onto `ObservabilityService`... and `DelegationService`...") and
`CAPABILITY_ROADMAP_REBASELINE.md`'s "Recommended next sprint" (item 2: *"draft a REST API
Foundation ADR (design only — framework choice, hosting/lifecycle model, auth model, versioning
policy separate from the MCP schema's own). No implementation until that ADR is reviewed and
approved, per this project's standing process."*). This document is that review artifact. It
proposes an architecture, not an implementation, and remains gated for the user's separate review
and approval before any implementation plan or TDD sprint begins — the same gate `ADR-0010` itself
sat behind before Stage 1a/1b shipped (v2.7.1, currently tagged and released).

Synthesizes four independent research passes — process/lifecycle, security/auth, endpoint
architecture, versioning/testing — each grounded in direct reads of the source files and prior
ADRs named throughout. Where two passes proposed different answers to the same open question
(there is exactly one such case — `getTimeline()`'s `{type, since}` filtering, see Filtering
below), this ADR states the reconciled decision explicitly rather than presenting both.

## Context

`ADR-0010` is fully implemented and released (`v2.7.1`). `ObservabilityService` (read side) and
`DelegationService` (write side, `src/services/delegationService.js`:
`submit`/`getJob`/`listJobs`/`cancelJob`) are the platform's two stable internal-API objects, held
side by side, never merged — `mcpServer.js` constructs both and every one of the 9 MCP tools is a
thin transport adapter over one or the other, with zero business logic of its own. This is the
single most consistently enforced architectural discipline in the project's history (`ADR-0007`,
`ADR-0008`, `ADR-0009` each added one MCP tool this way; `ADR-0010` formalized the write side to
match). REST is a **third transport** sitting on top of the same two objects — it extends this
discipline, it does not get an exception from it.

Two constraints established by prior ADRs shape everything below, and this ADR must address both
explicitly rather than gloss over them:

- **Process model mismatch (`ADR-0004`).** This project's MCP stdio transport has no startup guard
  — no lockfile, PID file, or port-bind check anywhere in `src/cli/entry.js`'s `main()` — and the
  process model is intentionally 1-process-per-client-window: each Claude Desktop window spawns
  its own `server.js`, its own in-memory `JobManager`. `ADR-0004` documents a known, unresolved
  limitation (stale/orphaned instances can silently split job state) pending host-behavior
  verification, not fixed in this ADR and not analogous to anything REST introduces (see MCP
  coexistence below). REST's entire value proposition — a long-lived, client-independent service —
  cannot be 1:1 coupled to a single stdio invocation's lifecycle the way MCP is today.
- **Zero auth/network-exposure precedent (`ADR-0001`, `docs/FOUNDATION_FREEZE.md`).** This
  project's entire security model to date is about local subprocess spawning:
  `config.claudeBin` is never spawned with `shell: true`, job ids are always `randomUUID()` output
  checked by `isValidJobId()` before any path join (`src/services/workspaceManager.js`), and
  `ExecutionContext.environment` is redacted before ever touching disk
  (`delegationService.js`'s own doc comment, `ADR-0001`'s `context.json` redaction). There is no
  existing concept anywhere in this codebase of "a caller who isn't implicitly trusted" — today's
  single stdio pipe to one MCP host *is* the trust boundary. REST introduces this project's first
  network-facing listener and its first untrusted caller. The project's own stated identity
  (`package.json`: *"billed against your existing Claude subscription... not a separate API
  key"*) is a real design input: a heavy enterprise auth stack would mismatch a low-friction local
  tool, but zero auth on a network listener — even localhost-bound — is a real, distinct risk from
  "no auth needed."

Governing documents this ADR must remain compatible with, cited by name throughout:
`docs/FOUNDATION_FREEZE.md` (frozen MCP schemas — untouched by this ADR), `docs/
OBSERVABILITY_FREEZE.md` (frozen `ObservabilityService` method table — untouched), `ADR-0002`
(frozen `RuntimeEventBus` event schema — untouched), `ADR-0003` (Passive Observation Rule,
Dependency Direction — extended, not re-derived, §"Transport independence" below), `ADR-0004`
(server instance lifecycle — the process-model constraint above), `ADR-0005` (persistent job
store — the one existing cross-process-sharing mechanism, and its real limits), `ADR-0010`
(Single Mutation Path Rule, the two-services decision, and this ADR's own Stage 2 mandate),
`CAPABILITY_ROADMAP_REBASELINE.md` (REST ranked above Dashboard/Analytics/Plugin-API, for the
reason repeated in Future Dashboard compatibility below).

## Goals

- Expose `DelegationService`'s four operations (`submit`/`getJob`/`listJobs`/`cancelJob`) and
  `ObservabilityService`'s four operations (`getMetrics`/`getSnapshot`/`replay`/`getTimeline`) over
  HTTP, as a long-lived, client-independent process — the property MCP's stdio transport
  structurally cannot provide (`ADR-0004`).
- Zero new business logic anywhere in the HTTP layer. Every route is a call into one of the two
  existing services, exactly as every MCP handler already is (`ADR-0010` §3/§4's rule, extended
  here to a second transport).
- A credible, minimal auth story appropriate to a first-ever network listener on a single-operator,
  local-first tool — real enough that "nothing stops any local process/browser tab from calling
  it" is no longer true, without imposing an enterprise identity stack this product's own ethos
  doesn't fit.
- A route surface and versioning scheme durable enough that Dashboard (`ADR-0010` Stage 3) can be
  built as a thin UI over REST alone, per `ADR-0010`'s own Stage 3 decision (in-process Dashboard
  colocation was already explicitly rejected there).
- Name, explicitly, every place REST's behavior will legitimately diverge from MCP's (blocking
  `delegate_task` has no mirror; error message strictness is stricter; metrics/snapshot are
  process-scoped; a repeat `DELETE` on an already-cancelled job is idempotent (200) under REST
  where MCP's `delegate_cancel` treats the identical state as a failure — see Cancellation; **a
  request body over 1 MiB is rejected by REST with 413 while the identical `prompt` submitted via
  MCP has no length limit at all today (`DelegateTaskInputShape.prompt` is a bare `z.string()`,
  `src/models/schemas.js` — confirmed by direct read) — see Security**) so no future reader mistakes
  a disclosed asymmetry for a bug.

## Non-goals

- **Not a second execution engine.** REST never spawns a subprocess, never constructs an
  `ExecutionContext`, never touches `claudeCliService` directly — it only ever reaches execution
  through `DelegationService.submit()`, exactly as every MCP handler does today.
- **Not a multi-tenant service.** No per-job ownership scoping, no per-caller identity, no
  concept of "caller A's jobs vs. caller B's jobs" in v1 (see Authorization). This is a
  single-operator tool gaining a local API, not a hosted product gaining users.
- **Not a public-internet API.** Binds to `127.0.0.1` by default; exposing beyond localhost is an
  explicit future decision with its own trigger (see Risk Analysis), not this ADR's scope.
- **Not a streaming/push transport.** No SSE, no WebSocket, no server-side long-poll in v1 (see
  Streaming, Long polling).
- **Not a rate-limited or quota-managed service.** Explicit non-goal, with a named trigger for
  revisiting (see Risk Analysis > Security).
- **Not a horizontally-scaled deployment.** One REST process per operator deployment is this ADR's
  entire assumed shape; multi-instance REST is explicitly deferred (see Risk Analysis > Scaling).
- **Not an OpenAPI/Swagger-documented API yet.** `REST_FREEZE.md`'s own frozen route table is the
  documentation until a second concrete external consumer needs machine-readable discovery (see
  Versioning).
- **Not a rename of any existing frozen contract.** `job.metadata.tool`/`JobQueued`'s `payload.tool`
  stay exactly as `ADR-0010` §2 already decided (unchanged); this ADR does not reopen that.
- **Not the Dashboard itself.** Stage 3 is its own future ADR, built on top of what this ADR
  freezes (see Future Dashboard compatibility).

## Responsibilities

Reusing `ADR-0010` §3's transport-adapter/service split verbatim, extended to a third transport.
Everything below stays in the new REST layer (a `src/rest/` module tree, name TBD at
implementation-plan time), never pushed into `DelegationService`/`ObservabilityService`:

1. **Protocol-specific request parsing** — path/query-param parsing, JSON body parsing. REST's
   equivalent of MCP's zod-validated tool input shapes (`JOB_ID_FIELD`, `DelegateTaskInputShape`).
2. **Protocol-specific response envelope** — a JSON body + HTTP status code, replacing MCP's
   `{content, structuredContent}` pairing.
3. **HTTP status-code mapping** — translating `getJob() === undefined` into 404, a thrown
   `ZodError` into 400, an unexpected `Error` into 500. REST's equivalent of
   `toToolErrorContent()`, but a distinct function (see Error model) because the trust boundary
   differs.
4. **Auth-token verification** — REST's equivalent of MCP SDK's own stdio session establishment;
   never leaks into either service, exactly as no MCP session concept appears in either service
   today.
5. **CORS policy enforcement** — meaningless to MCP's stdio transport; entirely new to this
   adapter, and entirely contained in it.
6. **Route/method registration** — REST's equivalent of `server.registerTool()`'s
   `title`/`description`/`annotations`.

`DelegationService`/`ObservabilityService` gain **zero new methods, zero new parameters, zero new
files** as a result of this ADR. The one narrow, disclosed exception — `getJob()`/`cancelJob()`
gaining an `isValidJobId()`-style format guard — is a hardening of an existing method's own input
handling, shared by MCP too, not new business logic (see Security).

## Transport independence

`ADR-0003`'s **Passive Observation Rule** and **Dependency Direction**, and `ADR-0010`'s **Single
Mutation Path Rule**, are reused here by reference, not re-derived — REST does not weaken or
special-case any of them:

- **Passive Observation Rule** (`ADR-0003`): `ObservabilityService` and everything beneath it
  remain strictly read-only regardless of which transport calls them. REST's read routes
  (`GET /v1/jobs/:id`, `/v1/jobs`, `/v1/metrics`, `/v1/snapshot`, `/v1/jobs/:id/replay`,
  `/v1/jobs/:id/timeline`) cannot mutate state through `ObservabilityService` because
  `ObservabilityService`'s API surface itself contains no mutating method — the same structural
  guarantee that already holds for MCP's `delegate_replay`/`delegate_metrics`/`delegate_snapshot`.
- **Dependency Direction** (`ADR-0003`): `RuntimeEventBus → Observability → {Dashboard, REST,
  Future Consumers}` — REST is added as a new leaf on the existing one-directional graph, not a
  new root. No REST route ever calls back into `JobManager`/`RuntimeEventBus` directly; it only
  ever calls `ObservabilityService`/`DelegationService`.
- **Single Mutation Path Rule** (`ADR-0010` §4): `JobManager.submit`/`_transition`/`_run` remains
  the one write path into job state. `DelegationService` adds no new mutation logic for REST's
  benefit — REST's `POST /v1/jobs` and `DELETE /v1/jobs/:id` call exactly `submit()`/`cancelJob()`,
  the same two methods MCP's `delegate_submit`/`delegate_task` and `delegate_cancel` already call.
  A future test can assert this the same way `ADR-0010` already proposes verifying it for MCP: one
  `JobManager` mutator call per `DelegationService` operation, never duplicated inline in a REST
  route handler.

The proof this is achievable, not aspirational: `ObservabilityService` has already been reused
verbatim by three independent MCP tools (`ADR-0007`/`0008`/`0009`) with zero lines changed beneath
it each time, and `DelegationService` was purpose-built in `ADR-0010` Stage 1b specifically to
generalize beyond MCP's five handlers. REST reusing the same two objects a fourth and a first time,
respectively, is the same pattern at a third transport, not a new one.

## Security

Full detail in Authentication/Authorization below and Risk Analysis > Security; this section
states the overall posture. REST is this project's first network listener, so its baseline
security decisions are:

1. **Bind to `127.0.0.1` by default**, never `0.0.0.0` without an explicit, separately-flagged
   operator opt-in (`CLAUDE_DELEGATE_REST_HOST`, defaulting to `127.0.0.1`).
2. **Mandatory bearer-token auth on every route**, including reads — localhost-bind alone does not
   defend against a same-machine browser tab firing a "simple request" (a CORS-preflight-exempt
   GET, or a `text/plain` POST) at `http://127.0.0.1:<port>`; the browser can't read the response,
   but the request's side effects (submitting a job that spends the user's Claude subscription
   usage, or cancelling one) still happen. This is the concrete reason token auth is required even
   though the listener never leaves the machine.
3. **No CORS allowance by default** — v1 has no browser-based consumer to accommodate (Stage 3
   Dashboard is future, undesigned); default-deny costs the real v1 use case (curl, scripts)
   nothing.
4. **No new attack surface on existing invariants** — every REST route reaches execution only
   through `DelegationService`/`ObservabilityService`; `config.claudeBin`'s `shell: false`
   invariant and job-id-before-path-join validation are structurally unaffected because REST never
   constructs its own subprocess call or filesystem path.
5. **Stricter, REST-specific error responses** — never `err.message`/`err.stack` verbatim into an
   HTTP body, unlike `toToolErrorContent()`'s existing (and, for its trust boundary, correct)
   pass-through behavior (see Error model).
6. **A bounded request body size on every route that accepts one** — an independent review
   correctly identified this as missing entirely from the first draft. Specified in full:
   - **Maximum accepted size: 1 MiB (`CLAUDE_DELEGATE_REST_MAX_BODY_BYTES`, overridable)**, applied
     only to `POST /v1/jobs` (the one route with a request body). Sized to comfortably fit a
     realistic `prompt` (tens of thousands of words of text is well under 1 MiB — roughly
     56–557 KiB at 5.7 bytes/word including the space, for 10,000–100,000 words of typical
     Latin-script text) while bounding a single request's worst-case memory footprint independent
     of trust level — this is a resource bound, not a trust decision; even a legitimate
     token-holder's request is capped. **Disclosed precisely, not glossed over**: unlike
     `JobManager`'s `maxConcurrentJobs`/`max_budget_usd`/`spawnTimeoutMs` (which are
     transport-agnostic, enforced inside `JobManager` itself for every caller), this bound is
     **REST-only** — MCP's `DelegateTaskInputShape.prompt` (`src/models/schemas.js`) is a bare
     `z.string()` with no length limit today, confirmed by direct read. This is therefore a real,
     new REST/MCP behavioral divergence for an identical oversized `prompt`, named explicitly in
     Goals rather than implied to be symmetric with the transport-agnostic bounds above.
   - **Threat model justification**: Risk Analysis > Security's existing reasoning ("any caller
     with the token is a fully-trusted actor already") correctly rules out rate-limiting untrusted
     volume, but does **not** cover a single oversized request's memory cost — hand-buffering an
     unbounded body over Node's raw `http` module (this ADR's own stated only-allowed dependency,
     see REST lifecycle) is a memory-exhaustion vector regardless of how trusted the sender is. This
     is a resource-safety control, orthogonal to the auth/authorization reasoning already stated.
   - **Enforcement location**: the REST transport-adapter layer only (Responsibilities bucket 1,
     "protocol-specific request parsing"), *before* the body is ever fully buffered or handed to
     `DelegationService.submit()`. Concretely: reject immediately if `Content-Length` exceeds the
     limit (no buffering at all); if `Content-Length` is absent or understated, abort the connection
     the moment accumulated bytes cross the limit while streaming — never buffer past the cap even
     temporarily, so a client that omits or lies about `Content-Length` gains nothing.
   - **Behavior when exceeded**: the connection/request is rejected before `JSON.parse` ever runs;
     no partial body is retained.
   - **HTTP status**: `413 Payload Too Large` (the standard status for this condition — deliberately
     not `400`, which this ADR reserves for content that was fully received but semantically
     invalid).
   - **Error schema**: the same unified shape as every other error (see Error model), with a new
     `code: "PAYLOAD_TOO_LARGE"` and a `message` naming the configured limit.
   - **Testing requirement**: see Testing Strategy > Integration and > Security.

## Versioning

**URL-path versioning**: `/v1/jobs`, `/v1/metrics`, `/v1/snapshot`, etc. — not header/
content-negotiation-based versioning (`Accept: application/vnd.delegate.v1+json` or a custom
version header). Three grounded reasons:

1. **Scale mismatch.** Header negotiation exists to let a fleet of independently-deployed clients
   pick a version against one shared multi-tenant server at runtime. This project has one
   operator, one deployment, one upgrade unit (the same `npm install`/process) — there is no fleet
   to negotiate with.
2. **Project convention.** Every existing versioning primitive in this codebase
   (`EVENT_SCHEMA_VERSION`, `ADR-0002`; `storeVersion`, `ADR-0005`) is a plain visible integer
   stamped into the artifact, not something negotiated via a header. URL-path versioning continues
   that convention directly; header-based versioning would be the first departure from it.
3. **Ergonomics matching the product's low-friction identity.** `curl localhost:<port>/v1/jobs` is
   self-documenting and pasteable into a browser bar with no custom-header knowledge required —
   the same anti-ceremony bias `package.json`'s own description already reflects.

Only the **major** version number appears in the URL, mirroring `docs/FOUNDATION_FREEZE.md`'s own
semver definition (only breaking changes get a visible signal). Minor/patch changes stay inside
`/v1`; there may never be a `/v2`.

**A new, sibling freeze document — `docs/REST_FREEZE.md`** — not a section bolted onto
`FOUNDATION_FREEZE.md` or `OBSERVABILITY_FREEZE.md`. Reasoning: `OBSERVABILITY_FREEZE.md` already
established that a genuinely distinct contract surface gets its own freeze doc even though both
describe pieces of the same running server. REST's contract (HTTP paths, methods, status codes,
JSON body shapes, query-param semantics, the auth-header contract, CORS policy, default bind
address) has zero overlap with `FOUNDATION_FREEZE.md`'s MCP-schema contract or
`OBSERVABILITY_FREEZE.md`'s method-table contract — a route can change without any MCP tool
changing, and vice versa. `REST_FREEZE.md`'s frozen scope explicitly does **not** re-govern
`DelegationService`/`ObservabilityService`'s own contracts (those stay under their existing freeze
docs); it freezes only the HTTP adapter layer, matching this ADR's own "thin adapter" framing.

`REST_FREEZE.md` itself is **not authored alongside this ADR**. This ADR only decides it will
exist and commits to its planned outline (Frozen sections / Compatibility guarantees / Extension
points / Versioning policy — patch = new optional field or route with no shape change, minor = new
route or optional field, major = path/method/status-code/shape/bind-default change / Breaking-
change policy / Deprecation policy / Release quality gates). It gets written at the end of the
Stage 2 implementation wave, once the routes it freezes actually exist and their exact shapes are
proven by the contract-test suite — mirroring exactly how `OBSERVABILITY_FREEZE.md` postdated
`ADR-0003`.

Versioning classification of this ADR itself: **N/A — no code, no version bump.** Stage 2's own
implementation will classify itself against `docs/FOUNDATION_FREEZE.md`'s policy when it ships
(expected: **minor**, since it adds new capability with zero change to any frozen MCP contract).

## Error model

One unified JSON error shape across every route:

```json
{ "error": { "code": "JOB_NOT_FOUND", "message": "No job found with id <job_id>" } }
```

An optional `details` array is appended only for validation errors (the underlying `ZodError`'s
`issues`) — additive to the same shape, never a second shape.

| Condition | Status | `code` |
|---|---|---|
| Unknown job id (`GET`/`DELETE /v1/jobs/:id`) | 404 | `JOB_NOT_FOUND` |
| `cancelJob()` returns `false` and the job is genuinely terminal (not the idempotent-repeat case) | 409 | `JOB_NOT_CANCELLABLE` |
| Invalid submit body (`ZodError` from `DelegateTaskInputSchema.parse` inside `DelegationService.submit()`) | 400 | `INVALID_INPUT` (+ `details`) |
| Bad query param (`status`/`type` enum, non-numeric `limit`) | 400 | `INVALID_QUERY_PARAM` |
| Malformed JSON body | 400 | `MALFORMED_BODY` |
| Request body exceeds `CLAUDE_DELEGATE_REST_MAX_BODY_BYTES` (default 1 MiB) | 413 | `PAYLOAD_TOO_LARGE` (see Security) |
| Missing or wrong bearer token | 401 | `UNAUTHORIZED` |
| Unexpected internal error | 500 | `INTERNAL_ERROR` (deliberately generic message) |

**Load-bearing detail, must not be lost at implementation time**: `DelegateTaskInputSchema.
parse(input)` is the first line of `DelegationService.submit()` and throws an uncaught `ZodError`.
For MCP this is redundant (the SDK's own zod validation already ran before the handler runs); for
REST it is the **only** validation path, since no SDK-level pre-check exists for an HTTP caller.
The REST route handling `POST /v1/jobs` must explicitly catch this and map it to 400 — without
that catch, an invalid POST body produces an unhandled exception surfacing as a raw 500.

**Deliberate, disclosed deviation from `toToolErrorContent()`** (`src/utils/errors.js`): that
function passes `err.message` through unmodified, which is correct for its own trust boundary — a
single trusted stdio pipe to one MCP host. REST's `INTERNAL_ERROR` response must **never** include
`err.message`/`err.stack`/filesystem paths — a REST-specific error mapper, distinct from
`toToolErrorContent()`, logs the full exception server-side only and returns a generic message over
the wire. This is a strengthening driven specifically by the trust-boundary change (network caller
is lower-trust than a stdio MCP host), not a claim that the existing rule was wrong for MCP.

**`delegate_replay`'s "unavailable is not an error" semantic is kept verbatim for REST**
(`ADR-0007`): `GET /v1/jobs/:id/replay` on a never-existed job id still returns **200**
`{source: "unavailable", timeline: []}`, a deliberate, disclosed asymmetry from `GET /v1/jobs/:id`'s
404 for the same id — called out explicitly here so it doesn't read as an inconsistency in
`REST_FREEZE.md` later. `job_id`/the `:id` path segment gets no extra UUID-shape validation beyond
what `DelegationService` itself now enforces (see Security) — any non-matching string simply
produces the same 404/200-unavailable outcome MCP already produces for a bad id today.

## Authentication

**Mechanism: a single shared-secret bearer token**, generated via `crypto.randomBytes(32)` at
first REST-process boot if `CLAUDE_DELEGATE_REST_TOKEN` is not set explicitly, persisted to a file
(`CLAUDE_DELEGATE_REST_TOKEN_FILE`, default `<project>/.delegate-rest-token`). This mirrors, in
**shape** only, the existing env-var-with-a-default pattern already used throughout
`src/config/index.js` (`workspaceRoot`, `jobStoreDir`, `eventHistoryDir` each resolve as `env.X ||
DEFAULT_X`) — precedent for "an env var overrides a computed default" being this codebase's
established idiom. Those three, however, are static computed directory-path defaults (a fixed path
under `PROJECT_ROOT`, or the env var passed through verbatim) — never anything cryptographically
random, and never generated-once-then-persisted-to-disk at boot. The generate-a-secret-and-persist-
it-to-a-file **mechanism** itself — `crypto.randomBytes(32)` plus a first-boot write to
`CLAUDE_DELEGATE_REST_TOKEN_FILE` — is genuinely new to this codebase; it exists because REST is
the first component that needs a secret at all, not because a prior instance of this exact
mechanism already runs today. Stated plainly here rather than overstating existing precedent for
it.

- Sent only via an `Authorization: Bearer <token>` header — never a query string (avoids leaking
  the token through URL logging, `Referer` headers, or caching).
- Compared with `crypto.timingSafeEqual` after an explicit length check, never `===`.
- Required on **every** route, including `GET` — read routes can return prompts/results/errors
  that may contain sensitive content, so a read-only route is not a lower-risk route.
- The token value is **never logged**, only that one was generated and where — extending
  `ADR-0001`'s existing environment-redaction discipline to this new secret, not inventing a new
  rule.
- Treated explicitly as a **distinct concept from the Anthropic billing API key**
  `package.json`/`README.md` disclaim ("not a separate API key") — this token authenticates local
  callers of *this tool's own* REST listener; it has nothing to do with Claude subscription
  billing. `REST_FREEZE.md` should state this distinction plainly so a reader never conflates the
  two.
- This design is closer to the project's own "no separate API key" ethos than OAuth or mTLS with
  CA management would be: one local file, no login flow, no third-party identity provider — while
  still being a real, necessary credential given a network listener now exists where none did
  before.

**Alternatives considered and their disposition:**

- **Localhost bind alone, no token**: rejected. Defends only against remote/LAN attackers, not the
  concrete same-machine browser-CSRF-style threat named in Security above — a malicious page in
  any other tab can still fire a state-changing request the browser's same-origin policy does not
  block at the network layer, only at the JS-readback layer.
- **Unix domain socket / Windows named pipe** (`http.createServer().listen(path)`, no new
  dependency): flagged as *strictly more secure in principle* — browsers cannot originate
  socket/pipe connections at all, eliminating the whole browser-CSRF class rather than mitigating
  it — but **not** the v1 default, because it would foreclose Stage 3's own stated plan ("Dashboard
  as a thin browser UI over REST," `ADR-0010` §6) without a browser-reachable bridge process.
  Recorded as a legitimate, low-cost, explicitly-deferred future opt-in transport mode for
  automation-only callers who don't need browser access, consistent with this project's repeated
  "don't build ahead of a concrete second consumer" discipline (`ConsumerRegistry`'s deferred push
  semantics, `ADR-0003`).
- **OAuth / mTLS with certificate management**: rejected as a mismatch for a single-operator,
  local-first tool — real complexity cost with no concrete multi-tenant need to justify it (see
  Authorization).

## Authorization

**No per-job ownership scoping in v1.** Any caller holding the valid shared-secret token may
`get`/`list`/`cancel` **any** job by id, full stop. This is a definitive decision, not an
open-ended deferral, for four grounded reasons:

1. **Nothing to scope against.** `JobManager`/`DelegationService` have zero submitter-identity
   concept anywhere today — `job.metadata` records only `{tool: toolName, ...}` (unchanged per
   `ADR-0010` §2), never a caller id. Retrofitting REST-side ownership scoping over a backend with
   no identity plumbing would be scoping against nothing real.
2. **v1's credential model is single-tenant by construction** (§Authentication) — exactly one
   shared secret exists, so there is exactly one class of authenticated caller ("someone who
   possesses the token," presumed to be the machine owner or their own script). "Caller A vs.
   caller B" is a distinction v1 has no way to draw.
3. **Matches the existing MCP trust model exactly.** Today's single stdio pipe already lets its one
   caller see/cancel every job regardless of which tool or session created it. REST introducing
   scoping MCP itself never had would be a new, asymmetric restriction, not a preserved invariant.
4. **Avoids building speculatively.** Same discipline this project has applied repeatedly
   (`ConsumerRegistry`'s deferred push semantics, `subscribeToJob()`'s deferred generalization,
   both `ADR-0003`/`ADR-0010` §4) — building authorization machinery ahead of a concrete
   multi-caller need would be exactly that pattern.

**Concrete trigger, not a vague deferral**: ownership scoping must be (re-)decided, as its own
design step, before any future version ever issues more than one distinct REST credential. Do not
add a second token/API key to this system without deciding this first.

## Compatibility with existing MCP transport

**Zero MCP schema change.** `docs/FOUNDATION_FREEZE.md`'s nine frozen tool schemas, the frozen
execution contract's sync/async shapes, the frozen Job lifecycle, and the frozen `ExecutionContext`
contract are all unaffected — REST is purely additive, in new files, calling the same two already-
frozen services.

**Process-level relationship, stated precisely (this is the crux of "compatibility" for this
ADR, not an afterthought):** REST runs as its own standalone, long-lived process — a new
`src/cli/restEntry.js` entry point, never a flag inside the existing `src/cli/entry.js` stdio
process, and never a code path reachable from stdio's `main()`. Justification, from direct reads:
`createMcpServer()` (`src/server/mcpServer.js`, construction block ~lines 93–141) constructs a
fresh `JobManager` + `RuntimeEventBus` + `ObservabilityService` + `DelegationService` inline on
every call, with no module-level singleton anywhere; `RuntimeEventBus`
(`src/services/runtimeEventBus.js`) is a bare in-process `node:events.EventEmitter` — confirmed no
cross-process transport exists anywhere in this codebase today. Running REST inside the same
process as a live stdio session (via a flag) would just relocate MCP's client-coupling problem
(`ADR-0004`) onto REST, defeating the entire point of a long-lived, client-independent API.

**A second MCP-analogous instance question does *not* apply to REST the way `ADR-0004`'s orphan
defect applies to stdio.** `ADR-0004`'s defect requires (a) legitimate concurrent peer instances
being expected/normal (true for stdio's one-process-per-client-window model) plus (b) no OS-level
mechanism catching a stale extra one. REST's design has exactly one long-lived process by intent —
a second one appearing is unambiguously wrong, and is caught for free by TCP port-bind
(`EADDRINUSE`) if REST uses a fixed, documented default port. No lockfile/PID-check invention is
needed here, unlike the open, unresolved question `ADR-0004` still carries for stdio.

**Preparatory refactor named, not silently assumed**: a clean `restEntry.js` needs the construction
block currently inlined in `createMcpServer` extracted into a transport-agnostic
`createDelegationBackend({config, logger})` helper returning `{jobManager, bus,
observabilityService, delegationService, eventHistoryStore}`, reused by both `createMcpServer`
(stdio) and a new `createRestServer`/route-registration function (REST). Without this, REST would
either copy-paste the construction block (drift risk over time) or import `createMcpServer` itself
and discard its unwanted `McpServer`/tool-registration side effects — wasteful and semantically
wrong. This ADR names the refactor as a required prerequisite and recommends it ship as its own
small, dedicated patch immediately before Stage 2's route-building work, not silently bundled into
it (see Migration Strategy > Rollout).

## Compatibility with DelegationService

REST calls exactly the four existing methods, unchanged, with zero new parameters:
`submit(input, "rest")`, `getJob(jobId)`, `listJobs({status, limit})`, `cancelJob(jobId)`. The one
narrow, disclosed addition: an `isValidJobId()`-style UUID-format guard added **inside
`DelegationService.getJob()`/`cancelJob()` themselves** (shared by MCP too, benefiting it as well),
since direct reads confirm both currently accept a bare, unvalidated string.

**Exact behavior, specified precisely (an earlier draft left this ambiguous — an independent
review correctly flagged it as a regression risk):** the guard returns exactly what today's
lookup-miss path already returns for an unrecognized-but-well-formed id — `getJob()` returns
`undefined`, `cancelJob()` returns `false` — for a malformed id too. **It never throws.** A
malformed id is treated identically to an unknown id at every layer above `DelegationService`: MCP
sees the same `"No job found with id <job_id>"` / `isError: true` response it already produces
today for any id `jobManager.getJob()` doesn't recognize (`delegateStatusHandler.js`,
`delegateCancelHandler.js`); REST sees the same 404 `JOB_NOT_FOUND` (see Error model) it already
returns for a well-formed-but-unknown id. **Malformed and unknown are deliberately
indistinguishable to every caller of either transport** — this is a `404`/"not found" outcome, not
a structured `400`-class validation error, precisely because distinguishing them would be new,
observable behavior neither `delegate_status`/`delegate_cancel` nor this ADR's own route table
promised.

**Why this specific choice, not a thrown/400 alternative:** a thrown error (mapped to REST's
`INVALID_QUERY_PARAM`/`400`, or an uncaught exception surfacing to MCP as an unhandled rejection)
would be new, observable behavior for a case both existing MCP handlers currently handle
gracefully with zero try/catch anywhere in their bodies — a real risk to tools
`docs/FOUNDATION_FREEZE.md` governs, and the exact regression an independent review of this ADR
identified. Returning the guard's result through the *same* code path an unrecognized id already
takes (rather than a new branch) is what makes "existing MCP behavior remains provably unchanged"
true by construction, not by assertion — the guard is purely an early, cheap format check that
short-circuits *before* a doomed `Map`/cache lookup, never a new decision point with a new outcome.

**Explicit statement**: existing MCP behavior for `delegate_status`/`delegate_cancel` given a
malformed job id is **unchanged** by this addition — before and after, the observable result is
identical (`isError: true`, `"No job found with id <job_id>"`). See Testing Strategy > Unit and
Testing Strategy > Integration for the regression-test requirement this implies.

`submit()`'s existing `DelegateTaskInputSchema.parse(input)` call is REST's entire input-validation
path (see Error model) — no second validation layer is introduced. `job.metadata.tool` continues
storing the caller's tool/transport label; REST's calls pass `"rest"` in that slot, exactly the
same shape `"delegate_task"`/`"delegate_submit"` already occupy, per `ADR-0010` §2's decision not
to rename this field.

## Compatibility with Observability

REST calls exactly the four existing methods, unchanged: `getMetrics()`, `getSnapshot()`,
`replay(jobId)`, and — newly exposed via REST only, not via any MCP tool — `getTimeline(jobId,
{type, since})` (see Filtering). `ObservabilityService`'s Passive Observation Rule is unaffected;
no REST route can reach a mutator through it (see Transport independence). `SnapshotBuilder`'s
`structuredClone()` + `Object.freeze()` immutability guarantee applies identically regardless of
which transport calls `getSnapshot()`.

**One real limitation this ADR must disclose, not paper over**: `getMetrics()`/`getSnapshot()`
report only the calling **process's own** accumulated counters since that process's own boot —
`MetricsCollector`/`TimelineStore` are constructed fresh per process inside
`createObservabilityService`, never persisted anywhere. A REST `GET /v1/metrics` call reports a
different, REST-process-only counter set from what `delegate_metrics` shows in a concurrently
running MCP session, `jobStore=file` or not. This is the single most likely user-visible surprise
if left undocumented (see MCP coexistence, Operational risks) — this ADR resolves it as **(a)
document the limitation clearly in the REST response/docs**, not (b) build cross-process metrics
aggregation now (which would require a new persistence mechanism for `MetricsCollector`'s
aggregates that does not exist today in any form, and no concrete consumer has asked for it).

## Future Dashboard compatibility

`ADR-0010` §6 already decided Stage 3 (Dashboard) is a thin UI over REST, **explicitly rejecting**
an in-process Dashboard calling `ObservabilityService`/`DelegationService` directly — that would
recreate the exact redundant-parallel-path problem `ADR-0010` Stage 1 exists to eliminate on the
write side, one layer up. This ADR's job is to make that Stage 3 decision buildable without forcing
REST to guess at Dashboard's needs speculatively:

- **Polling, not push, is sufficient for v1** and remains Dashboard's expected integration model —
  `GET /v1/jobs/:id` (optionally `since`-filtered via `/v1/jobs/:id/timeline`) covers "catch me up"
  without a live channel (see Streaming).
- **`ConsumerRegistry`** (`registerConsumer`/`touchConsumer`/`unregisterConsumer`/`listConsumers`/
  `getConsumerHealth`/`getConsumerStatistics`) is exactly the shape `ADR-0010` §5 named as fitting
  "a long-lived REST/Dashboard backend process" registering itself once at boot/shutdown. Whether
  `restEntry.js` wires this in at Stage 2, or defers until Dashboard (a second concrete consumer)
  materializes, is left as an explicit open decision for the Stage 2 implementation plan (see
  Recommended next step) — not resolved here, consistent with "not built speculatively" (`ADR-0003`).
- **CORS**: v1 ships default-deny (see Security). When Dashboard is designed, that future ADR adds
  a narrow, explicit allowlist scoped to wherever Dashboard is actually served from — not
  preemptively opened here.
- **No route shape in this ADR is Dashboard-specific** — every route exists because an MCP tool
  already needs the equivalent capability (see route table). Dashboard consuming the same routes
  later is a consequence of REST's design, not a requirement that shaped it, matching `ADR-0010`'s
  own "same backend, two transports" framing extended to three.

---

# Endpoint Architecture

## REST lifecycle (full route table)

Base path `/v1` (see Versioning). All bodies `application/json`. Request field names for
submission are kept byte-identical to `DelegateTaskInputShape` (snake_case: `prompt`, `model`,
`effort`, `allowed_tools`, `trust_all`, `cwd`, `max_budget_usd`) specifically so
`delegationService.submit(req.body, "rest")` can be called with **zero transformation** — real
"reuse verbatim," and it makes `DelegateTaskInputSchema.parse()`'s zod issues directly meaningful
to a REST caller with no translation layer.

| MCP tool | Method + path | Service call (verbatim) | Notes |
|---|---|---|---|
| `delegate_submit` | `POST /v1/jobs` | `delegationService.submit(body, "rest")`, then `getJob(jobId)` | 202 Accepted, `Location: /v1/jobs/{job_id}` header, body `{job_id, status}` |
| `delegate_task` | **No 1:1 mirror** — see Async jobs | n/a | `POST /v1/jobs` always behaves like `delegate_submit` (async, never blocking) |
| `delegate_status` | `GET /v1/jobs/:id` | `delegationService.getJob(id)` | 200 = `JobView` verbatim; 404 if `undefined` |
| `delegate_history` | `GET /v1/jobs?status=&limit=` | `delegationService.listJobs({status, limit})` | 200 `{jobs, count, limit}`; no cursor in v1 (see Pagination) |
| `delegate_cancel` | `DELETE /v1/jobs/:id` | `delegationService.cancelJob(id)` (+ `getJob` before/after) | 200 / 404 / 409 — see Cancellation |
| `delegate_replay` | `GET /v1/jobs/:id/replay` | `observabilityService.replay(id)` | 200 always, even `source: "unavailable"` — never 404, matches `ADR-0007` |
| `delegate_metrics` | `GET /v1/metrics` | `observabilityService.getMetrics()` | 200, verbatim; process-scoped (see Compatibility with Observability) |
| `delegate_snapshot` | `GET /v1/snapshot` | `observabilityService.getSnapshot()` | 200, verbatim |
| `delegate_models` | `GET /v1/models` | new shared `buildModelsInfo(config)` helper | see note below — not on either service today |
| *(new, REST-only)* | `GET /v1/jobs/:id/timeline?type=&since=` | `observabilityService.getTimeline(id, {type, since})` | see Filtering — disclosed trade-off vs. `/replay` |

**`delegate_models` is a real, pre-existing exception to "everything routes through the two named
services,"** not something this ADR introduces: `delegateModelsHandler.js` reads
`config.modelFallbacks` plus `MODELS`/`EFFORTS` from `src/models/schemas.js` directly today,
bypassing both services (confirmed by direct read). Recommend extracting the existing ~8-line body
into a small shared pure helper, `buildModelsInfo(config)`, imported by both the MCP handler and
the new REST route — a refactor of already-existing logic into one place, not new business logic,
but named explicitly here rather than silently patched over.

Implementation constraint carried into Stage 2 (not re-litigated here beyond naming it): the HTTP
layer uses Node's built-in `http` module only — no new production dependency — consistent with
this project's existing "no new production dependency" precedent (`ADR-0005`'s `FileJobStore` used
only `node:fs`).

## Pagination

`GET /v1/jobs?status=&limit=` maps 1:1 onto `delegationService.listJobs({status, limit})` **exactly
as it exists today** — "most recent N," no cursor — matching MCP's own scope precisely. Two
findings inform this:

- **No cursor is buildable without a service-layer change.** `listJobs()` has no way to request
  "all matching jobs, unbounded, then let me slice" — every call implicitly caps at `limit`
  (default 20). Real cursor pagination (e.g. a `before=<job_id>` param) would require extending
  `DelegationService.listJobs()`'s own signature/return shape — additive, non-breaking, but a
  `DelegationService` capability decision, not a REST-route concern. Explicitly deferred until a
  concrete need materializes (e.g. a future Dashboard "load more"), mirroring how `ADR-0007`
  deferred `type`/`since` filtering before a concrete consumer needed it.
- **`limit` is unvalidated/unclamped inside `listJobs()` itself.** Today's only clamp is the
  MCP-layer zod schema (`z.number().int().positive().default(20)`, no `.max()`); a REST caller
  hitting the service directly could pass an arbitrarily large `limit` with zero server-side guard.
  **Decision**: the REST route clamps `limit` itself (protocol-specific validation, the same bucket
  MCP's own zod schema already lives in per `ADR-0010` §3 item 1) — e.g. reject or cap at a fixed
  ceiling, decided at Stage 2 implementation-plan time. A shared clamp inside `listJobs()` itself,
  for symmetry, is noted as a small companion option, not required by this ADR.

Response body: `{jobs: JobSummary[], count, limit}` — no fabricated `total` or cursor field that
doesn't function yet.

## Filtering

`GET /v1/jobs/:id/replay` (no query params) maps to `observabilityService.replay(jobId)` verbatim
— identical to MCP's `delegate_replay`, byte-for-byte, provable directly in the contract-test suite
(see Testing Strategy > Contract).

**`getTimeline()`'s `{type, since}` filtering — the one question `ADR-0010` §5 explicitly assigned
to this ADR rather than deciding itself — is resolved as its own additive endpoint,
`GET /v1/jobs/:id/timeline?type=&since=`, separate from `/replay`.** (Two research passes proposed
different shapes here — a query parameter switching `/replay`'s own behavior, versus a wholly
separate endpoint. This ADR picks the separate endpoint, for a reason neither pass in isolation
weighed against the other: keeping `/replay`'s cross-transport contract byte-identical between MCP
and REST is directly provable in the contract-test suite only if `/replay` never changes behavior
based on query params; a separate endpoint keeps that contract clean while still adding
poll-specific filtering as a clearly-additive, REST-only capability — consistent with both this
ADR's own versioning policy and `REST_FREEZE.md`'s planned "new read-only endpoint is additive"
rule.)

`type` is validated at the route against the known `EVENT_TYPES` enum (`JobQueued`,
`JobStateChanged`, `JobProgress`, `OutputChunk`, `JobCompleted`, `JobFailed`, `JobCancelled`,
`ArtifactCreated`, `WorkspaceCreated`, `WorkspaceDeleted`) before calling `getTimeline`, returning
400 `INVALID_QUERY_PARAM` on an unrecognized value — protocol-specific input validation, squarely a
transport-adapter responsibility.

**Disclosed trade-off, not a bug**: `getTimeline()` is `TimelineStore`'s raw in-memory-only lookup —
it has none of `replay()`'s source/fallback-tier degradation (`runtime`/`workspace`/`unavailable`).
A call to `/v1/jobs/:id/timeline` on an evicted or restarted job's id returns an empty array with
**no `source` field**, unlike `/replay`'s response. This asymmetry is documented explicitly in
`REST_FREEZE.md` and the API docs so it never reads as an inconsistency.

## Streaming

**No SSE/WebSocket streaming endpoint in v1.** Reasoning tied directly to this project's own
established discipline, not a generic "not now": MCP's only push mechanism
(`forwardJobProgressToMcp`/`notifications/progress`) is explicitly named protocol-specific in
`ADR-0010` §3 item 5, and §4 explicitly declined to generalize it into a `subscribeToJob()`
primitive "until a second concrete consumer exists to validate the right shape." Stage 3
(Dashboard) — the concrete second consumer that would actually need live push — is itself deferred,
sitting on top of REST, not built alongside it. Building SSE now would mean extending
`jobManager.bus`'s one documented access exception to a second transport before that exception's
own author-ADR sanctioned it, or inventing `subscribeToJob()`'s shape speculatively — both are the
exact anti-pattern `ADR-0003`/`ADR-0010` already named and avoided for `ConsumerRegistry`'s push
semantics. Job durations here (CLI subagent calls, seconds to a few minutes) tolerate coarse
client-side polling fine; `GET /v1/jobs/:id/replay` and the `since`-filtered timeline endpoint
already cover "catch me up" without a live channel.

**Recommendation**: SSE/WebSocket streaming is designed together with Stage 3's Dashboard ADR, when
`subscribeToJob()` gets its real first concrete consumer — not bundled into this ADR (named again
in Risk Analysis > Future extensibility as an explicit decline-with-trigger).

## Async jobs

`POST /v1/jobs` → **202 Accepted**, `Location: /v1/jobs/{job_id}` header, body `{job_id, status}`
(status usually `"queued"`). The client then `GET`s the `Location` URL at its own cadence. A
`Retry-After: 2` response header is attached to `GET /v1/jobs/:id` whenever the returned status is
non-terminal — a standard, cheap, HTTP-native hint to well-behaved clients about polling cadence;
pure header formatting, zero service change.

**Why `delegate_task`'s blocking behavior is deliberately not mirrored**: `delegate_task` blocks on
`jobManager.waitForCompletion(jobId)`, bounded only by `config.spawnTimeoutMs` (default 10
minutes). Mirroring this as a blocking `POST` would hold an HTTP connection open for up to 10
minutes against proxy/load-balancer defaults routinely far shorter (nginx `proxy_read_timeout` 60s,
many ALB idle timeouts 60s, common corporate proxies 30s) — concretely:

- A proxy could return 504 while the job is genuinely still running server-side, with no
  cancellation signal sent; the job keeps running, orphaned from the client that gave up.
- A client that times out and naively retries duplicates the job (no idempotency key in this
  design), doubling CLI spend.
- The REST process would pin one HTTP worker/request-thread per in-flight job for the job's entire
  duration — directly working against a REST API's whole point (serving many concurrent short
  requests from a long-lived process).

This operationalizes a call `ADR-0010` §4 already made structurally: `waitForCompletion`/`bus` stay
a documented exception held only by `delegateTaskHandler.js`; *"REST/Dashboard adapters would poll
`getJob`/`listJobs`... never block a request thread on a CLI subprocess."* `POST /v1/jobs` (202) +
poll `GET /v1/jobs/:id` **is** the REST equivalent of `delegate_task` — this behavior gap from the
9-tool list is deliberate and is stated here explicitly, not left implicit.

## Cancellation

`DELETE /v1/jobs/:id` → `delegationService.cancelJob(id)`, with an explicit routing rule for a
real ambiguity: `JobManager.cancelJob()` returns `false` for **both** "unknown id" and
"known-but-already-terminal." Today's MCP handler disambiguates only by calling `getJob` before and
after; REST must do the same:

```
before = delegationService.getJob(id)
if (!before) → 404 { error: { code: "JOB_NOT_FOUND" } }

cancelled = delegationService.cancelJob(id)
after = delegationService.getJob(id)

if (cancelled)                        → 200 { job_id, status: after.status }   // accepted; may still be settling
else if (after.status === "cancelled") → 200 { job_id, status: "cancelled" }    // idempotent repeat DELETE — see disclosed asymmetry below
else                                    → 409 { error: { code: "JOB_NOT_CANCELLABLE" } }
```

409 is reserved for the genuine conflict: the job reached `completed`/`failed` before cancellation
could take effect. Zero change to `cancelJob()`'s boolean return or `JobManager`'s state machine
either way — the routing logic above only re-interprets an existing boolean at the HTTP layer, it
does not alter what that boolean means or how `JobManager` computes it.

**Deliberate, disclosed asymmetry from MCP** (per this ADR's own Goals-section commitment to name
every such divergence, alongside blocking `delegate_task`, error-message strictness, and
metrics/snapshot process-scoping): a repeat `DELETE` on an already-cancelled job is a case where
REST and MCP genuinely diverge in observable behavior for the identical server state, not merely in
transport encoding of the same outcome. MCP's `delegate_cancel` tool is registered with
`idempotentHint: false` (`src/server/mcpServer.js:224`), and its handler
(`src/handlers/delegateCancelHandler.js:9-19`) returns `isError: true` — *"Job `<id>` could not be
cancelled (status: cancelled)"* — for exactly the state (`cancelJob()` returns `false` because the
job is already `cancelled`) that this REST design instead maps to a **200** success response. This
ADR chooses idempotent-`DELETE` semantics for REST (matching ordinary HTTP convention, where
repeating a successful `DELETE` should not itself become an error) over mirroring MCP's stricter,
non-idempotent framing for that same state — a considered choice, not an oversight, but a real
behavioral divergence a caller could observe by driving both transports against the same job. It is
named here explicitly, alongside the `/replay` status-code asymmetry (Error model) and the
`/timeline` source-field gap (Filtering), rather than left filed only as "a pure status-code mapping
decision."

## Long polling

**No server-side long-poll (`?wait=<ms>`) in v1.** Same reasoning as Async jobs above: an opt-in
bounded long-poll on `POST /v1/jobs` or `GET /v1/jobs/:id` was considered and rejected because it
(a) reintroduces the same resource-pinning/proxy-timeout risk, just opt-in rather than default; (b)
would require `jobManager.waitForCompletion` as a second REST-side exception to the "only
`DelegationService`'s four methods" rule `ADR-0010` §1 draws explicitly ("no other transport
adapter... gets this exception"); (c) no concrete consumer has asked for it. Plain immediate-
response polling, with the `Retry-After` hint named in Async jobs, is the whole v1 design.

---

# Migration Strategy

## MCP coexistence

**Stated plainly, not implied: by default, REST and any given MCP stdio session are operationally
separate job universes.** `createMcpServer()` constructs a fresh `JobManager`/`RuntimeEventBus`
inline per invocation, and `RuntimeEventBus` is a bare in-process `EventEmitter` — there is no
cross-process state-sharing mechanism anywhere in this codebase today. Two processes, two
in-memory worlds, full stop, unless both are explicitly configured to share persisted state (below).

**What `config.jobStore="file"` (`ADR-0005`) actually gives, precisely — necessary but far from
sufficient for parity:**

- Both processes pointed at the same `config.jobStoreDir` can each see any **terminal-or-not** Job
  record that existed on disk as of **their own** `FileJobStore`'s last hydration — confirmed by
  direct read of `src/services/fileJobStore.js`: `hydrate()` runs exactly once, in the constructor;
  `get()`/`list()` read only `this.cache`, populated at that one pass. There is no re-read of the
  directory on subsequent calls.
- Concretely: a REST process that boots **after** an MCP session has already been running only ever
  sees jobs that existed on disk *at REST's own startup*. Any job the MCP session submits
  afterward is invisible to REST (a 404 on `GET /v1/jobs/:id`) until REST restarts. `ADR-0005`
  itself already disclaims this as a single-process assumption "unchanged from every other
  component in this codebase" — this is not a REST-specific gap to fix, it is an existing, explicit
  non-goal of `FileJobStore` this ADR states plainly rather than implying "shared directory =
  shared state."
- `JobManager`'s own scheduling internals — the `pending` array, the `running` `Map<id,
  AbortController>`, the `waiters` `Map` — are **never persisted**, jobStore=file or not. REST's
  `cancelJob(id)` can only ever abort a subprocess actually running inside REST's **own** process's
  `JobManager`, never one MCP is actually executing, even against a shared `jobStoreDir`.
- `RuntimeEventBus` events (`JobQueued`/`JobStateChanged`/`JobCompleted`/`OutputChunk`) never cross
  a process boundary — confirmed by `runtimeEventBus.js` being a bare `node:events.EventEmitter` —
  so no live progress/notification data from an MCP-submitted job ever reaches REST.
- `MetricsCollector`/`TimelineStore` (`ObservabilityService`'s substrate) are constructed fresh per
  process, never persisted anywhere — a REST `GET /v1/metrics`/`GET /v1/snapshot` call reports
  only REST's own process's own accumulated counters since its own boot, `jobStore=file` or not
  (restated from Compatibility with Observability because it is this section's most important
  practical consequence).
- `config.eventHistory="file"` (`ADR-0006`) is a **separate** opt-in (separate directory, separate
  flag) that persists per-job event timelines to `<job-id>.jsonl`, feeding `replay()`'s durable
  tier for a specific job id. Useful for REST too, but it still does not feed aggregate
  `getMetrics()` counters or live in-flight progress.
- `ConsumerRegistry` is pure in-memory with no persistence option, explicitly designed (`ADR-0010`
  §5) as "one registration per backend process instance" — inherently process-scoped by design,
  not a gap to close.

One piece of `ADR-0005` genuinely does carry over usefully, at no extra design cost: its
non-terminal-job-recovery-at-hydration logic ("a job that was queued/starting/running when the
process died... is rewritten in place as failed") already gives REST correct crash-recovery
semantics for free, if it runs with `jobStore=file` — an ungracefully-killed REST process leaving
stale non-terminal job state is already solved, not a new gap for this ADR to design. See Migration
Strategy > Shutdown semantics below for the full specification of both graceful and ungraceful
process-exit behavior, including how this recovery mechanism interacts with each.

## REST coexistence

Exactly one long-lived REST process is this ADR's assumed shape (see Compatibility with existing
MCP transport, Risk Analysis > Scaling). A second REST process attempting to bind the same port is
caught for free by TCP `EADDRINUSE` if REST uses a fixed, documented default port
(`CLAUDE_DELEGATE_REST_PORT`) — no lockfile/PID-check invention needed, unlike stdio's still-open
`ADR-0004` question. Multiple REST processes on different ports (e.g. one per project directory) is
technically possible under this design but explicitly out of scope to design for — each would be
its own independent job universe under the same "separate process = separate in-memory state"
rule already established above, and no concrete consumer has asked for that shape.

## Rollout

**Stage A (now)**: this design-only ADR, gated for review/approval before any code — the same
standing gate `PUSH_REPORT.md`-style governance already applied to `ADR-0010`.

**Stage B**: explicitly **skippable**, not silently omitted. Direct reads confirm
`tests/delegationService.test.js` and `tests/observabilityService.test.js` already exercise
`submit`/`getJob`/`listJobs`/`cancelJob` and `getMetrics`/`getTimeline`/`replay`/`getSnapshot`/
consumer-registry directly against the service objects, independent of any MCP handler. Unlike
`ADR-0010`'s Stage 1a (which had to characterize handler-embedded logic before extracting it into a
service), REST is purely additive on top of an already-proven, already-frozen internal API. Nothing
pre-existing needs pinning before REST work starts. Stating this explicitly, rather than silently
skipping the stage, mirrors this project's own discipline of not skipping verification even when it
looks obviously unnecessary.

**Stage C**: its own implementation-plan/design-package document (mirroring
`STAGE_1B_DESIGN_PACKAGE.md`'s precedent), built test-first per this project's standing TDD
discipline, with dedicated PR(s) reviewed independently of this ADR. This is this ADR's
Recommended next step, detailed below — not code, a plan.

**Concrete rollout mechanics, decided here rather than left to Stage C to discover:**

- The preparatory `createDelegationBackend({config, logger})` extraction (Compatibility with
  existing MCP transport) ships as its own small, dedicated patch immediately before Stage 2's
  route-building work — not silently folded into it, so `restEntry.js` never has the chance to
  copy-paste `mcpServer.js`'s construction block and drift from it over time.
- REST defaults to **off via simple non-invocation** of `restEntry.js` — no separate process
  running means no REST, full stop. This is the right granularity for the existing "byte-identical
  unless explicitly opted into" pattern (`config.jobStore`, `config.eventHistory`): a whole new
  binary the operator chooses to run, not a conditional branch inside the existing one.
- REST must **never** be auto-started from the existing per-client-window `entry.js`. Doing so
  would (a) reintroduce `ADR-0004`'s per-client-window coupling one layer up, (b) silently open
  this project's first-ever network listener as a side effect of opening a Claude Desktop window —
  directly contradicting the low-friction/implicitly-trusted-local-tool identity named in Context —
  and (c) risk port-bind collisions across N concurrently-open MCP windows with no existing
  arbitration logic to resolve them.
- REST's own bind host/port default to `127.0.0.1` and a documented fixed port, decided precisely at
  Stage C implementation-plan time, not invented here.

## Shutdown semantics

**An earlier draft left this entirely unspecified; an independent review correctly identified it
as a real gap adjacent to Rollback's "zero blast radius" claim.** Specified in full:

- **Shutdown sequence, on `SIGINT`/`SIGTERM`** (reusing the same signal-handling entry point
  `src/cli/entry.js`'s `registerShutdownHandlers()` already establishes for stdio, applied
  symmetrically to the new `restEntry.js` — not a new pattern invented for REST):
  1. Stop accepting new HTTP connections (`server.close()`). Any request already fully received
     completes normally — every route's own work is a single, fast `DelegationService`/
     `ObservabilityService` call, never a long-running operation in itself (`POST /v1/jobs` returns
     202 immediately; it does not wait for the job to finish — see Async jobs), so no in-flight
     *HTTP request* is ever left half-answered by this step.
  2. **A bounded grace period (default 5s, `CLAUDE_DELEGATE_REST_SHUTDOWN_GRACE_MS`)** during which
     every `JobManager`-tracked non-terminal job — `queued`, `starting`, or `running` — is allowed
     to finish naturally. REST does **not** cancel anything just because a shutdown signal arrived;
     a shutdown is not a cancellation request. (An earlier draft said "still `running`," implying
     `queued` jobs were unaddressed — they are not: both cases are covered by the same step, since
     `cancelJob(id)`, per `src/services/jobManager.js`'s own two branches, already handles a
     `queued` job by removing it from the pending list and transitioning it directly to
     `cancelled` — synchronously, no wait needed — separately from a `running` job's asynchronous
     abort path below.)
  3. **After the grace period, every job still non-terminal is force-cancelled, and the shutdown
     sequence explicitly waits for that cancellation to actually settle before exiting — up to one
     additional bounded window, not indefinitely.** Precisely, since `JobManager.cancelJob(id)` on
     a `running` job is synchronous and fire-and-forget (it calls
     `this.running.get(id)?.abort()` and returns immediately — the subprocess kill and the job's
     transition to a terminal status happen later, asynchronously, inside `_run()`), the sequence
     is: call `cancelJob(id)` on every remaining non-terminal job, then `await` each one's
     `waitForCompletion(id)` (already an existing `JobManager` method, reused verbatim — not new),
     racing that against a second, shorter bounded timeout (default 2s,
     `CLAUDE_DELEGATE_REST_SHUTDOWN_FORCE_EXIT_MS`). If every cancelled job settles within that
     second window, the process exits with every terminal state correctly recorded. If a subprocess
     doesn't die in time (an already-disclosed platform limit, not a new one — see ungraceful
     termination below), the process exits anyway rather than hanging forever, and that job's final
     recorded state is whatever `JobManager`/`FileJobStore` captured up to that point — an explicit,
     bounded trade-off, not a silent gap. An earlier draft asserted "their terminal state recorded
     before exit" without specifying this wait step at all; this is the fix.
  4. `observabilityService.close()`/the `RuntimeEventBus` unsubscribe run as the final step,
     mirroring `entry.js`'s existing shutdown closure exactly (same pattern, new process).
- **Process termination (ungraceful — `kill -9`, a crash, a Task Manager "End Task")**: no grace
  period runs at all; the process simply stops. **Stated honestly, not guaranteed away**: whether
  an in-flight CLI subprocess is killed alongside its parent or becomes orphaned (continuing to run
  detached) is platform- and spawn-option-dependent — the same category of limited guarantee
  `ADR-0004` already discloses for Windows signal delivery ("Node's `SIGTERM` support on Windows is
  documented as limited compared to POSIX"). This ADR does not invent a stronger guarantee than the
  platform actually gives; Stage 2's implementation plan should reuse whatever process-tree cleanup
  mechanism this codebase already has for the stdio path (`docs/releases/KNOWN_LIMITATIONS.md`
  names existing Windows-focused process-tree cleanup, `taskkill /t /f`) rather than inventing a
  second one specific to REST.
- **Interaction with `JobStore`**: if `config.jobStore="file"` (`ADR-0005`), any job still
  `queued`/`starting`/`running` at the actual moment the process exits — whether that's an
  *ungraceful* stop (no grace period ran at all) or a *graceful* stop whose force-exit window
  (step 3 above) elapsed before every cancellation settled — is corrected to `failed` the next time
  **any** process (REST or MCP) hydrates that `jobStoreDir`. `ADR-0005`'s existing hydration-time
  recovery logic ("a job that was queued/starting/running when the process died... is rewritten in
  place as failed") already covers both cases identically; it is not a new mechanism this ADR needs
  to design, only a property this ADR can now correctly claim REST inherits for free, in the
  graceful-but-timed-out case as well as the fully ungraceful one. With the default
  `config.jobStore="memory"`, the job record simply vanishes with the process, on every shutdown
  path alike — identical to how an MCP stdio session's in-memory job history already vanishes when
  that process exits today; REST introduces no new data-loss mode here, only a new process that can
  independently exit.
- **Client-visible behavior**: because every REST interaction is async/poll-based (Async jobs), a
  client mid-poll during shutdown simply sees its next `GET /v1/jobs/:id` start failing (connection
  refused) once step 1 above completes — no client is ever left holding an open connection waiting
  on a response that will never arrive, since REST never blocks a request on job completion in the
  first place.
- **Future extensibility**: a more sophisticated drain signal (e.g. a `GET /v1/health`
  readiness/liveness endpoint reflecting "draining" state, so a well-behaved client/load-balancer
  could stop routing new requests before `server.close()` even runs) is explicitly deferred — no
  concrete consumer needs it yet, consistent with this ADR's other declined-with-trigger
  extensibility items (see Future extensibility).

## Rollback

Named in both senses explicitly, now cross-referencing Shutdown semantics above for the one
qualification an independent review correctly required:

- **Operational rollback**: stop the REST process, following the Shutdown semantics sequence above
  (not an abrupt kill, unless the operator chooses one). Because REST shares no in-memory state
  with MCP (MCP coexistence) and never modifies `entry.js`/`mcpServer.js` (Compatibility with
  existing MCP transport), this returns the system to its exact pre-REST state instantly **with
  zero blast radius on any live MCP session** — that specific claim is unchanged and unqualified.
  **What is newly, explicitly qualified**: this does *not* mean zero blast radius for REST's *own*
  in-flight jobs — a graceful stop gives them a bounded grace period then force-cancels anything
  still running (Shutdown semantics); an ungraceful stop may orphan a running subprocess, bounded
  only by whatever platform-level cleanup already exists for the stdio path, with the same honestly-
  disclosed platform limits `ADR-0004` already states. Any shared on-disk `jobStore`/`eventHistory`
  files are left untouched, exactly mirroring `ADR-0005`'s own documented file→memory
  flag-flip-back behavior ("existing `*.json` files are left untouched on disk... nothing deletes
  them").
- **Code-level rollback**: revert/stop-deploying the new `restEntry.js` + REST route/adapter files.
  Since Stage 2 is scoped as a thin, 1:1 adapter with no new business logic (Responsibilities) and
  lives entirely in new files, this carries zero regression risk to any of the 9 existing, frozen
  MCP tools.

Because `REST_FREEZE.md`'s versioning is fully decoupled from `FOUNDATION_FREEZE.md`/
`OBSERVABILITY_FREEZE.md` (Versioning), a REST-specific rollback never requires rolling back MCP
behavior, and vice versa.

## Backward compatibility

- Zero MCP schema change; all nine frozen tool schemas, execution contract, Job lifecycle, and
  `ExecutionContext` contract are unaffected (restated from Compatibility with existing MCP
  transport for completeness of this section's required scope).
- Zero change to `DelegationService`'s or `ObservabilityService`'s existing method signatures or
  return shapes — the one addition (`isValidJobId()`-style guard inside `getJob`/`cancelJob`) is
  additive hardening of malformed-input handling, not a signature or behavior change for any
  well-formed existing caller.
- `job.metadata.tool`/`JobQueued`'s `payload.tool` remain unchanged, per `ADR-0010` §2's own
  decision — this ADR does not reopen that.
- `EVENT_SCHEMA_VERSION` (`ADR-0002`) stays at `1`; nothing in this ADR touches the frozen event
  contract.
- Overall: this ADR itself changes nothing (no code). Stage 2's eventual implementation is additive
  only — new files, no edits to any of the 9 existing handlers, `jobManager.js`,
  `observabilityService.js`, or `delegationService.js`'s public shape.

---

# Testing Strategy

## Unit

New modules needing pure unit tests, each testable without a live server:

- **Route-to-service mapping layer** — the REST equivalent of `src/handlers/*.js` — tested with a
  fake/spy `DelegationService`/`ObservabilityService` injected via constructor, exactly the pattern
  `createDelegateStatusHandler({delegationService})` already uses today. Assert the right method is
  called with the right args; nothing about either service's own logic is re-tested here.
- **HTTP status-code mapping function** (`ZodError` → 400, `getJob() === undefined` → 404, generic
  `Error` → 500, oversized body → 413) as a pure function, analogous to `src/utils/errors.js`'s
  `toToolErrorContent()`.
- **Path-param extraction** (`job_id` from `/v1/jobs/:id`) and **query-param parsing** (`?status=&
  limit=` → the exact `{status, limit}` shape `listJobs()` expects) as isolated parsing units.
- **Auth-check function**, tested as a pure predicate (request with/without/with-wrong credential →
  allow/reject), no live server needed.
- **`isValidJobId()`-style guard, as a pure function**: asserting it returns `undefined`/`false`
  (never throws) for a malformed input, and passes a well-formed UUID through unchanged — the unit
  test that makes Compatibility with DelegationService's "never throws" claim directly verifiable,
  not just asserted in prose.
- **Body-size-limit check, as a pure function/middleware unit**: given a `Content-Length` above the
  configured max, asserts rejection *before* any buffering function is invoked at all (a spy/mock
  proving the buffering step is never reached, not just that the eventual response is 413).

## Integration

Matching `tests/asyncExecution.integration.test.js`'s own established style — real `JobManager` +
real `createDelegationService`/`createObservabilityService`, a stub only at the outermost
`claudeCliService` boundary via the same `makeStubService()`-style shape, never a mocked
`DelegationService` itself:

- Construct the real services, start the real REST listener on an ephemeral port (`port: 0`), use
  Node's built-in global `fetch` as the test's HTTP client (no new test dependency, matching this
  project's "no external framework" convention) to drive full lifecycles end-to-end: `POST /v1/jobs`
  → `GET /v1/jobs/:id` → `GET /v1/jobs` → `DELETE /v1/jobs/:id`, covering submit→poll→complete,
  cancel(queued), cancel(running), 404-unknown-id, and concurrent submissions.
- **The single highest-value integration test**: one test process wiring **one** `JobManager`/
  `DelegationService` instance to **both** an MCP handler call and a REST HTTP call, asserting both
  observe identical job state — this is the empirical proof of `ADR-0010` §5's "same backend, two
  transports" table, extended to a third transport, not just a narrative claim.
- **Malformed-job-id regression test (required, not optional)**: run against the *current, real*
  `delegateStatusHandler.js`/`delegateCancelHandler.js` *before* the `isValidJobId()` guard is added
  to `DelegationService`, capturing their exact response for a non-UUID `job_id` as the baseline;
  re-run the identical assertion *after* the guard lands and require byte-identical output. This is
  what makes "existing MCP behavior remains unchanged" (Compatibility with DelegationService) an
  empirically-proven property of Stage 2's actual implementation, not a claim taken on faith from
  this ADR's prose — mirroring exactly how `ADR-0010`'s own Stage 1a characterization suite proved
  its refactor byte-identical before merging.
- **Request-body-size integration test**: a real HTTP `POST /v1/jobs` with a body one byte over the
  configured limit is rejected with `413`/`PAYLOAD_TOO_LARGE` and the connection is not held open
  waiting for more data; a body at/under the limit succeeds normally.
- **Shutdown-behavior integration test**: submit a job with an artificially long-running stub CLI
  service, send the process a `SIGTERM`, and assert (a) new connections are refused immediately,
  (b) the in-flight job is force-cancelled only after the configured grace period elapses (not
  immediately), and (c) the process exits within grace-period-plus-a-small-margin, never hanging
  indefinitely.

## Contract

Mirroring `tests/toolRegistry.characterization.test.js`'s pinning style exactly: a
`tests/restRoutes.contract.test.js` pinning, per route, the exact JSON response shape, exact status
code, exact `Content-Type`, and exact error-body shape per failure mode — the REST-side equivalent
of that test's pinned `EXPECTED_TOOL_ORDER` is a pinned route table (path + method list). Response
bodies assert `deepEqual` against calling `delegationService.getJob(id)`/`observabilityService.
getSnapshot()` directly, reusing the exact "call the service directly as a second independent proof
of no reshaping" idiom `tests/asyncExecution.integration.test.js` already uses for
`delegate_snapshot`. This suite is also what proves `/replay`'s byte-identical MCP/REST contract
claimed in Filtering.

## Characterization

**Confirmed none needed pre-REST** (this is Rollout's Stage B, restated here for this section's
required scope). `DelegationService`/`ObservabilityService` already have direct, transport-
independent unit coverage (`tests/delegationService.test.js`, `tests/observabilityService.test.js`)
— unlike `ADR-0010`'s Stage 1a, which had to characterize handler-embedded logic *before*
extracting it into a service, REST is purely additive on top of an already-proven, already-frozen
internal API. Nothing pre-existing needs pinning before this work starts.

## Performance

**Not throughput/scale** — no multi-tenant load pattern exists to justify it (see Risk Analysis >
Scaling). What is worth measuring:

- **Marginal HTTP round-trip overhead**: calling `delegationService.getJob(id)` in-process vs. the
  same call through a real localhost `fetch()` — isolating JSON-serialization + HTTP-framing cost
  from the already-fast in-memory service calls.
- **Realistic-scale concurrency sanity check**: a handful of simultaneous polling requests (one
  Dashboard poller plus one or two scripts, not hundreds of connections), asserting the REST layer
  never lets concurrent HTTP requests bypass `JobManager`'s own `maxConcurrentJobs` bound.
- **Long-lived-process hygiene**: if `ConsumerRegistry` registration is wired in at Stage 2 (see
  Future Dashboard compatibility), confirm it happens exactly once at boot and unregisters at
  graceful shutdown, with no leak across restarts.

**Explicitly out of scope**: requests/sec ceilings, horizontal scaling, load-balancer-style
benchmarks.

## Security

Beyond the categories already named throughout (Authentication/Authorization/Error model), the
test suite must concretely cover:

- **Auth required and rejected**, covering **both** missing **and** wrong/malformed credentials (not
  just missing) on every route except a possible future `/health` liveness check — expecting 401,
  never 500/200.
- **Path-traversal on the `:id` param**, reusing the exact `isValidJobId()` UUID gate (now shared
  inside `DelegationService`, per Compatibility with DelegationService) re-applied at the HTTP
  layer too — tested with both a raw non-UUID string and a URL-encoded traversal sequence
  (`%2e%2e%2f`), rejected cleanly before ever reaching a filesystem path.
- **CORS preflight behavior**, asserting no wide-open `Access-Control-Allow-Origin: *` by default —
  this is the project's first network listener, and zero-CORS-policy-by-default is a real risk even
  localhost-bound.
- **Credential/secret non-leakage in error bodies and logs** — extending the existing
  `ExecutionContext.environment` redaction discipline (`ADR-0001`) to the REST bearer token and to
  `INTERNAL_ERROR` response bodies (Error model).
- **Default-bind-address test** (`127.0.0.1`, not `0.0.0.0`, unless explicitly configured) — treated
  as a frozen security invariant in `REST_FREEZE.md`, the same way `config.claudeBin`'s `shell:
  false` is called out in `docs/FOUNDATION_FREEZE.md` as "a frozen security invariant, not just a
  current implementation detail."
- **Request-body-size enforcement** (see Security, Testing Strategy > Integration) is a resource-
  safety control tested here too specifically because it applies regardless of authentication
  state — confirm the size check runs (and rejects) independent of whether a valid token is also
  present, so a large body from an *authenticated* caller is bounded exactly as strictly as one
  from an unauthenticated one.

---

# Risk Analysis

## Performance

The realistic risk is not throughput (see Testing Strategy > Performance) but **surprise latency
from JSON serialization + HTTP framing on top of already-cheap in-process calls** — small in
absolute terms, but worth a baseline measurement so a future regression has something to compare
against. `FileJobStore`'s hydrate-once design (see MCP coexistence) means REST's own view of jobs
goes stale over its own uptime unless it restarts periodically or a live re-hydration/directory-poll
mechanism is added later — not a performance problem per se, but a correctness-adjacent staleness
risk worth naming here since it compounds with any future performance tuning that assumes REST's
view is current.

## Scaling

**Explicitly declined for v1**: horizontal scaling / multi-instance REST deployment. Single
persistent REST process per deployment is this ADR's assumed shape throughout (Compatibility with
existing MCP transport, REST coexistence). `ConsumerRegistry`'s "ops/admin view once multiple REST/
Dashboard instances exist" (`ADR-0010` §5) stays out of scope, unchanged by this ADR. If a future
need for multiple REST instances materializes (e.g. one per project directory, load distribution),
that is its own future ADR with its own job-state-sharing design — not an incremental extension of
this one.

## Security

Recap of decisions made above, plus residual risk this ADR discloses rather than silently assumes
away:

- **If the token file is ever read by another process/user account on a shared machine**, or
  accidentally logged/exposed via a misconfigured future proxy, that caller becomes fully trusted
  with no ownership scoping to limit blast radius (by design, per Authorization). This is a real,
  named residual risk, not eliminated by this design — only bounded by the token being
  high-entropy and never logged.
- **Windows file-permission enforcement on the token file is weaker than POSIX `chmod 600`** — this
  ADR states that honestly (echoing `ADR-0004`'s own stated humility about weaker Windows
  guarantees for signal delivery) rather than claim a protection level Windows ACLs don't actually
  give.
- **Rate limiting / DoS protection is an explicit v1 non-goal**, not an oversight. The realistic
  threat model is a single-user, localhost-bound, token-gated service: any caller without the token
  is already rejected at the auth layer before request volume matters; any caller with the token is,
  by this design's own choice (Authorization), a fully-trusted actor already, so throttling them is
  a resource-fairness feature, not a security control. The actually-scarce resource — Claude CLI
  subprocess execution/budget — is already protected independent of transport by `JobManager`'s
  existing `maxConcurrentJobs` cap and per-call `max_budget_usd`/`spawnTimeoutMs` bounds; a REST
  caller submitting jobs faster than they run just fills the existing queue, it doesn't bypass any
  cap. Token brute-forcing is infeasible at any request rate a single local process can sustain
  against a 256-bit secret, so auth-attempt throttling isn't needed either. **Concrete trigger for
  revisiting**: only if/when REST is ever exposed beyond localhost (LAN or multi-machine mode) —
  itself out of scope for v1.

## Caching

**No caching layer in v1**, stated as a deliberate non-goal rather than an omission:

- `FileJobStore`'s own in-memory cache (populated once at hydration) is an internal implementation
  detail of that store, not a REST-facing cache, and must not be mistaken for one — it is the
  precise mechanism behind the staleness risk already disclosed in MCP coexistence and Performance
  above.
- `getMetrics()`/`getSnapshot()` are pull-based, computed fresh on every call (`SnapshotBuilder` has
  "no background interval, no timer, nothing running when nobody's asking," per `ADR-0003`) — there
  is nothing stale to cache within a single process's own results, only the cross-process staleness
  already named elsewhere.
- No HTTP-level caching (no `ETag`, no `Cache-Control`) is added in v1 — job state changes are
  lightweight and local; premature caching here would only reintroduce the exact staleness problem
  this ADR already discloses honestly for `FileJobStore`, one layer up, for no benefit given the
  actual request volumes this tool sees.

## Operational risks

- **Metrics/snapshot divergence is the most user-visible surprise if undocumented**: an operator
  hitting REST's `/v1/metrics` expecting to see the same numbers `delegate_metrics` shows in their
  concurrently open MCP client will see a different, REST-process-only counter set (Compatibility
  with Observability). Mitigated by documenting this plainly in the REST docs/response, not by
  building cross-process aggregation now.
- **An operator assuming "shared `jobStoreDir`" means "REST sees my MCP session's jobs live"** is a
  real, named misconception this ADR's MCP coexistence section exists specifically to prevent —
  the true guarantee is a boot-time snapshot at best.
- **A stale token file on a shared machine** silently grants full trust to whoever can read it (see
  Security above) — an operational hygiene risk more than a design flaw, but worth surfacing in
  operator-facing docs at Stage 2.
- **An ungracefully-killed REST process** leaving stale non-terminal job state is already handled by
  `ADR-0005`'s existing hydration-time recovery logic if `jobStore=file` is enabled — named here as
  a risk that is already mitigated, not a new gap. A *gracefully*-stopped process instead follows
  the bounded grace-period-then-force-cancel sequence in Shutdown semantics, so this risk is
  bounded in both the graceful and ungraceful case, not only the ungraceful one an earlier draft
  discussed in isolation.
- **An unbounded request body** (fixed by the 1 MiB default limit in Security) would otherwise have
  been a memory-exhaustion vector independent of the token-based trust model — named here as a
  resolved risk, not a remaining one, per Security's specification above.

## Future extensibility

**Genuinely deferred, each with an explicit trigger** — mirroring `ADR-0010` §4's own
`subscribeToJob()` restraint, not an open-ended "maybe later":

1. **WebSocket/SSE push streaming** — deferred until a second concrete consumer (a real Dashboard
   build, Stage 3) demonstrably can't tolerate polling latency.
2. **A public multi-tenant auth model** (OAuth, per-tenant API keys, RBAC) — declined; mismatched
   with this project's single-operator, local-first identity. Deferred until/unless the product's
   scope explicitly changes to hosted/multi-user — a product decision, not an incremental REST
   feature. (Ownership scoping's own concrete trigger is named separately in Authorization.)
3. **Rate limiting/quotas** — declined; see Security above for the full reasoning and trigger.
4. **An OpenAPI/Swagger generator** — declined; premature tooling for ~9 routes with no external
   third-party consumer to hand a spec to yet. Deferred until a second concrete consumer (a
   published Dashboard, or a Stage 4 Plugin ecosystem) needs machine-readable discovery;
   `REST_FREEZE.md`'s own frozen route table is sufficient documentation until then, exactly as
   `FOUNDATION_FREEZE.md`'s table alone has sufficed for MCP.
5. **Horizontal scaling / multi-instance REST deployment** — declined; see Scaling above.
6. **Cursor-based pagination** — declined for v1; requires a `DelegationService.listJobs()`
   signature extension, deferred until a concrete need (e.g. a Dashboard "load more") materializes
   (see Pagination).

**Not declined — the one live question this ADR resolves rather than parking**: `getTimeline()`'s
`{type, since}` filtering, resolved in Filtering above as its own additive endpoint, per `ADR-0010`
§5's explicit assignment of this decision to this ADR.

---

## Alternatives considered

- **Add a "REST mode" flag to the existing `src/cli/entry.js`/stdio process** instead of a separate
  entry point: rejected — would keep REST's lifetime coupled 1:1 to whichever single stdio client
  invoked that process, precisely the coupling `ADR-0004` documents as this project's process model
  and precisely what REST's own value proposition requires escaping (Compatibility with existing
  MCP transport).
- **Auto-start REST alongside every MCP stdio launch**: rejected — reintroduces `ADR-0004`'s
  per-client-window coupling one layer up, silently opens this project's first network listener as
  a side effect of opening a Claude Desktop window, and risks port-bind collisions across N
  concurrently open MCP windows with no arbitration logic (Rollout).
  A global lockfile/PID-check to prevent a second REST process: unnecessary — a fixed port's
  `EADDRINUSE` already catches this for free, since (unlike stdio) concurrent REST instances are
  never legitimate by design (REST coexistence).
- **Header/content-negotiation-based API versioning** instead of URL-path versioning: rejected —
  scale-mismatched for a single-operator, single-deployment tool, and a first departure from this
  codebase's existing plain-integer versioning convention (`EVENT_SCHEMA_VERSION`, `storeVersion`)
  (Versioning).
- **Reuse `docs/FOUNDATION_FREEZE.md` or `docs/OBSERVABILITY_FREEZE.md` for REST's own contract**
  instead of a new `REST_FREEZE.md`: rejected — would conflate two independently-evolving surfaces,
  exactly the coupling `ADR-0010` avoided by keeping `ObservabilityService`/`DelegationService`
  side by side rather than merged (Versioning).
- **Mirror `delegate_task`'s blocking behavior as a blocking `POST /v1/jobs`**, optionally opt-in via
  `?wait=true&timeoutMs=N`: rejected in both forms — reintroduces resource-pinning/proxy-timeout
  risk, requires `jobManager.waitForCompletion` as a second REST-side exception to `ADR-0010` §1's
  "no other transport adapter gets this exception" rule, and no concrete consumer has asked for it
  (Async jobs, Long polling).
- **Overload `/replay`'s existing route with `{type, since}` query params** instead of a separate
  `/timeline` endpoint: rejected on reconsideration — would make `/replay`'s cross-transport
  contract conditionally behavior-changing based on query params, undermining the contract-test
  suite's ability to prove it byte-identical to MCP's `delegate_replay` (Filtering).
- **Localhost bind with no auth token**: rejected — does not defend against a same-machine
  browser-tab CSRF-style request, a concrete threat this design names explicitly
  (Authentication).
- **Unix domain socket / Windows named pipe as the v1 default transport**: rejected as the
  *default* (though recorded as a legitimate future opt-in) — would foreclose Stage 3's Dashboard
  talking to REST directly from a browser without an extra bridge process (Authentication).
- **OAuth or mTLS with certificate management**: rejected — mismatched complexity for a
  single-operator, local-first tool with no concrete multi-tenant need (Authentication,
  Authorization).
- **Per-job ownership scoping in v1**: rejected — nothing in `JobManager`/`DelegationService` today
  carries a submitter identity to scope against, and v1's own credential model is single-tenant by
  construction (Authorization).
- **Build REST directly against `JobManager`/`ObservabilityService`, skipping the
  `createDelegationBackend` extraction refactor**: rejected — would force `restEntry.js` to
  copy-paste `mcpServer.js`'s construction block (drift risk) or import `createMcpServer` itself and
  discard its unwanted side effects (Compatibility with existing MCP transport).
- **Build cross-process metrics/job-state aggregation now** (a shared live store beyond
  `FileJobStore`'s snapshot semantics): rejected — no persistence mechanism for `MetricsCollector`'s
  aggregates exists today in any form, and no concrete consumer has asked for it; documenting the
  limitation is the chosen v1 answer (Compatibility with Observability, Operational risks).
- **Throw a structured validation error for a malformed job id**, rather than returning
  `undefined`/`false` through the existing unknown-id path: rejected — would be new, observable
  behavior for a case `delegate_status`/`delegate_cancel` already handle gracefully today with no
  try/catch, the exact regression an independent review of this ADR identified (Compatibility with
  DelegationService).
- **No request body size limit** (rely solely on token-based trust): rejected — bounds a different
  risk dimension (single-request memory cost) than authentication bounds (who may call at all);
  an independent review correctly identified this as an unaddressed gap, not a deliberately-scoped
  non-goal (Security).
- **Immediately cancel all in-flight jobs on any shutdown signal**, or conversely **wait
  indefinitely for them to finish**: both rejected in favor of a bounded grace period followed by
  force-cancellation — immediate cancellation would needlessly kill fast, nearly-finished jobs;
  unbounded waiting risks a shutdown that never completes if a job hangs (Shutdown semantics).

## Compatibility impact

- **Zero MCP schema change.** All nine frozen tool schemas (`docs/FOUNDATION_FREEZE.md`), the
  frozen execution contract, the frozen Job lifecycle, and the frozen `ExecutionContext` contract
  are unaffected.
- **Zero change to `DelegationService`'s or `ObservabilityService`'s existing public method
  signatures or observable behavior.** The one addition — an `isValidJobId()`-style guard inside
  `getJob()`/`cancelJob()` — never throws and returns exactly what the existing unknown-id path
  already returns (`undefined`/`false`); malformed and unknown ids are indistinguishable to every
  existing caller, before and after (Compatibility with DelegationService).
- **`job.metadata.tool`/`JobQueued`'s `payload.tool`: unchanged**, per `ADR-0010` §2's own decision,
  not reopened here. `EVENT_SCHEMA_VERSION` stays at `1`.
- **A new sibling freeze document, `docs/REST_FREEZE.md`, will exist** once Stage 2 ships — decided
  here, authored later (Versioning). No existing freeze document's own frozen sections change.
- **A request body size limit (1 MiB default) and a bounded shutdown grace period (5s default)**
  are new, REST-only operational parameters (Security, Shutdown semantics) — neither affects MCP,
  which has no request-body concept and whose own shutdown handling in `entry.js` is unchanged.
- **Overall classification of this ADR itself**: no version bump — no code exists yet. Stage 2's
  own eventual implementation is expected to classify as **minor** against `docs/
  FOUNDATION_FREEZE.md`'s policy (new capability, zero change to any frozen guarantee), decided
  precisely at that time, not asserted here.

---

## This ADR proposes no code changes

This ADR proposes **no code changes**. No file in `src/`, `tests/`, or any config is touched by
this document. It is a design document only, gated for the user's separate review and approval
before any implementation plan, TDD sprint, or code change begins — consistent with this
repository's own standing governance (`ADR-0007`/`ADR-0008`/`ADR-0009`/`ADR-0010` were each written
and approved before their implementation waves began, and `CAPABILITY_ROADMAP_REBASELINE.md`'s own
"Recommended next sprint" item 2 states this explicitly: *"No implementation until that ADR is
reviewed and approved, per this project's standing process."*). The only artifact this document
recommends producing next is itself another document (below), not code.

## Recommended next step

**Not Stage C's TDD sprint, and not Stage B (already shown skippable above) — the smallest safe
next step is a Stage 2 implementation-plan / design-package document**, mirroring
`STAGE_1B_DESIGN_PACKAGE.md`'s precedent: a document that fixes the concrete details this ADR
deliberately left to implementation time (the exact `restEntry.js`/`createDelegationBackend`
file layout, the exact HTTP status-code mapping module shape, the exact default port and env var
names, the `limit` clamp value, whether `ConsumerRegistry` is wired in at Stage 2 or deferred, the
exact TDD test list per Testing Strategy) — still zero code, gated for its own review before any
file is created, exactly the same "no production code until reviewed and approved" gate this ADR
itself sat behind, applied one level further down the chain. This is the smallest unit of further
work that is genuinely safe to do next: it commits to nothing this ADR hasn't already decided, and
it is what makes Stage C's eventual TDD sprint scoped precisely enough to execute without
re-litigating any of the decisions made here.
