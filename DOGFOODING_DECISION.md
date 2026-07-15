# Dogfooding Decision — 2026-07-15

Answers below are scoped to what this sprint (and the three before it) actually tested.
Where the evidence is thin, that is stated plainly rather than rounded up or down.

## Did Delegate MCP genuinely improve developer productivity?

**For one class of task, yes, measurably.** The whole-repo audit ran unattended for
138.5s while the controller did other useful work (a documentation commit, a ledger
update) — real wall-clock recovered, not just "it ran in the background" in the abstract.
It returned accurate, evidence-backed findings (verified 3 of 5 against the actual
codebase; all checked out) for a fixed, itemized cost ($1.0394).

**For the other class of task — actually writing the code change — there is still no
data.** This sprint's one code-writing task went to the native `Agent` tool, not
`delegate_task`/`delegate_submit`. That was a default (subagent-driven-development's own
template names `Agent`), not a tested-and-rejected choice for Delegate.

## Where did it save time?

The audit: async submit-and-poll meant zero perceived wait for a real ~2.3-minute job.
The cost figure came back structured and exact, which the `Agent` tool's report never
provides — no reconciliation, no estimating.

## Where did it slow development?

Nowhere this sprint — but the sample is one job. The prior sprint (`SPRINT_REPORT.md`,
v2.2.0) recorded a scoped `GO` with an explicit caveat: avoid batching `delegate_*` calls,
since concurrent dispatch was the exact defect ADR-0004 investigates. That operating
discipline was followed here (one call at a time) and cost nothing extra, since this
sprint never had a genuine case for two `delegate_*` calls in flight simultaneously.

## Where did it create unnecessary approvals?

None from Delegate itself. The four `AskUserQuestion` checkpoints this sprint
(continue-in-flight-work, bug-fix design, finish-branch choice, tag-and-push) were the
controller's own git-safety/scope-confirmation gates — orthogonal to whether Delegate MCP
was in use, and would have been asked regardless of which tool did the work.

## Where should Delegate NOT be used?

- Not (yet) for the implementer role in `subagent-driven-development` — untested across
  four sprints now, not "found unsuitable." Treat this as an open question, not a ruling.
- Not for anything requiring a hard tool-permission boundary on Windows until the
  `allowed_tools`/`PowerShell` gap (see `DOGFOODING_REPORT.md`) is understood — that gap
  lives in the external `claude` CLI, not this repo, so it cannot be closed by changing
  claude-delegate-mcp's own code, only worked around operationally (read-only tasks, no
  destructive `allowed_tools` grants, `trust_all` never used casually).
- Not for anything requiring more than one concurrent `delegate_*` call — the
  known job-tracking-loss limitation (ADR-0004) is mechanism-fixed but
  live-host-unverified; the "one call at a time" mitigation stays in force.

## Which features proved valuable?

- `delegate_submit` + `delegate_status` (async submit-and-poll): the one concrete
  positive data point this sprint.
- Structured job results (`permission_denials`, exact `total_cost_usd`, token/turn
  counts): surfaced a real friction (the tool-permission gap) that a plain-text summary
  would likely have hidden. This is itself a point in Delegate's favor — the tooling
  made its own limitation visible.
- The `workspace/jobs/<uuid>/` artifact trail: directly inspectable after the fact
  (`context.json`, `result.json`, logs), unlike the native `Agent` tool's transcript file
  (explicitly not meant to be read directly).

## Which features were ignored?

`delegate_task` (blocking variant) — not used; `delegate_submit` fit every case this
sprint had. `delegate_cancel`/`delegate_history` — not exercised (no job needed
cancelling; only one job existed to list). `trust_all` — correctly never used (no task
this sprint needed write access badly enough to justify bypassing permission checks).

## Which features should be removed?

None identified. Nothing in this sprint's usage suggested dead or over-built surface —
all 6 tools remain in use across the project's dogfooding history (this sprint used
`delegate_submit`/`delegate_status`; prior sprints exercised `delegate_task`, `delegate_history`).

## Which features should become mandatory?

Reading the structured job result (not just the summary text) before treating a
`delegate_*` job as "clean" — this sprint's tool-permission finding would have been
missed entirely from the summary alone. Worth writing into this project's own operating
discipline (alongside "one call at a time") the same way that discipline itself
originated from a prior sprint's finding.

## Is Delegate MCP now mature enough to become the default development environment for:

- **Delegate MCP itself:** partially. Proven for independent research/audit/review-style
  tasks run alongside primary implementation work. Not yet proven — not disproven,
  *untested* — for the implementer role itself.
- **Self-Harness:** no evidence gathered this sprint; out of scope (this sprint's target
  repo was claude-delegate-mcp itself).
- **AI Trading Lab:** no evidence gathered this sprint; out of scope for the same reason.

## Recommended next step

The single highest-value next dogfooding sprint: a **direct head-to-head trial** —
dispatch one well-scoped, TDD-able implementation task via `delegate_submit` instead of
the native `Agent` tool, using the exact same `subagent-driven-development` brief/report
contract this sprint used for Task 0, and compare quality, cost, and wall-clock directly.
Four sprints in, this is the one experiment that has never actually been run.

## Final Verdict

**READY FOR DAILY DOGFOODING**

Scoped explicitly: for independent, read-only, background research and audit work
alongside primary development (this sprint's own proven use case, and the pattern three
prior sprints already established for `delegate_task`). **Not yet extended to the
implementer role** — that remains the project's single largest untested surface, not a
failed one, and should be the explicit target of the next sprint.
