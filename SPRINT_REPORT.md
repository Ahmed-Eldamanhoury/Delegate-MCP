# Sprint Report — Dogfooding Sprint (Stdin-Close Self-Shutdown)

**Branch:** `worktree-dogfooding-stdin-shutdown` (merged, fast-forward, to `main` at `024ed6d`)
**Base:** `d962157` (main, tip before this sprint)
**Date:** 2026-07-15
**Framing:** an explicit Dogfooding Sprint — the primary question was whether Delegate MCP
is mature enough to be its own project's primary development environment, not just
whether the feature landed. See [DOGFOODING_REPORT.md](DOGFOODING_REPORT.md) for the
Delegate-MCP-usage narrative, [DOGFOODING_METRICS.md](DOGFOODING_METRICS.md) for raw
numbers, [DOGFOODING_DECISION.md](DOGFOODING_DECISION.md) for the verdict, and
[VALUE_REPORT.md](VALUE_REPORT.md) for the value assessment.

This report supersedes the prior sprint's `SPRINT_REPORT.md` (that sprint's Critical
Stability Sprint record is preserved in git history at commit `c1f3c72` and referenced by
name here).

## Scope

`FINAL_RELEASE_CERTIFICATION.md` (from the Critical Stability Sprint) had already named
this sprint's target: implement ADR-0004's recommended stdin-close self-shutdown fix. A
prior session had already started this — a worktree existed with one commit (the plan)
and uncommitted code (the extraction + tests) — left mid-flight. Continuing that
in-flight work, rather than re-deriving target selection from scratch, was confirmed with
the user before proceeding.

## What was found and fixed

**A real, blocking defect, found before the sprint's actual target could be verified.**
Resuming the plan and running its own (already-written, uncommitted) tests hung `npm test`
indefinitely. Root cause: `src/cli/entry.js`'s `main().catch(...)` ran unconditionally at
*import* time, so the test file's own `import { registerShutdownHandlers } from
"../src/cli/entry.js"` also started a real, `stdio`-connected MCP server that never
exits. Confirmed directly: `npm test` had to be forcefully killed, leaving orphaned
`node.exe` processes on the host machine (the exact class of problem ADR-0004 itself
documents, reproduced live during this sprint).

The standard fix idiom (`import.meta.url === process.argv[1]`, the ESM replacement for
`require.main === module`) does **not** work for this repository's structure:
`server.js` is the actual, documented production entrypoint and reaches `entry.js` via
`import "./src/cli/entry.js"` — meaning `process.argv[1]` is always `server.js`'s own
path, never `entry.js`'s, even in the one legitimate production case. That guard would
have silently broken real startup while "fixing" the test.

**Fix:** `entry.js` no longer calls `main()` itself — it is now a pure module, safe to
import with zero side effects. `server.js` (the one file whose job is being the real
entrypoint) now imports and calls `main()` explicitly. Verified via a genuine TDD
red-green cycle performed twice — once by the implementer subagent, once independently
by the controller (the bug was deliberately reintroduced, confirmed the regression test
fails/hangs again, then the fix was restored and 185/185 reconfirmed) — plus an MCP
Inspector check (independently repeated) proving `server.js` still boots the real server
end-to-end, unchanged.

**The sprint's actual target landed as designed.** `registerShutdownHandlers()` routes
`SIGINT`/`SIGTERM`/`stdin`-end through one shared shutdown path, tested against injected
fakes (6 tests). Live MCP-host disconnect behavior remains explicitly unverified, exactly
as ADR-0004's own Decision scoped it — that verification requires deliberately disrupting
a live session and was out of scope here, same as the sprint that wrote the ADR.

## Verification performed

- `npm test`: 185/185 (179 pre-existing + 6 new), independently re-run multiple times by
  the controller, not just trusted from the implementer's report.
- Manual RED-GREEN re-verification: bug reintroduced → confirmed hang/fail → fix restored
  → confirmed green, done by the controller directly (not delegated to the implementer's
  own claim).
- MCP Inspector (`tools/list`): 6/6 tools unchanged, run independently twice.
- GitHub Actions on the merged, pushed, tagged commit: green across all 4 matrix
  combinations (ubuntu-latest/windows-latest × Node 20.x/22.x), watched live via
  `gh run watch`, not assumed from a prior sprint's pattern.
- CodeQL: same pre-existing, already-documented administrative gap (code scanning
  disabled at the repository-settings level) — confirmed not a new regression by reading
  the run's own annotations.
- `ponytail-review` (diff) and `ponytail-audit` (whole-repo, via `delegate_submit`): see
  [DOGFOODING_REPORT.md](DOGFOODING_REPORT.md) for findings; none blocking, all either
  pre-existing (deferred to a future Cleanup Sprint per established project convention)
  or newly-flagged-but-minor.

## Deviation from standard process, disclosed

The per-task reviewer subagent that `subagent-driven-development` specifies was never
dispatched for Task 0 — the user explicitly redirected mid-sprint to stop relying on an
async reviewer wait and have the controller verify independently instead. Recorded here
plainly: no reviewer was ever launched, so nothing "timed out" in the literal sense; the
substitute verification is detailed above and in `DOGFOODING_REPORT.md`.

## Release

Merged to `main` (fast-forward, `024ed6d`), version bumped to `2.2.2`, `CHANGELOG.md` and
`docs/releases/KNOWN_LIMITATIONS.md` and `docs/adr/ADR-0004-server-instance-lifecycle.md`
reconciled, tagged `v2.2.2`, pushed to `origin` — all with explicit user sign-off at each
git-safety checkpoint (continue-in-flight-work, bug-fix design, finish-branch choice,
tag-and-push).

## Test status

185/185 passing locally and in CI after this sprint's fix landed (179 pre-existing + 6
new in `entry.test.js`). Before the fix, the suite did not reach a clean pass/fail count
at all — it hung indefinitely and required a forced kill; that hang was itself this
sprint's first finding, not a baseline to compare against.
