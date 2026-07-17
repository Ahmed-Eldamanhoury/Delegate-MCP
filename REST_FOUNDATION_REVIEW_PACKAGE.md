# REST Foundation — Review Package (ADR-0011 Stage 2)

**Scope:** implementation-governance package for `docs/adr/ADR-0011-rest-api-foundation.md`
(frozen, treated as approved architecture — not redesigned here). Mirrors
`STAGE_1B_DESIGN_PACKAGE.md`'s role for `ADR-0010`. **Design only — no production code, no tests
written, in this document or this sprint.** Gated for review before any implementation begins.

---

## 1. Implementation Scope

Everything ADR-0011 decided and left to "implementation time":

- **`createDelegationBackend({config, logger})`** — extracting `createMcpServer`'s inline
  construction block (`jobManager`/`bus`/`observabilityService`/`delegationService`/
  `eventHistoryStore`) into a shared, transport-agnostic helper (ADR-0011, Compatibility with
  existing MCP transport). **File location, pinned explicitly here** — ADR-0011's own "Recommended
  next step" tasks this document with fixing exactly this, and an independent review of an earlier
  draft correctly found it left unpinned: `src/services/delegationBackend.js`, a new sibling file
  next to `delegationService.js`/`observabilityService.js`/`jobManager.js` (matching this
  directory's one-file-per-concern convention) — **deliberately not inside `delegationService.js`
  itself**, so WP0 (which creates this file) and WP1 (which edits `delegationService.js` for the
  `isValidJobId()` guard) touch genuinely disjoint files, making the "zero file overlap" claim in
  §3 actually true rather than merely asserted.
- `src/cli/restEntry.js` — a new, standalone entry point; never a flag on `entry.js`.
- The REST HTTP layer itself: route registration, auth middleware, CORS policy, request body-size
  enforcement, HTTP status-code/error mapping, path/query-param parsing — all thin, all calling
  only `DelegationService`/`ObservabilityService` (ADR-0011, Responsibilities).
- The `isValidJobId()`-style guard added inside `DelegationService.getJob()`/`cancelJob()` (shared
  by MCP, zero observable change for any well-formed or malformed id — ADR-0011, Compatibility
  with DelegationService).
- The full route table (9 routes: `POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs`,
  `DELETE /v1/jobs/:id`, `GET /v1/jobs/:id/replay`, `GET /v1/jobs/:id/timeline`,
  `GET /v1/metrics`, `GET /v1/snapshot`, `GET /v1/models`).
- Graceful shutdown sequence (bounded grace period → force-cancel + wait-for-settlement → bounded
  force-exit window → close observability), reusing `entry.js`'s existing shutdown-handler pattern.
- `docs/REST_FREEZE.md`, authored once routes are proven (ADR-0011, Versioning).
- The full test suite ADR-0011's Testing Strategy names (unit, integration, contract, security).

## 2. Explicit Non-Scope

Reused verbatim from ADR-0011 — **not reopened, not partially built, not "started but deferred"**:

- SSE/WebSocket streaming, server-side long-polling, cursor-based pagination.
- Cross-process metrics/job-state aggregation (a live shared store beyond `FileJobStore`'s
  snapshot semantics).
- Rate limiting/quotas, OAuth/mTLS, per-job ownership/authorization scoping.
- Dashboard (Stage 3), Plugin API (Stage 4), horizontal/multi-instance REST scaling.
- An OpenAPI/Swagger spec generator.
- Any change to `ObservabilityService`'s or `DelegationService`'s existing method signatures
  beyond the one disclosed `isValidJobId()` guard.
- Any change to any of the 9 existing MCP tool schemas, `FOUNDATION_FREEZE.md`, or
  `OBSERVABILITY_FREEZE.md`.

## 3. Work Package Breakdown

| WP | Content | Depends on | Parallelizable with |
|---|---|---|---|
| **WP0** | `createDelegationBackend()` extraction refactor, in new file `src/services/delegationBackend.js` (see §1). Behavior-preserving only — `createMcpServer()` calls the new helper instead of inlining construction; zero observable change to any MCP tool. | none | WP1 (genuinely disjoint files: `delegationBackend.js` (new) vs. `delegationService.js`) |
| **WP1** | Pure, unit-testable adapter primitives, no live server needed: HTTP status-code/error mapper; auth-check predicate; path/query-param parsers; request body-size-limit check; the `isValidJobId()` guard added to `DelegationService` (`delegationService.js`). | none | WP0 (see file-disjointness note above) |
| **WP2** | `restEntry.js` skeleton: HTTP server bootstrap (127.0.0.1 default bind, configurable port), wiring WP0's backend + WP1's primitives (auth middleware, CORS default-deny, body-size enforcement, error mapping), plus the full graceful-shutdown sequence. **No routes registered yet.** | WP0, WP1 | — |
| **WP3** | Read-only routes: `GET /v1/jobs/:id`, `GET /v1/jobs`, `GET /v1/metrics`, `GET /v1/snapshot`, `GET /v1/jobs/:id/replay`, `GET /v1/jobs/:id/timeline`, `GET /v1/models` (the last needs the shared `buildModelsInfo(config)` helper extracted from `delegateModelsHandler.js`, per ADR-0011 §"REST lifecycle"). Each route written test-first (see Testing obligations). | WP2 | WP4 — *but see R8: recommended sequential-in-one-worktree, not isolated parallel, since both touch `restEntry.js`'s shared route-registration call site* |
| **WP4** | Write routes: `POST /v1/jobs` (202 + `Location`), `DELETE /v1/jobs/:id` (with the before/cancel/after idempotency logic). Each route written test-first. | WP2 | WP3 — *same R8 caveat* |
| **WP5** | Cross-cutting test suite: the contract-test file (`tests/restRoutes.contract.test.js`), the required MCP+REST-same-`JobManager` divergence-proof integration test, a second required test proving two *independent* `createDelegationBackend()` instances (mirroring real `entry.js` + `restEntry.js`) share no module-level state, the body-size test, the shutdown-behavior test. Individual route/unit tests are written test-first *within* WP0–WP4; WP5 is the suite-level tests that need the full route set assembled. **Exception**: the malformed-id regression test (§7) needs only WP1's guard plus the *existing* MCP handlers — it does not need any REST route and should start as soon as WP1 lands, in parallel with WP2/WP3/WP4, not held behind this gate. | WP3, WP4 (except the malformed-id test, see above) | — |
| **WP6** | Documentation: `docs/REST_FREEZE.md` (full — see ADR-0011's planned outline), `CHANGELOG.md` entry, `docs/ARCHITECTURE.md` (add `src/rest/`/`restEntry.js` to the file/directory diagram), `docs/releases/KNOWN_LIMITATIONS.md` (metrics/snapshot process-scoping, the body-size MCP/REST divergence, ungraceful-shutdown platform limits — all already named in ADR-0011, now documented as shipped-and-known, not hypothetical), `package.json` version bump. | WP3, WP4, WP5 | — |
| **WP7** | Final certification gate (see Release gates). | WP0–WP6 | — |

**Dependency graph:** `WP0` and `WP1` run in parallel (no shared files) → `WP2` (needs both) →
`WP3`/`WP4` run in parallel (both depend only on `WP2`, touch disjoint route files) → `WP5` (needs
the full route set from `WP3`+`WP4`) → `WP6` → `WP7`.

## 4. Acceptance Criteria

**Per-WP** (each is a hard gate before the next WP starts):
- **WP0**: `npm test` green, byte-identical — the *existing* full suite (all MCP characterization/
  integration/unit tests) passes unmodified against the refactored `createMcpServer`. Live
  Inspector-equivalent check: `server._registeredTools` unchanged across all 9 tools.
- **WP1**: each primitive has its own passing unit test (per ADR-0011 Testing Strategy > Unit);
  the `isValidJobId()` guard specifically has a test proving it **never throws** and returns
  `undefined`/`false` for a malformed id, matching `DelegationService`'s existing unknown-id
  behavior exactly.
- **WP2**: `restEntry.js` boots, binds `127.0.0.1` by default (test asserts non-`0.0.0.0` default),
  rejects requests missing/with-wrong bearer token (401) on a stub route, enforces the body-size
  limit (413) before any route logic runs, and completes the full shutdown sequence within its
  configured bounds under test.
- **WP3/WP4**: every route has a passing contract test pinning its exact status code and JSON
  shape; every route calls exactly one `DelegationService`/`ObservabilityService` method with no
  additional logic (spot-checked, not just asserted).
- **WP5**: the malformed-id regression test passes showing byte-identical MCP output before/after;
  the shared-instance parity test and the independent-instance isolation test (§7) both pass; the
  body-size and shutdown-behavior tests pass exactly as specified in ADR-0011.
- **WP6**: `docs/REST_FREEZE.md` exists and its frozen route table matches WP3/WP4's actual,
  contract-tested shapes exactly (no aspirational content); `CHANGELOG.md`/`ARCHITECTURE.md`/
  `KNOWN_LIMITATIONS.md` all reference the real, shipped route table, not a draft one.
- **WP7**: see Release gates (§11) — the overall Stage 2 acceptance bar.

## 5. Migration Checkpoints

Safe points to pause, ship a partial PR, or stop entirely without leaving the repo in a bad state:

1. **After WP0**: safe. A pure, behavior-preserving refactor with its own full-suite proof. Zero
   REST code exists yet; `main` is exactly as functional as before, just with one internal seam
   added.
2. **After WP1**: safe. New pure functions exist, unit-tested, unused by anything yet. Zero risk.
3. **After WP2**: safe but **not yet useful** — a REST server that accepts connections and enforces
   auth/CORS/body-limits/shutdown but has zero functional routes. Fine to ship/merge as its own PR;
   REST is still not usable by any real caller.
4. **After WP3 or WP4 individually**: safe **to merge**, not yet operator-ready either way — an
   independent review correctly flagged that "ship" here must mean "mergeable to `main`," not
   "usable by a real operator": WP5's body-size test needs `POST /v1/jobs` (WP4), so merging WP3
   alone leaves that specific proof outstanding, and neither WP3-only nor WP4-only reaches WP7's
   certification bar. Merging either individually is safe (zero MCP regression, per each WP's own
   acceptance criteria) but does not constitute a usable "REST preview" until WP5 proves the full
   set.
5. **After WP5**: REST is functionally complete and empirically proven non-regressive to MCP, but
   undocumented (`REST_FREEZE.md` doesn't exist yet) — do not tag/release from this checkpoint.
6. **After WP6**: fully documented, ready for WP7's certification gate.
7. **After WP7**: certified, ready for the user's own push/tag decision — mirroring exactly how
   `ADR-0010`'s Stage 1b ended (a certified, unpushed state awaiting explicit go-ahead).

## 6. Risk Register

Combining ADR-0011's own Risk Analysis (architecture-level) with new, implementation-level risks
this plan itself introduces:

| # | Risk | Source | Mitigation |
|---|---|---|---|
| R1 | `createDelegationBackend()` extraction (WP0) subtly changes `createMcpServer`'s construction order/timing, affecting an existing MCP tool | New (implementation-level) | WP0's acceptance criterion requires the *existing* full suite to pass unmodified — this is the direct analog of `ADR-0010` Stage 1b's own characterization-first discipline, applied to a new refactor before REST touches anything |
| R2 | The `isValidJobId()` guard is implemented as a throw despite the ADR's explicit "never throws" decision | New (implementation-level; this exact risk is why ADR-0011 was revised twice) | WP1's acceptance criterion requires a specific unit test asserting no-throw; WP5's regression test independently re-proves it against real MCP handlers |
| R3 | Contract tests are written *after* routes (not test-first), silently encoding an accidental behavior as "correct" | New (implementation-level; mirrors the exact WP8 gap found in `ADR-0010` Stage 1b's own certification, where a promised test was skipped and only manually verified) | Explicit requirement in Testing obligations (§7): every route's contract test is written before or alongside its route, never retrofitted after the fact as an afterthought |
| R4 | Performance/latency regression from JSON serialization + HTTP framing overhead | ADR-0011 Risk Analysis > Performance | WP5 includes the marginal-overhead measurement ADR-0011 already specifies; not a blocking gate (informational baseline), per ADR-0011's own scoping |
| R5 | Metrics/snapshot divergence (REST-process-only counters) surprises an operator | ADR-0011 Risk Analysis > Operational risks | WP6's `KNOWN_LIMITATIONS.md` entry, plus the REST response/docs themselves stating this plainly (per ADR-0011's own chosen resolution — document, don't build aggregation) |
| R6 | A leaked/stale token file grants full, unscoped trust | ADR-0011 Risk Analysis > Security | Named residual risk, not eliminated by design (per ADR-0011); WP6 documents this in operator-facing docs |
| R7 | Windows subprocess-tree cleanup on ungraceful shutdown is weaker than POSIX | ADR-0011 Shutdown semantics | Stated honestly, not over-promised (per ADR-0011); WP2 reuses whatever existing Windows cleanup mechanism `entry.js`'s stdio path already has, does not invent a second one |
| R8 | `WP3`/`WP4` parallel work both touch `restEntry.js`'s route-registration call site, risking a merge conflict if run as literally concurrent implementers | New (implementation-level, process risk) | Recommend sequential-in-one-worktree execution for WP3→WP4 (not isolated parallel worktrees), mirroring the exact lesson from `ADR-0010` Stage 1b's WP2–WP4 sprint, which found the "independent per design" WPs still shared enough file surface to make true parallel worktrees costlier than sequential execution |

## 7. Testing Obligations

Directly enumerating ADR-0011's own Testing Strategy, mapped to WPs, plus the three
specifically-named required tests from the ADR's revision history:

- **Unit** (WP0, WP1): `createDelegationBackend()` itself, in isolation — asserting it returns the
  expected `{jobManager, bus, observabilityService, delegationService, eventHistoryStore}` shape
  and that calling it twice in one process (mirroring `entry.js` + `restEntry.js` each calling it
  independently) produces two fully independent instances sharing no module-level state — an
  independent review correctly found this wasn't required anywhere in an earlier draft, even
  though `runtimeEventBus.js`/`jobManager.js` are confirmed to hold only instance-level state today
  (verified by direct read), making this a regression guard for the future, not a currently-known
  bug. Plus: status-code mapper, auth predicate, path/query parsers, body-size check,
  `isValidJobId()` guard — each a pure-function test, no live server.
- **Integration** (WP3/WP4/WP5): full lifecycles via real `fetch()` against a real, ephemeral-port
  REST listener wired to real `DelegationService`/`ObservabilityService` (never a mocked service) —
  submit→poll→complete, cancel(queued), cancel(running), 404-unknown-id, concurrent submissions.
- **Contract** (WP5): `tests/restRoutes.contract.test.js` pinning exact status/shape/`Content-Type`
  per route, `deepEqual`-checked against calling the service directly (the same "second independent
  proof of no reshaping" idiom `tests/asyncExecution.integration.test.js` already uses).
- **Characterization**: none required pre-Stage-2 (ADR-0011 already confirms this explicitly —
  `DelegationService`/`ObservabilityService` are already transport-independently tested).
- **Performance** (WP5, informational): marginal HTTP-round-trip overhead vs. in-process call;
  realistic-scale concurrency sanity check; `ConsumerRegistry`-registration-once-at-boot check if
  wired in.
- **Security** (WP5): auth required/rejected on every route (missing and wrong credential); path-
  traversal attempt on `:id`; CORS preflight default-deny; credential/secret non-leakage in error
  bodies and logs; default-bind-address test; body-size-limit applies regardless of auth state.
- **Four non-negotiable, explicitly-named regression/proof tests** (three from ADR-0011's own
  revision history, one added by this package's own adversarial review — these are acceptance
  gates, not optional coverage):
  1. Malformed-job-id regression test: MCP's exact output for a non-UUID id, captured *before* the
     `isValidJobId()` guard lands, re-asserted byte-identical *after*.
  2. Shared-instance parity test: **one** `createDelegationBackend()` instance wired to both an MCP
     handler call and a REST HTTP call, asserting identical observed job state — proves the "same
     backend, two transports" claim.
  3. Independent-instance isolation test (new, §7 Unit) — the deliberate opposite case: **two
     separate** `createDelegationBackend()` calls in one process (mirroring real `entry.js` +
     `restEntry.js`, which never share an instance in production), asserting neither's state leaks
     into the other. Test 2 proves parity is *possible* when explicitly wired that way; test 3
     proves it never happens *by accident* the rest of the time.
  4. Shutdown-behavior test: `SIGTERM` with a long-running stub job, asserting new-connections-
     refused-immediately, force-cancel-only-after-grace-period, and bounded exit time.

## 8. Documentation Obligations

- **`docs/REST_FREEZE.md`** (new) — full outline per ADR-0011's Versioning section: Frozen
  sections (the actual, contract-tested route table) / Compatibility guarantees / Extension points
  / Versioning policy (patch/minor/major definitions, mirroring `FOUNDATION_FREEZE.md`'s own) /
  Breaking-change policy / Deprecation policy / Release quality gates.
- **`CHANGELOG.md`** — new dated entry (mirroring every prior sprint's entry style), describing
  REST Foundation, its opt-in nature, and linking `ADR-0011`.
- **`docs/ARCHITECTURE.md`** — add `restEntry.js`/`src/rest/` to the file/directory diagram; note
  it as a separate, optional process, not part of the stdio MCP server's own lifecycle.
- **`docs/releases/KNOWN_LIMITATIONS.md`** — metrics/snapshot process-scoping; the body-size
  MCP/REST divergence; ungraceful-shutdown subprocess-orphaning platform limits; no per-job
  ownership scoping; `FileJobStore`'s hydrate-once staleness as it applies to REST specifically.
- **`docs/releases/MIGRATION_GUIDE.md`** — state plainly that REST is entirely opt-in (a separate
  process the operator chooses to run) and changes nothing for any existing MCP-only user.
- **`package.json`** — version bump, classified **minor** (new capability, zero change to any
  frozen MCP contract), decided at this sprint's actual completion, not asserted in advance.

## 9. Implementation Sequencing

```
WP0 (backend extraction) ─┐
WP1 (pure primitives)     ─┴─► WP2 (restEntry.js skeleton) ─┬─► WP3 (read routes) ─┐
                                                              └─► WP4 (write routes)─┴─► WP5 (cross-cutting tests) ─► WP6 (docs) ─► WP7 (certification gate)
```

WP0/WP1 have zero file overlap and may proceed genuinely in parallel (separate agents/isolated
worktrees, if using this project's established subagent-driven pattern). WP3/WP4 touch disjoint
route files but the *same* `restEntry.js` route-registration call site — per R8 above, sequential
execution in one shared worktree is recommended over isolated-parallel worktrees, mirroring the
exact lesson already learned from `ADR-0010` Stage 1b's WP2–WP4 sprint.

## 10. Rollback Checkpoints

Reusing ADR-0011's own Rollback section, made concrete per stage of *this* plan:

- **WP0 only merged**: revert is a single, pure refactor revert — zero REST code exists, zero risk.
- **WP0–WP2 merged, WP3/WP4 not yet**: revert `restEntry.js` + the backend extraction; `main` was
  never depended upon by anything else in the interim (each WP's own acceptance criterion requires
  the existing suite to stay green throughout).
- **WP0–WP5 merged, WP6/WP7 not yet**: REST is functionally present but undocumented/uncertified;
  rollback = revert all new files (`src/rest/`, `restEntry.js`, new test files) — zero regression
  risk to the 9 existing MCP tools, per ADR-0011's own "thin adapter, new files only" framing.
- **Fully merged and released (post-WP7)**: operational rollback = stop the REST process (per
  ADR-0011's Shutdown semantics — a graceful stop, not a kill, unless explicitly chosen); code-level
  rollback = revert the release commit(s). Neither requires touching MCP.

## 11. Release Gates

The certification bar for WP7, before this sprint may be tagged/pushed (mirroring `ADR-0010`
Stage 1b's own WP8 gate — this time explicitly requiring the tests it names to actually exist,
closing the exact gap an independent review found in that earlier sprint):

1. Full test suite green — the pre-existing suite **and** every new unit/integration/contract/
   security test named in §7, all actually present in the repository, not asserted as "verified
   manually."
2. Live Inspector-equivalent check: `server._registeredTools` byte-identical across all 9 MCP tools
   (zero schema drift) — checked live, not only via the existing characterization test passing.
3. A live boot of `restEntry.js`, driven by a real HTTP client, confirming the actual route
   responses match `docs/REST_FREEZE.md`'s frozen table exactly.
4. The four non-negotiable regression/proof tests (§7) passing, with their assertions read and
   confirmed by the certifying reviewer, not just their exit code.
5. Independent adversarial review (see below) passing clean.
6. `docs/REST_FREEZE.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/releases/
   KNOWN_LIMITATIONS.md`, `docs/releases/MIGRATION_GUIDE.md` all updated and internally consistent
   with each other and with the actual shipped route table.
7. `package.json` version bumped, classified against `docs/FOUNDATION_FREEZE.md`'s policy at this
   point, not pre-decided.
8. No push/tag/release without the user's own explicit go-ahead — this package does not authorize
   any of those actions, only implementation governance up to a certified, locally-committed state.
