# Final Release Certification — claude-delegate-mcp

**Repository state certified against:** commit `3f79e72` on `main`, local == `origin/main`
(verified via `git rev-parse` on both), working tree clean, no stray worktrees or
branches, 179/179 tests passing locally and in CI across all 4 matrix combinations
(`ubuntu-latest`/`windows-latest` × Node `20.x`/`22.x`), MCP Inspector confirms 6 tools
unchanged.

## The complete stabilization journey

### v1.0.0 → v2.0.0 — Foundation and open-source readiness
Foundation Freeze, Workspace/Artifact persistence (ADR-0001), Streaming/Event architecture
(ADR-0002), the Observability Platform (ADR-0003), a full certification pass
(`docs/CERTIFICATION_REPORT_v1.md`), and release engineering (LICENSE, CONTRIBUTING,
SECURITY, GitHub Actions CI/CodeQL/Dependabot, issue/PR templates). Tagged `v2.0.0`,
pushed to GitHub.

### v2.1.0 — Debug Mode
Visible-terminal CLI execution for development, gated behind `DELEGATE_DEBUG=true`,
additive and fully backward-compatible. 26 new tests.

### v2.2.0 — Production Validation Sprint (dogfooding wave 1)
The first sprint to use Delegate MCP's own `delegate_task`/`delegate_submit` tools to
develop Delegate MCP itself, in an isolated worktree. Fixed three verified defects:
`ConsumerRegistry.pruneStale()`, `MetricsCollector` artifact-count filtering, and Debug
Mode `delegate_cancel` support. Discovered and documented (not fixed) a real,
reproducible defect in Delegate MCP's own reliability: concurrent `delegate_*` MCP tool
calls can silently lose job-tracking state when more than one `server.js` process runs
(root-caused to two live `node.exe` instances holding independent in-memory
`JobManager`s). Produced `SPRINT_REPORT.md`, `PRODUCTION_EVALUATION.md`,
`DELEGATE_VALUE_REPORT.md` with a scoped GO recommendation: use `delegate_submit` for
single long-running tasks, avoid batching `delegate_*` calls.

