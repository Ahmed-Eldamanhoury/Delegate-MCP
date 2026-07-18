# Open Source Certified Baseline — v2.9.2

Frozen 2026-07-18. This document records the verified state of `claude-delegate-mcp` at the
post-v2.9.1 open-source certification boundary (commit `c19ec15`). It is a permanent record
and must not be altered after commit.

---

## Baseline Identifier

| Field | Value |
|-------|-------|
| Baseline | **v2.9.2** (governance baseline — no new version tag) |
| Commit | **`c19ec15`** |
| Branch | `main` |
| Frozen | 2026-07-18 |
| Anchored version | v2.9.1 (tag `f6b5ea7`) |
| Prior baseline | `docs/releases/BASELINE_v2.9.0.md` |
| Node requirement | ≥ 20 |

---

## Certification Status

| Stage | Status |
|-------|--------|
| Engineering Baseline (v2.9.0) | CERTIFIED |
| Patch Release v2.9.1 | **RELEASED** — restServer.js entry point; HOTFIX CERTIFIED |
| Deployment Verification (v2.9.0) | **DEPLOYMENT VERIFIED** |
| Apache-2.0 Migration | **PUBLISHED** — commit `80197d0` |
| Open Source Certification (initial) | OPEN SOURCE NOT READY (F-001 HIGH: migration uncommitted) |
| F-001 Remediation | **CLOSED** — Apache-2.0 committed and pushed (`80197d0`) |
| Open Source Certification (v2) | **OPEN SOURCE CERTIFIED** — score 89/100, no HIGH+ findings |
| F-002/F-003/F-004 Remediation | **CLOSED** — commit `c19ec15` |
| Final Repository Certification | **FULLY CERTIFIED** — score 93/100, zero findings of any severity |

---

## Apache-2.0 Status

| Artifact | Status |
|----------|--------|
| `LICENSE` | Apache License Version 2.0 — full text, `END OF TERMS AND CONDITIONS` confirmed |
| `package.json` | `"license": "Apache-2.0"` |
| `README.md` | `- **License**: [Apache-2.0](LICENSE)` |
| `NOTICE` | Copyright 2026 Delegate-MCP; `@modelcontextprotocol/sdk` (MIT); `zod` (MIT); `fast-uri` v3.1.3 (BSD-3-Clause, Gary Court / Fastify team); `json-schema-typed` v8.0.2 (BSD-2-Clause, Remy Rylan); `qs` v6.15.3 (BSD-3-Clause, Nathan LaFreniere) |
| `CONTRIBUTING.md` | Apache-2.0 contributor license clause present |
| Dependency compatibility | All 90+ transitive deps: MIT, ISC, BSD-2-Clause, BSD-3-Clause — all permissive, all Apache-2.0 compatible. Zero GPL/LGPL/AGPL. |

---

## Community Health Status

| File | Location | Status |
|------|----------|--------|
| `README.md` | root | ✓ |
| `LICENSE` | root | ✓ Apache-2.0 |
| `NOTICE` | root | ✓ Full attribution |
| `CONTRIBUTING.md` | root | ✓ License clause + Distribution section |
| `CODE_OF_CONDUCT.md` | root | ✓ Contributor Covenant v2.1 |
| `SECURITY.md` | root | ✓ GitHub private vulnerability reporting; `main` branch |
| `SUPPORT.md` | root | ✓ |
| `CODEOWNERS` | `.github/CODEOWNERS` | ✓ `* @Ahmed-Eldamanhoury` |
| Issue template: bug | `.github/ISSUE_TEMPLATE/bug_report.md` | ✓ |
| Issue template: feature | `.github/ISSUE_TEMPLATE/feature_request.md` | ✓ |
| Issue template: question | `.github/ISSUE_TEMPLATE/question.md` | ✓ |
| PR template | `.github/PULL_REQUEST_TEMPLATE.md` | ✓ 6-item checklist incl. REST freeze + RC6 invariant |
| CI | `.github/workflows/ci.yml` | ✓ ubuntu+windows × Node 20+22; push+PR to `main` |
| CodeQL | `.github/workflows/codeql.yml` | ✓ javascript-typescript; weekly + push+PR to `main` |
| Dependabot | `.github/dependabot.yml` | ✓ npm + github-actions; weekly |

---

## Release History

