# Dogfooding Metrics — 2026-07-15 Sprint

Raw counts from this sprint only. No estimates presented as measurements — every number
below is either a tool-reported value (`delegate_status`, `gh run list`, `npm test`
output) or a direct count from this session's own tool calls.

## Delegate MCP usage

| Metric | Count |
|---|---|
| `delegate_task` calls | 0 |
| `delegate_submit` calls | 1 |
| `delegate_status` polls | 4 |
| Jobs run in parallel (batched in one message) | 0 — this project's own established discipline (one `delegate_*` call at a time) was followed throughout |
| Jobs run serially | 1 (the only one submitted) |
| Native `Agent` tool dispatches | 1 (Task 0 implementer) |
| Streaming sessions exercised | 1, indirectly — `delegate_submit` uses `--output-format stream-json` internally (ADR-0002); the controller consumed the polled end-result via `delegate_status`, not raw stream events directly |

## The one delegate_submit job (audit)

| Field | Value |
|---|---|
| Job ID | `f57aeebf-a0e1-4538-bf31-dbb0636de232` |
| Task | Whole-repo ponytail-audit (`src/`, `tests/`) |
| Model / effort | sonnet / medium |
| Wall-clock | 138.5s (`runtimeMs` at completion) |
| API duration | 125.5s |
| Turns | 37 |
| Cost | **$1.0394 USD** (`total_cost_usd`, exact) |
| Tokens | 46 in / 8,215 out / 66,541 cache-creation / 1,722,500 cache-read |
| Tool permission denials | 2 (`Bash` calls blocked by `allowed_tools` restriction) |
| Findings returned | 5 (2 newly surfaced, 3 reconfirmed pre-existing) |
| Artifacts on disk | `workspace/jobs/f57aeebf.../{context.json,metadata.json,result.json,stdout.log,stderr.log,artifacts/}` — confirmed present after completion |

## The one native Agent dispatch (Task 0 implementer)

| Field | Value |
|---|---|
| Model | haiku |
| Wall-clock | 239.2s |
| Tool uses | 19 |
| Subagent tokens | 58,254 |
| Cost surfaced inline | **None** — the Agent tool reports token counts, not a dollar figure |
| Outcome | DONE, 1 commit, 6/6 focused tests + 185/185 full suite passing |

## Developer (controller) intervention points

| Type | Count | What |
|---|---|---|
| `AskUserQuestion` checkpoints | 4 | Continue in-flight work vs. restart; approve bug-fix design; finish-branch choice (merge/PR/keep/discard); tag-and-push choice |
| Mid-sprint user redirects | 1 | "Stop waiting for the reviewer... continue with independent verification" |
| Implementer questions requiring an answer | 0 | The Task 0 implementer never asked a clarifying question |
| Review loops (fix → re-review) | 0 | No Critical/Important findings surfaced that required a fix-and-re-review cycle |

## Test / CI evidence

| Metric | Before this sprint's fix | After |
|---|---|---|
| `npm test` locally | Hangs indefinitely (bug) | 185/185, ~6s |
| `npm test` in GitHub Actions (4-matrix) | N/A (not yet pushed) | 4/4 green (ubuntu/windows × 20.x/22.x) |
| CodeQL | Fails on known admin gap (code scanning disabled) | Same known gap, not a regression (see DOGFOODING_REPORT.md) |
| MCP Inspector `tools/list` | N/A | 6/6 tools, unchanged, verified twice independently |

## Bugs found this sprint

| # | Bug | Found by | Severity |
|---|---|---|---|
| 1 | `entry.js` starts a live server as an import-time side effect, hanging `npm test` | Controller running `npm test` directly (not via Delegate or Agent) | High — blocked all verification of the sprint's actual target |
| 2 | `allowed_tools="Read Grep Glob WebSearch WebFetch"` blocked the delegated worker's `Bash` calls but not its `PowerShell` fallback | Inspecting the `delegate_submit` job's structured `permission_denials` field | Medium, external — root-caused to the underlying `claude` CLI's own permission engine, not this repo's code (see DOGFOODING_REPORT.md) |

Bugs fixed: 1 (bug #1, via TDD). Bug #2 is documented, not fixed (out of this repo's scope).
False positives among reviewed findings: 0.
