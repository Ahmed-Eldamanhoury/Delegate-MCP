# Value Report — Delegate MCP Evaluation, Critical Stability Sprint

**Question this document answers (per the sprint's stated objectives):** Did Delegate MCP
improve developer productivity during this sprint?

**Honest headline answer: Delegate MCP's own tools (`delegate_task`/`delegate_submit`)
were not used at all this sprint — and that absence is itself the finding, not an
oversight.** This document explains why, and what it does and doesn't tell us about
Delegate MCP's value.

## Why `delegate_*` wasn't exercised this sprint

The sprint's own explicit rule was: **"Use `delegate_submit` for long-running tasks. Avoid
concurrent `delegate_*` calls until the known multi-instance tracking limitation is
resolved."** Neither task this sprint was long-running:

- Task 1 (the crash fix) was a complete-spec, transcription-and-verification job: the
  plan already contained the exact test code and the exact fix code. It took the native
  `Agent` tool 113,167 ms (≈1.9 minutes) end to end, including running the full 179-test
  suite.
- Task 2 (the ADR) took longer in wall-clock terms (420,649 ms, ≈7 minutes — see
  [PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md)) but is not the kind of long-running,
  fire-and-forget background work `delegate_submit` is designed for — it needed to read
  source files back and forth with the controller's own investigation, not run
  unattended.

Given the sprint's own rule, routing both through the native `Agent` tool was the
*correct* choice, not a missed opportunity to dogfood. This sprint simply didn't generate
a task shaped like the one `delegate_submit` demonstrated real value on last sprint
(Task 3 of the prior sprint: an 8-minute, `$2.64`, fully unattended opus run).

## What this means for the standing evaluation

The prior sprint's [DELEGATE_VALUE_REPORT.md] conclusions (preserved in git history at
commit `c1f3c72`) are **neither confirmed nor contradicted** by this sprint — there is no
new evidence either way, because the pattern that report evaluated (single, long-running,
background `delegate_submit` dispatch) simply didn't arise. The prior report's scoped
recommendation stands as the operative guidance: use `delegate_submit` for standalone,
substantial background work, one dispatch at a time; use the native `Agent` tool for
everything else, especially anything dispatched alongside other work in the same turn.

This sprint does add one new, relevant data point to that standing evaluation: the
**duplicate-server-instance investigation (ADR-0004)** confirms, with actual code-level
evidence rather than just an observed symptom, *why* the prior sprint's concurrent-
dispatch job-tracking failure happened — no startup guard, no `stdin`-close self-
shutdown. That strengthens rather than changes the prior sprint's operating
recommendation ("avoid batching `delegate_*` calls"): it is now understood as a real,
identified architectural gap with a specific proposed fix, not just an intermittent,
unexplained flake.

## Did the native `Agent` tool improve productivity this sprint?

Yes, concretely: the three audit agents (deferred-findings re-verification, fresh
correctness/security sweep, coverage/CI hygiene) were dispatched **in parallel** and
together surfaced the sprint's one actionable High-severity finding in 684,663 ms
(≈11.4 minutes) of wall-clock time — versus an estimated 1,446,553 ms (≈24.1 minutes) had
they run sequentially, a genuine ~53% wall-clock reduction for the audit phase (see
[PERFORMANCE_REPORT.md](PERFORMANCE_REPORT.md) for the full breakdown). This is squarely
what `dispatching-parallel-agents` is for, and it worked without any of the coordination
problems the prior sprint hit with concurrent `delegate_*` calls — because these were
native `Agent` tool dispatches, not `delegate_*` MCP calls, and don't share the
in-memory, per-server-process `JobManager` state that caused that earlier failure.

## Recommendation

No change to the prior sprint's scoped GO recommendation. This sprint reinforces a
narrower, more specific point: **for short, complete-spec, or investigation-heavy tasks —
and especially for anything dispatched in parallel with other work — the native `Agent`
tool remains the right default.** `delegate_submit` should be reached for specifically
when a task is long enough and self-contained enough to be worth taking off the session's
own turn budget, as demonstrated concretely by the prior sprint's Task 3, not by default.
