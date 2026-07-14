# Performance Report — Critical Stability Sprint

Every number below comes directly from the actual agent-dispatch results returned this
sprint (each Agent-tool call reports its own `subagent_tokens`, `tool_uses`, and
`duration_ms`) — no estimation, except where explicitly marked "sequential-equivalent"
(a computed hypothetical, not a measurement).

## Phase 1 — Audit (3 agents, dispatched in parallel)

| Agent | Focus | Tokens | Tool uses | Duration |
|---|---|---|---|---|
| A | Re-verify 4 deferred `ponytail-audit` findings | 82,395 | 16 | 87,274 ms (1.5 min) |
| B | Fresh correctness/security sweep | 111,580 | 32 | 674,616 ms (11.2 min) |
| C | Test coverage + CI/config hygiene | 108,609 | 45 | 684,663 ms (11.4 min) |
| **Total (tokens)** | | **302,584** | **93** | — |
| **Sequential-equivalent wall-clock** | | | | **1,446,553 ms (24.1 min)** |
| **Actual parallel wall-clock** | | | | **684,663 ms (11.4 min)** |
| **Wall-clock saved by parallelizing** | | | | **761,890 ms (12.7 min), ≈53%** |

Token cost of parallelizing is unchanged from sequential — the same three agents ran the
same work either way; only wall-clock improved. This is the direct, measured payoff of
`dispatching-parallel-agents` for this sprint's audit phase.

## Phase 2 — Implementation and review (5 agents, dispatched sequentially)

| Agent | Role | Tokens | Tool uses | Duration |
|---|---|---|---|---|
| D | Task 1 implementer (crash fix) | 72,351 | 13 | 113,167 ms (1.9 min) |
| E | Task 1 reviewer | 60,471 | 4 | 42,760 ms (0.7 min) |
| F | Task 2 implementer (ADR-0004) | 87,672 | 22 | 420,649 ms (7.0 min) |
| G | Task 2 reviewer | 75,862 | 6 | 75,384 ms (1.3 min) |
| H | Whole-branch reviewer | 67,559 | 4 | 74,145 ms (1.2 min) |
| **Total** | | **363,915** | **49** | **726,105 ms (12.1 min)** |

These were correctly sequential per `subagent-driven-development`'s "never dispatch
multiple implementation subagents in parallel" rule — no parallelization to measure here
by design.

## Notable, honestly-reported anomaly

**Task 2 (writing a ~100-line ADR) took 3.7x longer in wall-clock than Task 1 (a real
code fix, test, and full-suite run)** — 420,649 ms vs. 113,167 ms — despite the ADR
brief already containing the fully-investigated content to transcribe. The ADR
implementer's 22 tool uses (vs. Task 1's 13) suggest most of the extra time went to
independently re-reading the source files (`src/cli/entry.js`, the vendored MCP SDK's
`stdio.js`, and `ADR-0003` for format matching) to verify the brief's claims rather than
transcribing them blindly — which is exactly the behavior the brief asked for ("if you
find any claim in the brief is actually inaccurate, correct it... do not silently repeat
a wrong claim"). The extra time bought verification, not waste, but it's a real,
worth-noting data point: **a "just write it up" documentation task, done rigorously, is
not necessarily cheaper than a small code change with tests.**

## Sprint-wide totals

- **Total agent-dispatch tokens:** 666,499 across 8 dispatches.
- **Total agent-dispatch wall-clock:** 684,663 (parallel audit) + 726,105 (sequential
  impl/review) = **1,410,768 ms ≈ 23.5 minutes** of actual agent-running time.
- **If the audit phase had also been sequential:** 1,446,553 + 726,105 = 2,172,658 ms
  ≈ 36.2 minutes — i.e., parallelizing the audit phase alone saved roughly a third of
  this sprint's total agent wall-clock.
- **`delegate_*` MCP tool cost:** $0.00 — not used this sprint (see
  [VALUE_REPORT.md](VALUE_REPORT.md) for why; all 8 dispatches above were native `Agent`
  tool calls, which don't report a USD cost the way `delegate_history` does for
  `delegate_submit`/`delegate_task`).

## Test suite performance

179 tests run in 5,831–6,057 ms across the ~6 fresh runs performed this sprint (baseline,
post-Task-1, post-Task-2, post-doc-reconciliation, final pre-merge) — consistently under
6.1 seconds, no measurable regression from the one new test added.
