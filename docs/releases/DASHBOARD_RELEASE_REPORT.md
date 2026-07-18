# Dashboard Release Report — v2.9.0

Certification evidence index and release summary for the Dashboard (ADR-0012 Stage 3).
Produced: 2026-07-18.

---

## Release Identity

| Field | Value |
|-------|-------|
| Version | v2.9.0 |
| ADR | ADR-0012-dashboard.md (FROZEN 2026-07-18) |
| Scope | React SPA served from `/dashboard/` — REST-only client, no new endpoints |
| Certification | **CERTIFIED** |
| Closeout | **COMPLETE** |

---

## Engineering Baseline

| Artifact | Location | Status |
|----------|----------|--------|
| ADR-0011 REST API Foundation | `docs/adr/ADR-0011-rest-api-foundation.md` | FROZEN |
| REST contract | `docs/REST_FREEZE.md` | FROZEN |
| Foundation freeze | `docs/FOUNDATION_FREEZE.md` | FROZEN |
| Observability freeze | `docs/OBSERVABILITY_FREEZE.md` | FROZEN |
| MCP tools schema | `tests/toolRegistry.characterization.test.js` | 9 tools, byte-identical |

Baseline test count entering Dashboard work: **466/466** server tests.

---

## ADR-0012 Evidence

| Requirement | Implementation | Verified |
|-------------|----------------|---------|
| HashRouter | `App.jsx:2,33` | ✓ |
| REST-only client | `lib/client.js` — `apiFetch` only | ✓ |
| `window.__DELEGATE_REST__` | `lib/baseUrl.js:2` / `dashboard.js:57` | ✓ |
| `/dashboard/*` before auth gate | `restServer.js` + `dashboard.js:29` | ✓ |
| Path-traversal guard | `dashboard.js:74` | ✓ |
| Bearer token not in URLs | `client.js:9` (header only) | ✓ |
| Bearer token not logged | `auth.js`, `client.js` (no logging) | ✓ |
| **RC6: no `innerHTML`/`dangerouslySetInnerHTML`** | grep across `dashboard/src` → **0 matches** | ✓ |
| All 7 screens implemented | S1–S7 verified in source | ✓ |
| NavBar on all protected routes | `App.jsx:16-19` (ProtectedLayout) | ✓ |
| Sort order: never re-sorted | `Jobs.jsx:20` — filter only, no sort | ✓ |
| SSE deferred — hook polls | `useJobSubscription.js` — 2 s poll | ✓ |
| No new REST endpoints | `src/rest/routes/` unchanged | ✓ |

---

## Work Package Evidence

| WP | Content | Tests added | Status |
|----|---------|-------------|--------|
| WP0 | Static-file serving (`dashboard.js`) | `restDashboard.unit.test.js`, `restDashboard.integration.test.js` (+26 server) | ✓ COMPLETE |
| WP1 | Scaffold, Login (S1), `lib/`, `useJobSubscription` | `auth`, `baseUrl`, `client`, `Login`, `App`, `useJobSubscription` (24 dashboard) | ✓ COMPLETE |
| WP2 | Overview (S2) + `useSnapshot` | `useSnapshot`, `Overview` (15 dashboard) | ✓ COMPLETE |
| WP3 | Jobs (S3) + Job Detail (S4) + `useJobs` | `useJobs`, `Jobs`, `JobDetail` (24 dashboard) | ✓ COMPLETE |
| WP4 | Replay section in Job Detail | `JobDetail` +4 | ✓ COMPLETE |
| WP5 | Submit (S6) | `Submit` (10 dashboard) | ✓ COMPLETE |
| WP6 | Metrics (S5) + `useMetrics` | `useMetrics`, `Metrics` (11 dashboard) | ✓ COMPLETE |
| WP7 | Models (S7) | `Models` (7 dashboard) | ✓ COMPLETE |
| WP8 | NavBar, `lib/fmt.js`, ADR doc, build | `NavBar`, `fmt`, `App` +1 (10 dashboard) | ✓ COMPLETE |

---

## Independent Certification

**Decision: CERTIFIED** (2026-07-18)

