# Release Notes — v2.9.0

`claude-delegate-mcp`: an MCP server that delegates tasks from Claude Desktop to a headless
Claude Code CLI session, billed against your existing Claude subscription — no separate API key.

This release adds the **Dashboard** (ADR-0012 Stage 3): a full-featured React SPA served
directly from the existing REST server, letting you monitor and manage jobs from a browser
without needing Claude Desktop or any CLI.

Certified per [DASHBOARD_RELEASE_REPORT.md](DASHBOARD_RELEASE_REPORT.md). Zero new REST
endpoints. Zero MCP schema change. Fully additive.

---

## What's New

### Dashboard (`GET /dashboard/`)

A React 18 SPA served at `http://127.0.0.1:8787/dashboard/` by the REST server you already
have running. One bearer-token login, then full access to:

| Screen | Route | What it shows |
|--------|-------|---------------|
| Login | `/#/` | Token entry — stores to localStorage, never in a URL |
| Overview | `/#/overview` | Live KPIs (queued/running/completed/failed/cancelled), active-job table, queue stats, model defaults. Polls every 5 s. |
| Jobs | `/#/jobs` | Paginated job list with status filter + ID search. Click any row for detail. Polls every 5 s. |
| Job Detail | `/#/jobs/:id` | Full job metadata, cancel button, result display, replay timeline. Polls every 2 s; stops when terminal. |
| Metrics | `/#/metrics` | Runtime stats, event counts, queue wait averages. Polls every 5 s. |
| Submit | `/#/submit` | Job submission form (prompt, model, effort, optional budget cap). |
| Models | `/#/models` | Available models, effort presets, default configuration. One-time fetch, retry on error. |

Navigation bar on all protected screens (Overview / Jobs / Submit / Metrics / Models / Sign Out).

### Security

- **RC6 hard constraint**: all server-produced text rendered as `textContent` — never
  `innerHTML`, never `dangerouslySetInnerHTML`. Applies to every job field (result, error,
  progress, phase, metadata) on every screen and every future version.
- **Bearer token**: stored in `localStorage`, injected as `Authorization: Bearer` header only,
  never in URLs, never logged.
- **Dashboard routes** (`GET /dashboard/*`): served before the REST auth gate — intentionally
  unauthenticated, as they expose only static assets (no job data, no secrets).

---

## Deployment

**Build the dashboard before first use:**

```
npm --prefix dashboard install   # first time only
npm --prefix dashboard run build
```

Then start the REST server as before:

```
node src/cli/restEntry.js
```

Navigate to `http://127.0.0.1:8787/dashboard/` and enter your bearer token from
`.delegate-rest-token`.

Full deployment guide: [docs/DEPLOYMENT.md](../DEPLOYMENT.md).

---

## Compatibility

- **Zero MCP schema change.** All 9 Claude Desktop tools (`delegate_task`, `delegate_submit`,
  `delegate_status`, `delegate_history`, `delegate_cancel`, `delegate_models`, `delegate_replay`,
  `delegate_snapshot`, `delegate_metrics`) are byte-identical.
- **Zero REST contract change.** All 9 REST routes remain exactly as documented in
  `REST_FREEZE.md`. No new endpoints were created.
- **Opt-in.** Dashboard is only available when `npm --prefix dashboard run build` has been run.
  If `dashboard/dist/` is absent, all `/dashboard/` requests return 404 — REST API unaffected.
- **Node ≥ 20** (unchanged from v2.8.0).

---

## Test Results

| Suite | Count | Result |
|-------|-------|--------|
| Server (node:test) | 466 / 466 | PASS |
| Dashboard (Vitest, 17 files) | 108 / 108 | PASS |
| Production build | 49 modules, 184.96 kB / 58.18 kB gzip | PASS |

---

## Certification

Independent audit conducted under ADR-0012. Decision: **CERTIFIED** (2026-07-18).

All 4 post-certification findings subsequently closed:

| Finding | Severity | Resolution |
|---------|----------|------------|
| F-001: Metrics.jsx local fmtMs | MEDIUM | Replaced with import from `lib/fmt.js` |
| F-002: dist not built | LOW | `docs/DEPLOYMENT.md` created with explicit build prerequisite |
| F-003: Login no label | LOW | `<label htmlFor="token">` + `<input id="token">` added |
| F-004: job sub stops on error | LOW | `setTimeout(poll, 2000)` in catch; `setError(null)` on success; error banner in JobDetail |

Full evidence: [DASHBOARD_RELEASE_REPORT.md](DASHBOARD_RELEASE_REPORT.md).
