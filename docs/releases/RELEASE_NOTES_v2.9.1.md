# Release Notes — v2.9.1

**Date:** 2026-07-18  
**Type:** Patch release  
**Prior release:** [v2.9.0](RELEASE_NOTES_v2.9.0.md) — Dashboard Stage 3 (ADR-0012)

---

## Summary

v2.9.1 is a purely operational patch. It adds the missing `restServer.js` runtime entry point
that was specified in the Dashboard Stage 3 WP2 design but not created during implementation,
and corrects `docs/DEPLOYMENT.md`'s start command to reference it.

**No application behaviour changes. No API changes. No security changes.**

---

## Reason for Patch Release

Tag `v2.9.0` was created on commit `964a285`. The operational hotfix (`restServer.js` +
`DEPLOYMENT.md` correction) was committed as `bd0e1b1` after the tag. The hotfix was
independently certified (`HOTFIX CERTIFIED` 2026-07-18) and classified as a **patch** under
the project's own versioning policy ("doc correction, non-behavioral change"). `v2.9.1`
captures the certified hotfix under a proper version tag.

---

## Changes

### Added — `restServer.js` (root-level entry point)

```js
// REST server entrypoint — analogous to server.js for the MCP transport.
import { main } from "./src/cli/restEntry.js";

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});
```

**Why this was missing:** `src/cli/restEntry.js` exports `main()` but intentionally does not
call it at module level, so that test files can import `buildRouteTable` and
`registerRestShutdownHandlers` without starting a live server. A top-level calling wrapper
(`restServer.js`) was specified in the WP2 design document alongside `restEntry.js` but was
not created at implementation time. As a result, running `node src/cli/restEntry.js` exited
immediately with code 0 — it did nothing.

**Resolution:** `restServer.js` (4 lines) mirrors the `server.js` → `entry.js` pattern already
established for the MCP stdio transport.

### Fixed — `docs/DEPLOYMENT.md` start command

| Before | After |
|--------|-------|
| `node src/cli/restEntry.js` | `node restServer.js` |

---

## What Did NOT Change

| Area | Status |
|------|--------|
| REST routes (9 frozen routes) | Unchanged |
| REST auth (`timingSafeEqual`, bearer token) | Unchanged |
| MCP interfaces (9 tools) | Unchanged |
| Dashboard source (`dashboard/src/`) | Unchanged |
| Dashboard build output | Unchanged |
| Security invariant RC6 (no `innerHTML`) | Unchanged |
| Server tests | 466 / 466 — identical to v2.9.0 |
| Dashboard tests | 108 / 108 — identical to v2.9.0 |
| ADR-0012 (FROZEN) | Unchanged |
| Engineering Baseline v2.9.0 | Unchanged — patch does not amend it |

---

## Certification Reference

| Stage | Status |
|-------|--------|
| Engineering Baseline (v2.9.0) | CERTIFIED |
| Independent Certification (v2.9.0) | CERTIFIED — 0 BLOCKER, 0 HIGH |
| Hotfix Certification (bd0e1b1) | **HOTFIX CERTIFIED** — 2026-07-18 |
| Version Decision | **CREATE v2.9.1** — confirmed by independent Release Manager |

Hotfix certification confirmed:
- Zero findings
- No contract changes
- No security impact
- 466/466 server tests pass
- Server startup via `restServer.js` verified live on port 8787

---

## Upgrade Instructions

No migration required. If you were running the REST server:

**Stop using:**
```
node src/cli/restEntry.js
```

**Use instead:**
```
node restServer.js
```

All other configuration, environment variables, bearer tokens, and MCP stdio startup
(`node server.js`) are unchanged.

---

## Known Limitations (inherited from v2.9.0)

- SSE not implemented — Job Detail polls every 2 s.
- `dashboard/dist/` must be built before starting the server; it is not committed.
- Windows: run dashboard Vitest test files one-by-one (parallel execution hits VirtualAlloc OOM).
- React Router v6 deprecation warnings in tests (cosmetic only, no test failures).