| Category | Findings | Severity |
|----------|----------|----------|
| Architecture compliance | None | — |
| REST compliance | None | — |
| RC6 hard constraint | None — 0 innerHTML/dangerouslySetInnerHTML | — |
| Authentication | None | — |
| F-001: Metrics local fmtMs | 1 finding | MEDIUM |
| F-002: dist not built | 1 finding | LOW |
| F-003: Login no accessible label | 1 finding | LOW |
| F-004: job sub stops on error | 1 finding | LOW |

**BLOCKER: 0 | HIGH: 0 | MEDIUM: 1 | LOW: 3**

---

## Certification Closeout Evidence

All 4 findings closed 2026-07-18:

| Finding | Fix | New tests | Verification |
|---------|-----|-----------|--------------|
| F-001 | `import { fmtMs } from '../lib/fmt.js'` in `Metrics.jsx` (local function removed) | None needed (identical behavior) | Metrics 6/6 pass |
| F-002 | `docs/DEPLOYMENT.md` created; `dashboard/dist/` confirmed in `.gitignore` | Build gate in DEPLOYMENT.md checklist | Build ✓ 49 modules |
| F-003 | `<label htmlFor="token">Bearer token</label>` + `<input id="token">` in `Login.jsx` | `'token input has accessible label'` (Login.test.jsx) | `getByLabelText` GREEN |
| F-004 | `timer = setTimeout(poll, 2000)` in catch; `setError(null)` on success (useJobSubscription); error banner in JobDetail | `'retries polling after transient fetch error'` (useJobSubscription); `'shows poll error banner with stale data'` (JobDetail) | uJS 7/7, JD 12/12 |

---

## Test Results (final, post-closeout)

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Server (node:test) | 17 test files | 466 / 466 | **PASS** |
| Dashboard (Vitest) | 17 test files | 108 / 108 | **PASS** |
| **Total** | 34 files | **574 / 574** | **PASS** |

Dashboard test file inventory: `auth`, `baseUrl`, `client`, `fmt`, `Login`, `App`, `NavBar`,
`useSnapshot`, `useJobs`, `useJobSubscription`, `useMetrics`, `Overview`, `Jobs`, `JobDetail`,
`Submit`, `Metrics`, `Models`.

---

## Production Build

| Field | Value |
|-------|-------|
| Command | `npm --prefix dashboard run build` |
| Tool | Vite 5 |
| Modules | 49 |
| Bundle size | 184.96 kB (58.18 kB gzip) |
| Entry | `dashboard/dist/index.html` + `dashboard/dist/assets/index-*.js` |
| Artifacts committed | No — `dashboard/dist/` in `.gitignore` |

---

## Deployment Documentation

| Document | Location |
|----------|----------|
| Deployment guide | `docs/DEPLOYMENT.md` |
| ADR | `docs/adr/ADR-0012-dashboard.md` |
| REST contract | `docs/REST_FREEZE.md` |
| Release notes | `docs/releases/RELEASE_NOTES_v2.9.0.md` |
| CHANGELOG | `CHANGELOG.md` (`[2.9.0]` entry) |

---

## Release Readiness Checklist

- [x] ADR-0012 FROZEN
- [x] WP0–WP8 complete
- [x] Independent certification: CERTIFIED
- [x] All 4 certification findings CLOSED
- [x] 466/466 server tests pass
- [x] 108/108 dashboard tests pass (17 files, TDD RED→GREEN verified)
- [x] Production build: ✓ (49 modules)
- [x] RC6 constraint verified (0 innerHTML matches)
- [x] Bearer token security verified (header only, not logged, not in URLs)
- [x] `dashboard/dist/` excluded from git
- [x] `docs/DEPLOYMENT.md` documents build prerequisite
- [x] `CHANGELOG.md` `[2.9.0]` entry prepended
- [x] `package.json` bumped to `2.9.0`
- [x] `docs/releases/RELEASE_NOTES_v2.9.0.md` created
- [x] Zero new REST endpoints (REST contract unchanged)
- [x] Zero MCP schema change (baseline byte-identical)
- [ ] Operator action: run `npm --prefix dashboard run build`
- [ ] Operator action: `git add` + `git commit` + `git tag v2.9.0`
- [ ] Operator action: `git push origin main && git push origin v2.9.0`
