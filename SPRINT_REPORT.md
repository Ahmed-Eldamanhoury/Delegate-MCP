# Sprint Report — Critical Stability Sprint

**Branch:** `worktree-critical-stability-sprint`
**Base:** `c1f3c72` (main, pushed to origin before this worktree was created)
**Date:** 2026-07-14 (same session as the prior production-validation sprint)
**Framing:** the user explicitly requested this document double as the sprint's
**Stability Report** — see the "What was improved / fixed" sections below for that
framing; separate [REVIEW_REPORT.md](REVIEW_REPORT.md),
[VALUE_REPORT.md](VALUE_REPORT.md), and [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md)
cover review findings, the Delegate MCP evaluation, and timing/cost data respectively.

This report supersedes the prior sprint's `SPRINT_REPORT.md` (that sprint's production-
validation record is preserved in git history at commit `c1f3c72` and referenced by name
throughout this document and its siblings).

## Scope, as explicitly redefined by the user mid-sprint

The original ask offered a broader menu (crash fix + 4 mechanical cleanups + 4
coverage tasks). The user redirected to a narrower, explicit **"Critical Stability
Sprint"**:

> Fix only verified High-severity defects that can affect production stability.
> Investigate and resolve the reproduced Debug Mode server-crash issue. Investigate the
> duplicate server.js problem and implement the safest solution only if it can be
> completed without changing frozen public contracts. Otherwise produce an ADR and stop.
> ... Do NOT include: refactoring, code cleanup, simplifications, package-lock updates,
> coverage improvements, Node version policy changes, dead-code removal, housekeeping.

Every artifact in this sprint was scoped against that instruction; the final whole-branch
review specifically checked for scope creep and found none (see
[REVIEW_REPORT.md](REVIEW_REPORT.md)).

## Audit — how the two findings were surfaced

Three read-only audit agents were dispatched **in parallel** via the native `Agent` tool
(not `delegate_*` — see [VALUE_REPORT.md](VALUE_REPORT.md) for why), covering: (1)
re-verification of 4 findings deferred from the prior sprint's `ponytail-audit` pass, (2)
a fresh correctness/security sweep of the two most recently landed subsystems, (3) test
coverage and CI/config hygiene. Full timing in
[PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md).

The fresh correctness/security sweep produced the sprint's headline finding:

> **[High, reproduced]** Debug Mode's terminal launcher never attaches an `"error"`
> listener to its spawned child process. An async spawn failure fires an unhandled
> `"error"` event, which Node treats as an uncaught exception — crashing the entire MCP
> server, every in-flight job included. The auditing agent reproduced this directly on
> this machine by forcing a spawn against a nonexistent binary.

