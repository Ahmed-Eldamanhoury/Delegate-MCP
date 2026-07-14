# Delegate Value Report — Should This Be Used Daily for Self-Harness / AI Trading Lab?

**Question this document answers:** Does Claude Delegate MCP provide enough practical
value to justify using it every day for developing Self-Harness and AI Trading Lab?

**Answer: Conditional yes** — real, verified value for one specific pattern (single
background CLI dispatch), a confirmed live reliability defect in another pattern
(concurrent dispatch), with a concrete workaround. Details and evidence below; every
claim traces to [SPRINT_REPORT.md](SPRINT_REPORT.md).

## Where Delegate MCP earned its keep

**Task 3 (Debug Mode `delegate_cancel`), dispatched via `delegate_submit`, opus/medium
effort:** ran unattended for 8 minutes 9.6 seconds (`489,643 ms`, verified via
`delegate_history`), produced a working, substantial cross-process cancellation design
(5 files, 3 new tests, full TDD RED/GREEN evidence), for `$2.63851` — billed against the
subscription this tool exists to use instead of separate API metering, which is its
stated core value proposition and held up in practice. I did not consume any of my own
turn budget waiting on it — I polled via `delegate_status` on a scheduled wakeup and
continued other sprint work in the meantime. **This is the pattern Delegate MCP is built
for, and it worked.**

**Task 1 (ConsumerRegistry), dispatched via `delegate_submit`:** its job-tracking
metadata was lost entirely (see Failure below) — but the underlying CLI execution still
completed correctly and the commit (`b1aeaad`) landed cleanly, was reviewed, and was
approved. The execution mechanism itself (the actual `claude` CLI invocation, independent
of the MCP wrapper's job-tracking layer) proved robust even when the tracking layer
failed. That distinction matters: the defect found this sprint is in observability of the
work, not the work itself.

## Where it broke, and why that matters for daily use

**Confirmed, reproduced defect:** dispatching multiple `mcp__claude-delegate__*` tool
calls in the same message silently breaks job tracking. `delegate_task` timed out
outright (`MCP error -32001`) with no server-side job ever visible; a simultaneous
`delegate_submit` call did create a job, but that job became untraceable within moments
and does not appear in `delegate_history` even now, after the sprint. Root-caused (not
guessed) to two independent `node.exe` processes both running `server.js`, each with
independent in-memory job state — confirmed by listing running processes with their full
command lines, not inferred from symptoms alone.

**Why this specifically threatens daily-use value:** Claude Code's own operating
instructions say to batch independent tool calls into one message whenever they don't
depend on each other — and `dispatching-parallel-agents`, one of the very skills this
sprint was asked to use, exists specifically to encourage that pattern for independent
work. Self-Harness and AI Trading Lab development, based on how this sprint's own
task-list was structured, leans on exactly this kind of multi-workstream parallel
dispatch. A tool that silently drops job state under the standard "call independent
tools together" pattern is a real sharp edge for that workflow style, not an edge case.

**The severity is bounded, not open-ended:** a single `delegate_submit`/`delegate_task`
call issued alone worked correctly every time this sprint (verified twice with
standalone haiku "PONG" calls, and once for real with Task 3's successful retry). The
defect is specifically about *concurrent* `delegate_*` calls, and the underlying
duplicate-process condition was gone by the time this report was written — consistent
with a stale process from an earlier restart rather than a guaranteed-to-recur
architecture flaw. It is real and it is currently unmitigated by the server itself
(nothing prevents two instances from running and splitting state again), but it does not
mean single-task dispatch is unreliable.

## Comparison: Delegate MCP vs. the native `Agent` tool (side-by-side this sprint)

Task 2 (MetricsCollector fix) was deliberately routed through the native `Agent` tool
instead of `delegate_*`, as a same-complexity-class comparison point.

| | `delegate_submit`/`delegate_task` (Tasks 1, 3) | native `Agent` tool (Task 2, and the Task 3 fix) |
|---|---|---|
| Completion signal | Fire-and-forget; requires manual polling (`delegate_status`) or a scheduled wakeup — no automatic notification | Automatic completion notification; harness-tracked |
| Reliability under concurrent dispatch | **Broken this sprint** — job state silently lost | Worked correctly, including self-catching and reporting its own environment mistake (the worktree-isolation slip) |
| Reliability under solo dispatch | Worked correctly both times verified | Worked correctly every time |
| Billing model | Against the existing Claude subscription (this tool's entire reason to exist) | Also against the subscription (it's the same underlying session) — no differentiation observed here |
| Report quality | Task 3's report was usable but needed a path workaround (`.git/` paths were sandbox-denied); Task 1's report never arrived at all | Consistently structured, always arrived, self-flagged its own concerns |
| Best fit | A single, long-running, judgment-heavy task you want off your own turn budget | Anything needing a synchronous, guaranteed report, or anything dispatched alongside other work in the same turn |

## Recommendation

**Use `delegate_submit` for standalone, long-running background CLI work — one dispatch
at a time.** Task 3 is the proof: real background execution, real cost transparency, zero
turn-budget cost to the orchestrating session, subscription-billed as designed.

**Do not batch multiple `delegate_*` MCP tool calls into the same message** until the
underlying job-tracking is made robust to multiple server instances (e.g., a single-
instance lock on server startup, or a persistent/shared job store instead of per-process
in-memory `JobManager` state — this sprint deliberately did not attempt that fix, since
it's a design change beyond a "verified low-severity defect" fix and belongs in its own
wave with its own design review). Until then, prefer the native `Agent` tool for any
work that needs to run alongside other dispatches in the same turn, and reserve
`delegate_submit` for the one-task-at-a-time background pattern it was proven to handle
well this sprint.

**For Self-Harness and AI Trading Lab specifically:** given both projects' development
style leans on parallel/multi-workstream dispatch (as this very sprint's own task list
did), the immediate practical rule is: **dispatch one `delegate_*` call, wait for it to
resolve (or schedule a wakeup and do something else), then dispatch the next** — never
combine `delegate_*` calls with each other in one message. Under that discipline,
Delegate MCP is worth using daily for any single task substantial enough to be worth
taking off the main session's turn budget (Task 3's ~8-minute opus run is a good
reference point for "substantial enough"). For anything that needs true parallel
dispatch in the same turn, use the native `Agent` tool until the concurrent-dispatch
defect is fixed in a future wave.

## GO / NO-GO

**GO**, with the one-at-a-time discipline above as a hard operating rule, not a
suggestion. This is not a blanket endorsement — it is a scoped one, backed by the actual
evidence gathered this sprint rather than the tool's stated design intent alone.
