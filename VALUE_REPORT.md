# Value Report — Delegate MCP Evaluation, Dogfooding Sprint (2026-07-15)

**Question this document answers (per the sprint's stated objectives):** did Delegate MCP
improve developer productivity during this sprint?

**Honest headline answer: yes, for the one task shaped like Delegate's proven strength —
but the sprint's actual code-writing task again went to the native `Agent` tool, so the
central "can it be the implementer" question is still untested.** This is the fourth
sprint in a row where that's true. This document explains what changed and what didn't.

## Where `delegate_submit` was used, and why it worked

The whole-repo `ponytail-audit` (see [DOGFOODING_REPORT.md](DOGFOODING_REPORT.md) and
[DOGFOODING_METRICS.md](DOGFOODING_METRICS.md) for full detail) was independent,
substantial, and read-only — exactly the shape the prior sprint's `DELEGATE_VALUE_REPORT.md`
scoped as `delegate_submit`'s proven use case. It ran unattended for 138.5s while the
controller did other useful sprint work (a documentation commit, ledger bookkeeping) —
real time recovered, not hypothetical. It returned a fixed, itemized cost ($1.0394 USD)
the native `Agent` tool never surfaces. And it surfaced a real, independently-verifiable
finding — a `Bash`-vs-`PowerShell` tool-permission inconsistency — that came from
inspecting the job's *structured* result (`permission_denials`), not its prose summary.
That last point is itself a value signal: Delegate's machine-readable job result exposed
something a plain-text agent report likely would not have.

## Where it wasn't used, and why that's not (necessarily) a miss

Task 0 — the actual code fix (extracting `entry.js`'s side effect, writing the
regression test, verifying red-green) — went to the native `Agent` tool via
`subagent-driven-development`'s own default implementer template. This was a default, not
a comparison: the brief already contained complete code (the plan specified the exact
test and the exact fix), making it a "cheap model, mechanical transcription" task per
that skill's own model-selection guidance — and that guidance names `Agent`, not
`delegate_*`, as the default dispatch mechanism.

**This means the sprint gathered zero new evidence on whether `delegate_task`/
`delegate_submit` can reliably serve as the implementer**, one way or the other. Three
prior sprints share this same gap (v2.2.0: `delegate_*` used for research only; v2.2.1:
"`delegate_task`/`delegate_submit` were not used at all this sprint"). Four sprints in,
this remains the single most consequential untested question, not a settled "no."

## What this means for the standing evaluation

The prior sprint's `VALUE_REPORT.md` (preserved in git history at commit `c1f3c72`)
concluded the operative guidance was: use `delegate_submit` for standalone, substantial,
background work one dispatch at a time; use the native `Agent` tool for everything else.
This sprint **confirms** that guidance with a fresh, positive data point (the audit) and
**does not extend it** to the implementer role. The recommendation in
[DOGFOODING_DECISION.md](DOGFOODING_DECISION.md) — a direct head-to-head implementer
trial as the next sprint's explicit focus — exists specifically to close this gap rather
than let a fifth sprint repeat the same untested pattern.

## New friction this sprint, and its actual scope

The `allowed_tools` restriction blocked the audit job's `Bash` calls but not its
`PowerShell` fallback. Traced to `src/services/claudeCliService.js:44`, which correctly
forwards `--allowedTools` to the external `claude` CLI — this repository's own code is
not at fault, and the gap cannot be closed by changing code in this repo. Recorded as an
operational caveat (don't rely on `allowed_tools` as a hard security boundary on Windows
yet), not scored against Delegate MCP's own value, since the mechanism this project
actually owns did exactly what it was supposed to do.