and confirmed, via direct code reading (no lockfile/PID/port-bind check anywhere in
`src/cli/entry.js`'s startup path), the root-cause candidates for the concurrent-dispatch
job-tracking-loss limitation documented in the prior sprint.

## What was improved

1. **Debug Mode terminal-launcher crash fixed** — `src/services/debugTerminalLauncher.js`
   now attaches `child.once("error", () => {})` right after spawning the terminal
   process. A launch failure now surfaces as a normal job timeout instead of taking the
   whole server down. One new regression test (`tests/debugTerminalLauncher.test.js`)
   using a real `EventEmitter` to prove the crash mechanism is actually defused, not just
   assumed fixed.
2. **`ADR-0004: Server Instance Lifecycle`** written — a rigorous, independently-verified
   investigation into the duplicate-instance problem (see What defects were discovered
   below), recommending a specific future fix (`stdin`-close self-shutdown) while
   explicitly declining to implement it without first verifying real MCP-host
   process-lifecycle behavior — a live-session-disrupting experiment intentionally not
   run mid-sprint.
3. **`docs/releases/KNOWN_LIMITATIONS.md` gained its first-ever entry for the
   concurrent-dispatch/duplicate-instance limitation** — it existed only in the prior
   sprint's own `SPRINT_REPORT.md`/`DELEGATE_VALUE_REPORT.md` before this sprint, not in
   the project's canonical release-facing doc. Now cross-referenced to ADR-0004.
4. Version bumped 2.2.0 → **2.2.1** (patch: pure bug fix, no new capability), with a
   corresponding `CHANGELOG.md` entry.

## What defects were discovered

- **[High, reproduced, fixed]** The terminal-launcher crash above.
- **[Medium, confirmed via code reading, not reproduced live, documented not fixed]** No
  guard exists against multiple `server.js` instances; the MCP SDK's
  `StdioServerTransport` never detects its own `stdin` closing to self-shut-down. This is
  the confirmed root-cause candidate for the concurrent-dispatch job-tracking-loss
  problem from the prior sprint. Not reproduced live this sprint (doing so would mean
  disrupting the actual MCP connection this session runs on) — confidence comes from
  direct reading of both `src/cli/entry.js` and the vendored MCP SDK's `stdio.js`,
  independently re-verified by the task reviewer against the same source files.
- Three other Low-severity items surfaced by the audit (a hand-rolled recursive
  directory walker, a single-use wrapper module, a dead options field, a
  single-subclass error base class — all in pre-existing code, all previously flagged
  once already in the prior sprint's deferred `ponytail-audit` findings) were
  **deliberately not pursued this sprint** — they are cleanup/simplification, explicitly
  out of scope per the user's Critical Stability Sprint instruction. They remain
  candidates for a future Cleanup Sprint.

## What defects were fixed

Exactly one: the Debug Mode terminal-launcher crash. This was the sprint's only
functional code change. The duplicate-instance problem was investigated and documented
(ADR-0004), not fixed — a deliberate choice, not an oversight, per the reasoning in
ADR-0004 itself and this sprint's explicit "ADR and stop" instruction for anything not
safely implementable without guessing at unverified behavior.

## Approvals required / developer interruptions

Two, both genuine judgment calls, not busywork:
1. Sprint-scope selection (the user chose to redefine the scope entirely rather than
   pick one of the three offered options — a real design decision, not friction).
2. Permission to push local `main` (9 commits ahead of `origin/main` from the prior
   sprint) to origin before creating this sprint's worktree, so `EnterWorktree`'s
   `origin/main`-based default wouldn't silently drop the prior sprint's work. Per this
   session's own safety rules, pushing to a remote requires explicit confirmation each
   time regardless of prior approvals.

Zero interruptions during actual execution — both tasks, both task reviews, the
whole-branch review, and the ponytail passes ran without a checkpoint, per
`subagent-driven-development`'s continuous-execution principle.

## Failures and retries

None. Both tasks landed clean on their first implementer dispatch, no `BLOCKED` status,
no worktree mismatches (unlike the prior sprint's Task 2). One review-driven addition
(not a "fix" — Task 2's ADR gained one paragraph in its Alternatives section after the
reviewer flagged a missing middle-ground option) was applied directly by the controller
rather than a full fix-and-re-review cycle, since it was a one-paragraph doc addition
with no risk profile requiring a fresh subagent dispatch.

## Parallel execution

The three audit agents ran genuinely concurrently (dispatched via the native `Agent`
tool in one message, `run_in_background: true`), each read-only and touching disjoint
concerns — no conflicts. The two implementation tasks were dispatched **sequentially**,
correctly following `subagent-driven-development`'s "never dispatch multiple
implementation subagents in parallel" rule (Task 2 depended on nothing from Task 1, but
the rule is about avoiding conflicts on a shared workspace, not proving independence).

## Artifacts generated

**Commits** (6, `c1f3c72..9da6746`): plan doc → crash fix → ADR-0004 → ADR alternatives
addition → version bump + doc reconciliation → (this report and its siblings, next).

**Tests:** 178 → 179 (1 new regression test). 179/179 passing, verified fresh at every
checkpoint (after each task, after the whole-branch review, after doc reconciliation).

**Reviews:** 2 task-scoped reviews (Task 1 code: Approved, no findings; Task 2 ADR:
Approved after one Minor completeness addition), 1 whole-branch review (Ready to merge,
no findings), 1 `ponytail-review` pass (nothing to cut — the fix is already minimal), 1
scoped `ponytail-audit` pass (deliberately not repo-wide this time, since the sprint's
own rules exclude acting on cleanup findings — the full repo-wide sweep from the top of
this sprint remains the record for a future Cleanup Sprint).

**Docs updated:** `CHANGELOG.md` (new 2.2.1 entry), `docs/releases/KNOWN_LIMITATIONS.md`
(crash fix added to "Resolved," duplicate-instance limitation added for the first time),
`package.json` (2.2.0 → 2.2.1). `README.md` and `docs/ARCHITECTURE.md` deliberately left
untouched — the fix changes no documented behavior, confirmed rather than assumed.
