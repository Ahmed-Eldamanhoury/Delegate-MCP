# ADR-0012 — Dashboard Stage 3

**Status:** Accepted (FROZEN 2026-07-18)  
**Deciders:** Operator  
**Context:** REST API foundation complete (ADR-0011, v2.8.0). Dashboard needed to expose job submission, monitoring, and management to human operators without requiring Claude Desktop.

---

## Decision

Implement a React SPA served directly from the existing REST server at `/dashboard/`, consuming only the frozen REST API (`REST_FREEZE.md`). No new endpoints. No in-process backend access.

---

## Architecture

**Serving:** `src/rest/dashboard.js` — `isDashboardRequest` routes `GET /dashboard/*` before the auth gate; `serveDashboard` streams files from the Vite-built `dashboard/dist/`. Config stub at `/dashboard/config.js` injects `window.__DELEGATE_REST__` before `main.jsx` loads.

**SPA framework:** React 18 + React Router v6 (HashRouter). HashRouter avoids the need for a server-side SPA fallback route — all hash navigation is client-only.

**Authentication:** Bearer token stored in `localStorage` (`delegate-rest-token`). Token is entered once via the Login screen and persisted across sessions. On 401, `client.js` clears the token and dispatches `delegate:unauthorized` — App.jsx listens for this event and redirects to Login. Dashboard routes (`GET /dashboard/*`) served before the auth gate — intentionally unauthenticated for static asset delivery.

**API client:** `src/lib/client.js` — `apiFetch(path, opts)` prepends `window.__DELEGATE_REST__` base URL, injects Bearer header, handles 401 globally. All callers pass paths relative to `/v1/`.

**Security — RC6 hard constraint:** All job-produced text fields (result, error, progressMessage, promptPreview, phase, job metadata) MUST be rendered as plain text using React JSX (textContent). Never `innerHTML`, never `dangerouslySetInnerHTML`. This constraint applies to every screen and every version of the Dashboard.

**Streaming / SSE:** Deferred. `useJobSubscription` polls `GET /v1/jobs/:id` every 2 s. Swap to SSE changes only hook internals — no screen changes required.

---

## Screens

| Screen | Route | Primary endpoint |
|--------|-------|-----------------|
| S1 Login | `/` | — (token entry only) |
| S2 Overview | `/#/overview` | `GET /v1/snapshot` (poll 5 s) + `GET /v1/models` (once) |
| S3 Jobs | `/#/jobs` | `GET /v1/jobs?status=&limit=` (poll 5 s) |
| S4 Job Detail | `/#/jobs/:id` | `GET /v1/jobs/:id` (poll 2 s) + `DELETE /v1/jobs/:id` + `GET /v1/jobs/:id/replay` (lazy) |
| S5 Metrics | `/#/metrics` | `GET /v1/metrics` (poll 5 s) |
| S6 Submit | `/#/submit` | `POST /v1/jobs` |
| S7 Models | `/#/models` | `GET /v1/models` (once, retry on error) |

---

## Hooks

| Hook | Endpoint | Pattern |
|------|----------|---------|
| `useSnapshot` | `/v1/snapshot` | Poll 5 s, tick-based refresh, stale-on-error |
| `useJobs` | `/v1/jobs` | Poll 5 s, status+limit deps restart poll, tick-based refresh |
| `useJobSubscription` | `/v1/jobs/:id` | Poll 2 s, stops on TERMINAL={completed,failed,cancelled} |
| `useMetrics` | `/v1/metrics` | Poll 5 s, tick-based refresh, stale-on-error |

One-time fetches (models endpoint on Overview and Models screen) are managed inline with `useState + useEffect + tick`.

---

## Shared utilities

`src/lib/fmt.js` — `fmtMs(ms)`: formats milliseconds as `Xms` (< 1000) or `X.Xs` (≥ 1000). Shared by Jobs, JobDetail, and Metrics screens.

`src/components/NavBar.jsx` — persistent navigation bar rendered on all protected routes (S2–S7). Links to Overview, Jobs, Submit, Metrics, Models. Sign Out button calls `clearToken()` and dispatches `delegate:unauthorized`.

---

## Sort order

`GET /v1/jobs` returns `jobs.slice(-limit).reverse()` — newest-first from the insertion-order array. Dashboard NEVER re-sorts. Sort order is a server contract, not a client policy.

---

## Work packages

| WP | Content | Status |
|----|---------|--------|
| WP0 | Static-file serving infrastructure | ✓ Complete |
| WP1 | React scaffold, Token Entry (S1), API client, `useJobSubscription` | ✓ Complete |
| WP2 | Overview screen (S2) + `useSnapshot` hook | ✓ Complete |
| WP3 | Jobs (S3) + Job Detail (S4) + `useJobs` hook | ✓ Complete |
| WP4 | Replay section in Job Detail (S4) | ✓ Complete |
| WP5 | Submit screen (S6) | ✓ Complete |
| WP6 | Metrics screen (S5) + `useMetrics` hook | ✓ Complete |
| WP7 | Models screen (S7) | ✓ Complete |
| WP8 | Navigation, shared utilities, release readiness | ✓ Complete |

---

## Constraints (non-negotiable)

- No new REST endpoints.
- No in-process backend access from dashboard code.
- Bearer token never logged, never in URLs.
- All server text via `textContent` only (RC6).
- HashRouter — no SPA fallback route required on the server.

---

## Consequences

- Dashboard is fully self-contained in `dashboard/` — built with `npm --prefix dashboard run build`.
- REST server serves the built SPA from `dashboard/dist/` with zero additional configuration.
- Any new screen follows the same pattern: hook for data fetching, screen component for rendering, TDD tests.
- SSE upgrade path: change only the hook internals; all screens remain unchanged.
