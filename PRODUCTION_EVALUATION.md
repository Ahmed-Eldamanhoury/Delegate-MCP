# Production Evaluation — claude-delegate-mcp (post-sprint, v2.2.0)

Scope: is the **codebase itself** — not the meta-question of whether to use Delegate MCP
for daily development, which is [DELEGATE_VALUE_REPORT.md](DELEGATE_VALUE_REPORT.md)'s
job — production-ready after this sprint's changes. Evidence-only; every claim below
traces to a command run or a file inspected during this sprint.

## What changed this sprint

Three previously-documented, verified-low-severity defects, all closed:

1. `ConsumerRegistry` had no auto-expiry primitive (`docs/releases/KNOWN_LIMITATIONS.md`,
   pre-sprint item 1). `pruneStale(maxAgeMs)` now exists, matches `unregister()`'s
   `totalRegistered`-never-decrements semantics, has 3 regression tests. **Not wired to
   any scheduled sweep** — the primitive exists, nothing calls it in production yet. This
   is an accurate, not aspirational, characterization: verified by reading
   `consumerRegistry.js` and grepping for `pruneStale(` call sites (none outside tests).
2. `MetricsCollector`'s artifact-count walk miscounted non-job directories
   (pre-sprint item 2, cosmetic accuracy gap, never a security issue). Now reuses
   `isValidJobId()`. 1 regression test, plus a necessary test-fixture rename (`"job-1"` →
   a real UUID) that the reviewer independently verified was required, not incidental.
3. `delegate_cancel` could not forcibly stop a running Debug Mode job (documented
   limitation since v2.1.0). Now routes cancellation through a `cancel.request` sentinel
   file that the detached runner polls and converts into an abort of its own
   `AbortController`, which reuses production's existing
   `spawnAndCollect`/`shouldCleanupProcessTree`/`killWindowsProcessTree` tree-kill path —
   confirmed by reading `claudeCliService.js`'s `child.once("error", …)` handler directly,
   not by trusting the implementer's description of it.

A fourth, review-caught defect was found and fixed **within** the Task 3 work before it
reached the final review: an unbounded `AbortSignal` listener leak in the poll loop
(every non-aborted iteration left a dangling listener attached). Fixed, with a regression
test that asserts on real `node:events`' `getEventListeners()` output, not a mock.

## Test suite health

- 171/171 passing at the branch point → 178/178 passing at `HEAD` (`3c3e1ba`), verified
  fresh (not reused from a stale run) at four separate points in the sprint: after each
  task landed, after the fix cycle, after doc reconciliation, and after the
  `ponytail-review` simplification.
- All 7 new/changed tests exercise real behavior: real temp directories and real timing
  for `consumerRegistry`/`metricsCollector`, a real filesystem sentinel file and a real
  `AbortController` for `debugInvoke`, an injected-but-behaviorally-real kill path (no
  mocked assertions-about-mocks) for `debugRunner`.

## Review coverage

Every commit landed through the same gate: task-scoped spec+quality review → (fix cycle
if findings) → re-review → approved. The one Important finding (the listener leak) was
caught by review, not shipped and found later — the review process did its job. The
whole-branch final review found the design's central claim (Task 3's cancellation reuses
production's kill path rather than duplicating it) to be independently verifiable, not
just self-reported, and traced it to source before agreeing.

## Compatibility / frozen-contract check

Verified directly (not assumed) by diffing `9f2e9df..HEAD` against `src/mcp/`,
`src/models/executionContext.js`, the Job lifecycle enum, and `runtimeEventBus.js`: **zero
lines touched** in any of them. No MCP tool schema changed. No new production
dependencies (`package.json`'s only diff is the version field). `package-lock.json`'s
root version field is `1.0.0`, unsynced with `package.json`'s `2.2.0` — this predates the
sprint (already true before any of this sprint's commits) and is out of this sprint's
scope; noting it here so it isn't mistaken for something this sprint introduced.

## Ponytail passes

- **Review** (diff-scoped): found and fixed one real simplification —
  `debugInvoke.js`'s hand-rolled abort-aware sleep (the same code that needed the
  listener-leak fix above) replaced with `node:timers/promises`' `setTimeout(ms, val,
  {signal})`, which manages its own listener lifecycle. This doesn't just shorten the
  code, it removes the entire bug class the fix commit had patched around. Net -13 lines
  in the review pass's own accounting; the actual diff landed at -10/+20 → -20/+10
  restructure once applied.
- **Audit** (repo-wide): 4 findings, all in pre-existing code this sprint did not
  otherwise touch (a hand-rolled recursive directory walker in `metricsCollector.js` that
  predates this sprint, a single-call-site wrapper in `src/server/health.js`, a dead
  `maxBuffer` field in `claudeCliService.js`'s `buildExecOptions`, a single-subclass error
  base class in `src/utils/errors.js`). **None applied this sprint** — the plan's Global
  Constraints say "keep architecture frozen unless a verified blocker requires change,"
  none of these four are blockers, and the `ponytail-audit` skill is itself defined as
  report-only. Carried forward as recommendations for a future wave rather than expanding
  this merge's blast radius onto previously-certified code.
- **Debt**: zero `ponytail:` markers exist anywhere in the repo. Clean ledger.

## Known limitations after this sprint (unchanged or newly surfaced)

- `pruneStale()` exists but nothing schedules it — no memory-growth risk today (same as
  before: `ObservabilityService` still has no external consumer registering with it), but
  it is not yet a complete fix for "auto-expiry," only the primitive for one.
- The concurrent-MCP-dispatch job-tracking failure (see `SPRINT_REPORT.md`) is an
  operational hazard in the *environment* (two `server.js` processes can run at once and
  silently split job state) rather than a code defect — no fix was possible or attempted
  within this sprint's scope, since the job-tracking code itself was verified correct
  under single-instance operation.
- The 4 ponytail-audit findings remain open, all low-severity, all in code this sprint
  did not introduce.

## Assessment

**Production-ready: Yes**, for the scope this sprint touched. All three original
known-limitation items are closed with tests and independent review; no regression
introduced (178/178, frozen contracts untouched, zero new dependencies); the one real
defect introduced mid-sprint (the listener leak) was caught by the review process itself
before merge, which is the review process working as intended rather than a mark against
production-readiness.

**Not full closure of the "auto-expiry" theme** — the `pruneStale()` primitive is real
and tested but inert until a future wave wires a scheduled sweep to it, exactly as
documented in `docs/releases/KNOWN_LIMITATIONS.md`'s "Resolved since v1.0.0" section.
