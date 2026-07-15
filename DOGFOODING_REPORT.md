# Dogfooding Report — 2026-07-15

**Objective:** determine whether Delegate MCP provides enough real engineering value to
become the primary development environment for its own future development. Not a
feature sprint — this sprint's own output is evidence for that question, not a shipped
feature in itself (though a real defect did get fixed along the way).

Full metrics: `DOGFOODING_METRICS.md`. Final verdict and reasoning: `DOGFOODING_DECISION.md`.

## What we set out to do

Resume `docs/superpowers/plans/dogfooding-stdin-shutdown.md` — a plan and partial
implementation left uncommitted in a worktree from a prior session (Jul 14, 23:43),
targeting `FINAL_RELEASE_CERTIFICATION.md`'s own explicitly-recommended next dogfooding
sprint: implement ADR-0004's stdin-close self-shutdown fix.

## What we actually found and did

**Phase 1/2 (target selection) was mostly already decided.** The prior session's commit
message and `FINAL_RELEASE_CERTIFICATION.md` had already scored the candidates and picked
this target. Rather than re-deriving that from scratch, we verified the reasoning still
held (it did) and continued the in-flight work — confirmed with the user before proceeding,
since silently continuing someone else's uncommitted work without checking is exactly the
kind of unilateral call that deserves a pause.

**A real, blocking bug was found before any dogfooding-proper work could start.** Running
the existing (uncommitted) `tests/entry.test.js` hung the whole `npm test` suite
indefinitely. Root cause: `entry.js`'s `main().catch(...)` executed unconditionally at
*import* time, so merely importing `registerShutdownHandlers` for unit testing also
started a real, `stdio`-connected MCP server that never exits. The standard
`import.meta.url`-based "am I the entrypoint" idiom does not work for this repo's
structure — `server.js` is the actual documented entrypoint and reaches `entry.js` via a
re-export import, so `process.argv[1]` is always `server.js`'s path, never `entry.js`'s
own; that guard would have silently broken production startup instead of fixing the test
hang. Fixed by making `entry.js` a pure module (no top-level `main()` call) and moving the
explicit `main()` invocation into `server.js`. TDD throughout, verified with a genuine
red-green cycle (bug reintroduced, confirmed the regression test fails/hangs; fix
restored, confirmed 185/185). Full detail: `CHANGELOG.md`'s 2.2.2 entry.

**The stdin-close self-shutdown feature itself landed as designed** in ADR-0004 and the
plan: `registerShutdownHandlers()` now routes `SIGINT`/`SIGTERM`/`stdin`-end through one
shared shutdown path, tested against injected fakes. What remains explicitly unverified,
per the plan's own stated scope and ADR-0004's original Decision: whether this actually
fires correctly against a real Claude Desktop disconnect. That verification requires
deliberately disrupting a live session and was out of scope for this sprint, same as it
was for the sprint that wrote the ADR.

**Auditing Delegate MCP itself, per this sprint's Phase 5 mandate:**

- Ran a whole-repo `ponytail-audit` via `delegate_submit` (not the native `Agent` tool) —
  the first genuinely independent, substantial, read-only task this sprint that fit
  Delegate's stated strength. It completed autonomously in 138.5s, cost $1.0394 (a concrete,
  itemized figure the native `Agent` tool never surfaces), and returned 5 accurate findings
  (2 new, 3 correctly reconfirmed as still-accurate pre-existing items from
  `FINAL_HEALTH_REPORT.md`). While it ran, the controller did other useful work
  (ledger updates, a documentation commit) rather than sitting idle — a genuine efficiency
  win of submit-and-poll over a blocking call.
- **A real, if narrow, friction was found and root-caused, not glossed over.** The job's
  structured result included a `permission_denials` array — two `Bash` calls blocked by the
  declared `allowed_tools` restriction, but the worker's `PowerShell` fallback call was
  **not** blocked and ran successfully. Traced to `src/services/claudeCliService.js:44`:
  this repo's own code correctly forwards `--allowedTools` verbatim to the underlying
  `claude` CLI — there is no bug in claude-delegate-mcp's own source. The gap lives in the
  external `claude` CLI's own permission-matching for the `PowerShell` tool name on
  Windows, which this repository does not control and cannot fix by changing its own code.
  Recorded here as a real limitation: **do not treat `allowed_tools` as a hard security
  boundary on Windows** until that external behavior is understood better; combine it with
  `cwd` sandboxing and treat delegated workers as read-only/advisory rather than granting
  them anything destructive.
- The one native `Agent` dispatch this sprint (Task 0's implementer, haiku) completed a
  small, fully-specified, mechanical TDD task correctly and cheaply, with zero clarifying
  questions and zero review-loop iterations needed.

**What this sprint did *not* test, honestly:** every prior sprint's own records
(`SPRINT_REPORT.md`'s v2.2.0 and v2.2.1 sections) note that `delegate_task`/`delegate_submit`
had either not been used at all, or used only for read-only research — never for an actual
code-writing implementer role. This sprint extends that same pattern: the one
`delegate_submit` call was a read-only audit; the one code-writing task went to the native
`Agent` tool via `subagent-driven-development`'s own default template, not because
`delegate_submit` was tried and found wanting for that role. **Across four sprints now,
there is still zero data on whether Delegate MCP can reliably serve as the actual
implementer for a code change to itself.** That gap, not a defect, is the single biggest
open question standing between this project and treating Delegate MCP as a genuine
default development environment.

## Process notes (Phase 0 workflow)

Skills used, in the order they were actually invoked: `using-superpowers` (implicit,
session-standing) → `brainstorming` (target-selection confirmation) → `writing-plans`
(amended the existing plan with a prerequisite Task 0) → `subagent-driven-development`
(dispatched the Task 0 implementer) → `verification-before-completion` (fresh red-green
re-verification, independent of the implementer's own report) → `ponytail-review` (diff-level)
→ `ponytail-audit` (whole-repo, delegated) → `finishing-a-development-branch` (merge, tag,
push, all with explicit user sign-off given each is a shared/hard-to-reverse action).

**One deliberate, user-directed deviation from the standard `subagent-driven-development`
loop:** the per-task reviewer subagent for Task 0 was never dispatched — the user
explicitly redirected mid-sprint to stop relying on an async reviewer dispatch/wait cycle
and have the controller perform independent verification directly instead. This is
recorded honestly rather than fabricated as a timeout, since no reviewer was ever actually
launched to time out. The substituted verification (fresh full-suite run, manual
red-green re-verification with the bug deliberately reintroduced and confirmed to fail
again, `ponytail-review` on the diff) was arguably more rigorous than a single reviewer
pass would have been, but it is a real methodology deviation from the skill as written,
not merely "the reviewer was slow."
