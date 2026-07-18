# Engineering Baseline — v2.9.0

Frozen 2026-07-18. This document records the verified state of `claude-delegate-mcp` at the
v2.9.0 release boundary. It is a permanent record and must not be altered after commit.

---

## Version

| Field | Value |
|-------|-------|
| Version | **v2.9.0** |
| Release date | 2026-07-18 |
| Node requirement | ≥ 20 |
| Prior baseline | v2.8.0 (ADR-0011 REST API Foundation) |

---

## Certification Status

| Stage | Status |
|-------|--------|
| Engineering Baseline (v2.8.0) | CERTIFIED |
| ADR-0012 (Dashboard Stage 3) | FROZEN 2026-07-18 |
| Independent Certification | **CERTIFIED** — 0 BLOCKER, 0 HIGH |
| Certification Closeout | **COMPLETE** — all 4 findings closed |
| Release Documentation | **VERIFIED** |
| Final Release Decision | **GO FOR RELEASE** |

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
| ADR-0012 | Dashboard Stage 3 | **FROZEN 2026-07-18** |

---

## Completed Work Packages

| WP | Scope | Tests added |
|----|-------|-------------|
| WP0 | Static-file serving (`src/rest/dashboard.js`) | +26 server tests |
| WP1 | Scaffold, Login (S1), `lib/`, `useJobSubscription` | 24 dashboard tests |
| WP2 | Overview (S2) + `useSnapshot` | 15 dashboard tests |
| WP3 | Jobs (S3) + Job Detail (S4) + `useJobs` | 24 dashboard tests |
| WP4 | Replay section in Job Detail | +4 dashboard tests |
| WP5 | Submit (S6) | 10 dashboard tests |
| WP6 | Metrics (S5) + `useMetrics` | 11 dashboard tests |
| WP7 | Models (S7) | 7 dashboard tests |
| WP8 | NavBar, `lib/fmt.js`, ADR doc, build | 10 dashboard tests |

---

## Certification Findings Closed

| Finding | Severity | Closed |
|---------|----------|--------|
| F-001: `Metrics.jsx` local `fmtMs` | MEDIUM | Import from `lib/fmt.js` |
| F-002: `dist/` not built | LOW | `docs/DEPLOYMENT.md` created |
| F-003: Login no accessible label | LOW | `<label htmlFor="token">` + `<input id="token">` |
| F-004: `useJobSubscription` stops on error | LOW | Auto-retry + error banner in `JobDetail` |

---

## Test Evidence

| Suite | Files | Tests | Result |
|-------|-------|-------|--------|
| Server (node:test) | 17 | **466 / 466** | PASS |
| Dashboard (Vitest) | 17 | **108 / 108** | PASS |
| **Total** | 34 | **574 / 574** | PASS |

Independently verified 2026-07-18. Dashboard tests run file-by-file on Windows (OOM guard).

---

## Build Evidence

| Field | Value |
|-------|-------|
| Command | `npm --prefix dashboard run build` |
| Tool | Vite 5 |
| Modules | 49 |
| Bundle | 184.96 kB (58.18 kB gzip) |
| Entry | `dashboard/dist/index.html` |
| Committed | No — `dashboard/dist/` is in `.gitignore` |

---

## Security Invariants (RC6 — MUST PRESERVE IN ALL FUTURE WORK)

1. **No `innerHTML` / `dangerouslySetInnerHTML`** anywhere in `dashboard/src/`. All job-produced
   text (result, error, progressMessage, promptPreview, phase, metadata) rendered via `textContent`
   only. Independently verified: 0 matches at v2.9.0.
2. **Bearer token** stored in `localStorage`, injected as `Authorization: Bearer` header only.
   Never in URLs. Never logged. `timingSafeEqual` comparison in `auth.js`.
3. **`GET /dashboard/*`** served before REST auth gate — intentionally unauthenticated (static
   assets only, no job data). Must remain before `checkBearerToken` in `restServer.js`.

---

## Release Evidence

| Artifact | Location |
|----------|----------|
| ADR | `docs/adr/ADR-0012-dashboard.md` |
| Deployment guide | `docs/DEPLOYMENT.md` |
| CHANGELOG | `CHANGELOG.md` — `[2.9.0]` entry |
| Release Notes | `docs/releases/RELEASE_NOTES_v2.9.0.md` |
| Release Report | `docs/releases/DASHBOARD_RELEASE_REPORT.md` |
| Baseline (this doc) | `docs/releases/BASELINE_v2.9.0.md` |

---

## Known Limitations

- SSE not implemented. Job Detail polls every 2 s. Accept if adequate; upgrade via new ADR.
- Dashboard built separately (`npm --prefix dashboard run build`); `dist/` not committed.
- Windows: run dashboard test files one-by-one (parallel Vitest hits VirtualAlloc OOM).
- React Router v6 deprecation warnings in tests (v7 future flags); cosmetic, no test failures.

---

## Future Development Rule

> **No future work may modify this baseline directly.**
> **All future work begins through a new ADR or Work Package.**

Any change to Dashboard behavior, REST contracts, MCP schema, security invariants, or
architectural decisions requires a new ADR (ADR-0013+) before implementation begins.
The RC6 constraint (no `innerHTML`/`dangerouslySetInnerHTML`) applies to every future
Dashboard version without exception.
