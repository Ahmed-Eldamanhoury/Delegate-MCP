# Deployment Guide — REST Server + Dashboard

Covers the prerequisites and steps for running the REST server with the Dashboard enabled.
The MCP stdio server (`src/cli/entry.js`) has no additional prerequisites and is unaffected.

## Prerequisites

### 1. Build the Dashboard (required)

The Dashboard is a React SPA served by the REST server from `dashboard/dist/`.
**The `dashboard/dist/` directory is not committed — you must build it before starting the server.**

```
npm --prefix dashboard install   # first time only
npm --prefix dashboard run build
```

Expected output: `vite build … ✓ 49 modules transformed … built in ~700ms`

If `dashboard/dist/` is absent, the REST server starts normally but all requests to
`/dashboard/` return 404. No other functionality is affected.

### 2. Generate or configure the bearer token

The REST server requires a bearer token for all `/v1/` routes.
On first boot, a token is auto-generated and written to `.delegate-rest-token`.

To supply your own token:
```
export CLAUDE_DELEGATE_REST_TOKEN=<your-token>
```

## Starting the REST server

```
node restServer.js
```

Default bind: `127.0.0.1:8787`. Override with `CLAUDE_DELEGATE_REST_HOST` / `CLAUDE_DELEGATE_REST_PORT`.

## Accessing the Dashboard

Navigate to: `http://127.0.0.1:8787/dashboard/`

Enter the bearer token from `.delegate-rest-token` (or your configured token) in the Login screen.

## Release checklist addition (Dashboard)

When cutting a release that includes Dashboard changes, append to the standard
`docs/RELEASE_CHECKLIST.md` gate:

- [ ] **Dashboard built**: `npm --prefix dashboard run build` exits 0.
- [ ] **Dashboard tests green**: 17 test files, all pass (run file-by-file on Windows — see OOM note in `docs/adr/ADR-0012-dashboard.md`).
- [ ] **Dashboard dist not committed**: confirm `dashboard/dist/` is in `.gitignore`.