| Version | Tag | Commit | Date | Scope |
|---------|-----|--------|------|-------|
| v2.0.0 | `v2.0.0` | — | — | MCP foundation |
| v2.2.1 | `v2.2.1` | — | — | — |
| v2.2.2 | `v2.2.2` | — | — | — |
| v2.3.0 | `v2.3.0` | — | — | — |
| v2.4.0 | `v2.4.0` | — | — | — |
| v2.5.0 | `v2.5.0` | — | — | — |
| v2.6.0 | `v2.6.0` | — | — | — |
| v2.7.0 | `v2.7.0` | — | — | — |
| v2.7.1 | `v2.7.1` | — | — | — |
| v2.8.0 | `v2.8.0` | `ab29529` | — | REST API Foundation (ADR-0011) |
| v2.9.0 | `v2.9.0` | `964a285` | 2026-07-18 | Dashboard Stage 3 (ADR-0012); CERTIFIED |
| v2.9.1 | `v2.9.1` | `f6b5ea7` | 2026-07-18 | Patch — `restServer.js` entry point; HOTFIX CERTIFIED |
| *(baseline)* | *(none)* | `c19ec15` | 2026-07-18 | Apache-2.0 + community + finding closure; FULLY CERTIFIED |

---

## Test Status

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Server (node:test) | 17 | **466 / 466** | PASS |
| Dashboard (Vitest) | 17 | **108 / 108** | PASS |
| **Total** | 34 | **574 / 574** | **PASS** |

Independently verified 2026-07-18. 466/466 server tests re-run at `c19ec15` and confirmed
passing with 0 failures.

---

## ADR Status

| ADR | Title | Status |
|-----|-------|--------|
| ADR-0001 | Workspace and Artifact Architecture | FROZEN |
| ADR-0002 | Streaming and Event Architecture | FROZEN |
| ADR-0003 | Observability Architecture | FROZEN |
| ADR-0004 | Server Instance Lifecycle | FROZEN |
| ADR-0005 | Persistent Job Store | FROZEN |
| ADR-0006 | Persistent Event History | FROZEN |
| ADR-0007 | MCP Replay Access | FROZEN |
| ADR-0008 | MCP Metrics Access | FROZEN |
| ADR-0009 | MCP Snapshot Access | FROZEN |
| ADR-0010 | Unified Access Layer | FROZEN |
| ADR-0011 | REST API Foundation | FROZEN |
| ADR-0012 | Dashboard Stage 3 | FROZEN |

---

## Architectural Freeze Reference

All three freeze documents are active and binding:

| Document | Scope |
|----------|-------|
| `docs/FOUNDATION_FREEZE.md` | 9 MCP tool schemas, job lifecycle, `ExecutionContext`, `RuntimeEventBus`, `ObservabilityService` public methods |
| `docs/REST_FREEZE.md` | 9 REST routes (paths, methods, status codes, JSON shapes, auth header, CORS, bind address) |
| `docs/OBSERVABILITY_FREEZE.md` | `ObservabilityService` contracts and passive-observation rule |

Any change to a frozen contract requires a new ADR (ADR-0013+) before implementation begins.

---

## Security Invariants (RC6 — MUST PRESERVE IN ALL FUTURE WORK)

1. **No `innerHTML` / `dangerouslySetInnerHTML`** anywhere in `dashboard/src/`. All job-produced
   text rendered via `textContent` only. Verified 0 matches at this baseline. Enforced in PR
   template checklist.
2. **Bearer token** stored in `localStorage`, injected as `Authorization: Bearer` header only.
   Never in URLs. Never logged. `timingSafeEqual` comparison in `auth.js`.
3. **`GET /dashboard/*`** served before REST auth gate — intentionally unauthenticated (static
   assets only, no job data). Must remain before `checkBearerToken` in `restServer.js`.
4. **No shell subprocess**: `claudeCliService.js` spawns `claude.exe` directly via `spawn()`,
   `shell: false`. The `.cmd`/`.bat` shim must never be used as the target binary.
5. **Path safety**: every filesystem path derived from a job id is gated by `isValidJobId()`
   UUID-format check before use.

---

## Accepted Design Decisions (not findings)

| ID | Decision |
|----|----------|
| D-001 | `"private": true` in `package.json` — intentional; distribution via GitHub clone, not npm; documented in `CONTRIBUTING.md` "Distribution" section |
| D-002 | No CD pipeline — locally-run tool; no deployment target exists |
| D-003 | `FUNDING.yml` absent — optional; not required by GitHub Community Standards |
| D-004 | `dashboard/dist/` not committed — in `.gitignore` per ADR-0012; build documented in `docs/DEPLOYMENT.md` |
| D-005 | No branch protection rule enforcing CI — single-maintainer; risk is low; GitHub settings layer outside repository content |

---

## Future Development Policy

> **No future work may modify this baseline directly.**
> **All future work begins through a new ADR (ADR-0013+) or Work Package.**

1. Any change to MCP tool schemas, job lifecycle, REST routes, or `ObservabilityService`
   contracts requires a new ADR before implementation.
2. The RC6 constraint (no `innerHTML` / `dangerouslySetInnerHTML`) applies to every future
   Dashboard version without exception.
3. The REST contract is frozen at 9 routes. No new routes without a new ADR.
4. All patches and releases follow the versioning policy in `docs/REST_FREEZE.md`:
   patch = non-behavioral/doc-correction, minor = additive, major = breaking.
5. Apache-2.0 license applies to all future contributions per `CONTRIBUTING.md`.