### v2.2.1 — Critical Stability Sprint
User-redirected to a narrower, explicit scope ("fix only verified High-severity defects
affecting production stability... do NOT include refactoring/cleanup/coverage").
Fixed a reproduced, High-severity defect: Debug Mode's terminal launcher could crash the
**entire MCP server** (every in-flight job, not just the debug one) if its spawned
terminal process failed asynchronously, since no `"error"` listener was ever attached —
an unhandled `"error"` event is an uncaught exception in Node. Investigated the
duplicate-instance problem from v2.2.0 in depth (`ADR-0004`): confirmed via direct
reading of both `src/cli/entry.js` and the vendored MCP SDK's `stdio.js` transport that
(a) no startup single-instance guard exists and (b) the SDK never detects its own
`stdin` closing to self-shut-down. Explicitly declined to implement a fix without first
verifying real MCP-host process-lifecycle behavior, since a naive global lock would
break legitimate concurrent multi-window usage — a live-session-disrupting experiment
not run casually mid-sprint. Produced `SPRINT_REPORT.md` (reframed as this sprint's
Stability Report), `REVIEW_REPORT.md`, `VALUE_REPORT.md`, `PERFORMANCE_REPORT.md`.
Honest finding: `delegate_task`/`delegate_submit` were not used at all this sprint —
both tasks were correctly short enough for the native `Agent` tool under the sprint's own
stated rule, not a missed dogfooding opportunity.

### Post-merge verification & release closure (this effort)
Checking whether the merged, tagged `v2.2.1` release was actually healthy — not assumed.
This is the step that found what two prior sprints' local-Windows-only test runs never
caught:

1. **GitHub Actions had been silently failing since before this sprint began.**
   `tests/debugRunner.test.js`'s cancel-sentinel test relied on a deliberately `unref()`'d
   production timer as its sole means of settling — Node's test runner could judge the
   event loop idle before that timer fired, specifically on Linux CI. Confirmed via
   `gh run view` on the *prior* sprint's own final commit (`c1f3c72`), which already
   showed the identical failure. Fixed, test-only, reviewed and approved.
2. **A second, distinct flake surfaced on the very next CI run.**
   `tests/jobManager.test.js` asserted `runtimeMs >= 20` after two chained 10ms timers —
   wall-clock measurement of chained minimum-delay timers is subject to real precision
   variance, evidently enough to read a hair under 20 on Linux CI. Root-caused (ruled out
   alternative explanations: no bug in `jobManager.js`'s `_run()`, no race in the test's
   polling helper), fixed by loosening to `>= 10` — still robustly clear of the ~18-19ms
   actually observed — after confirming the test's own stated intent was to prove a real
   async gap, not pin exact timer arithmetic. Reviewed and approved.
3. **CodeQL had never once succeeded.** `actions/checkout` failed every run with
   "Repository not found" — root-caused to the workflow's `permissions:` block declaring
   only `security-events: write`; GitHub Actions zeroes every unlisted scope once a job
   declares an explicit `permissions:` block, so the token had zero `contents` access.
   Fixed by adding `contents: read`, then (per review) `actions: read` as well (required
   for private repositories per GitHub's own CodeQL template — confirmed this repo is
   private via `gh repo view`). Both fixes reviewed and approved.
4. **CodeQL's remaining failure is an administrative gap, not a code defect.** After the
   permissions fixes, `checkout`/`init` succeed but `analyze` fails because Code scanning
   is disabled at the repository-settings level — confirmed directly via
   `gh api repos/.../code-scanning/default-setup` returning `403`. This requires the
   repository owner to enable it in GitHub Settings (potential Advanced Security billing
   implications on a private repo), which is outside Claude's authority to change
   unilaterally. Per explicit user decision, this is recorded as an open administrative
   item and does not block certification — CI (the actual code-correctness signal) is
   fully green.

## Summary of every issue found and how it was resolved

| # | Issue | Severity | Found by | Resolution |
|---|---|---|---|---|
| 1 | Debug Mode terminal launcher crashes whole server on spawn failure | High, reproduced | Fresh audit sweep this sprint | Fixed: `child.once("error", ...)` listener; regression test |
| 2 | Duplicate/stale `server.js` instances split job-tracking state | Medium, confirmed via code reading | v2.2.0 sprint (observed), root-caused this sprint | Investigated (ADR-0004); fix deferred pending host-behavior verification |
| 3 | `debugRunner.test.js` cancel-sentinel test flaky on Linux CI | Test-only, CI-blocking | Post-merge Actions check (this effort) | Fixed: ref'd keep-alive guard |
| 4 | `jobManager.test.js` timer-precision assertion flaky on Linux CI | Test-only, CI-blocking | Post-merge Actions check (this effort) | Fixed: loosened `>= 20` to `>= 10` |
| 5 | CodeQL workflow missing `contents`/`actions` permissions | GitHub config, CI-blocking | Post-merge Actions check (this effort) | Fixed: added both scopes to `permissions:` |
| 6 | Code scanning disabled at repository-settings level | GitHub admin config | Post-fix CodeQL run (this effort) | Documented as open administrative item; requires owner action |

## Remaining Known Limitations

1. Duplicate-server-instance job-tracking risk (`ADR-0004`) — mitigated operationally
   (avoid batching `delegate_*` calls), not architecturally fixed.
2. `ConsumerRegistry.pruneStale()` has no scheduled caller yet.
3. Code scanning disabled at the repository-settings level (administrative, not code).
4. Several Low-severity code-cleanliness findings deferred to a future Cleanup Sprint
   (a hand-rolled recursive directory walker, a single-use wrapper module, a dead options
   field, a single-subclass error base class).
5. `package-lock.json`'s stale version field (cosmetic, pre-existing).

## Is Delegate MCP suitable for daily development of Delegate MCP itself?

**Yes, with the operating discipline this project's own dogfooding sprints established:**
one `delegate_*` MCP call at a time (never batched), preferring the native `Agent` tool
for anything short or needing to run alongside other work in the same turn. The codebase
itself is now verified stable — 179/179 tests green locally and in real CI, the one
reproduced crash defect closed, and this closure effort itself proved out the discipline
of checking real CI state rather than trusting local runs alone. That discipline is now
part of how this project verifies its own releases going forward.

## Recommended first Dogfooding Sprint

Given `ADR-0004`'s deferred recommendation and this sprint's own operating discipline,
the natural next dogfooding sprint is: **verify actual MCP-host (Claude Desktop) child-
process lifecycle behavior, then implement the `stdin`-close self-shutdown fix ADR-0004
recommends** — using Delegate MCP's own `delegate_submit` for the implementation task
(a good match for its proven strength: a single, substantial, well-scoped background
task), with the same TDD/review/worktree discipline this stabilization effort used
throughout. This would close the last open architectural item from the dogfooding
program and give a second real data point on `delegate_submit`'s value, following the
same evidence-based pattern established across every sprint so far.

## Verdict

**CERTIFIED FOR DAILY DEVELOPMENT**
