# Push Report — Persistent Event History Sprint

## Pushed commits

`195bce3..0f1228c` on `main` (fast-forward push, no merge commit) — same 9 commits listed in
`MERGE_REPORT.md`. Final commit hash: `0f1228cbb8424f5decc9209c1a6ed59f5b392c5d`, pushed to
`origin/main`. Annotated tag `v2.4.0` created on this commit and pushed to `origin/v2.4.0`.

## Test results

278/278 passing, re-run fresh on `main` immediately after the push:

```
tests 278
pass 278
fail 0
cancelled 0
skipped 0
todo 0
```

## CI results (GitHub Actions, triggered by this push)

| Workflow | Result | Detail |
|---|---|---|
| **CI** (`test`, 4-way matrix: ubuntu/windows × node 20/22.x) | ✅ **Success** | All 4 jobs green in 21-66s each: checkout, setup-node, `npm ci`, `npm test`, post-steps. Run [29511693449](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/actions/runs/29511693449). |
| **CodeQL** (`analyze`) | ❌ **Failure** | Pre-existing and environmental, not caused by this sprint — see below. Run [29511691939](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/actions/runs/29511691939). |

**CodeQL failure is the same pre-existing, environmental issue documented in the prior sprint's
`PUSH_REPORT.md`.** Fails identically at the `analyze` step: *"Code scanning is not enabled for
this repository. Please enable code scanning in the repository settings."* This requires a
repository-settings change (GitHub Advanced Security / code scanning enablement), not a code
fix — unrelated to this sprint, present since before the Persistent Job Store Sprint. Not
acted on here, since changing repository security settings wasn't requested.

## Repository status

- `main` is up to date with `origin/main` — `git rev-parse main origin/main` both resolve to
  `0f1228cbb8424f5decc9209c1a6ed59f5b392c5d`, identical.
- Feature branch `worktree-persistent-event-history` merged and deleted; its worktree
  (`.claude/worktrees/persistent-event-history`) removed and pruned.
- `package.json` version: `2.4.0`.
- Annotated tag `v2.4.0` created and pushed, matching this repo's own precedent of tagging every
  version bump (`v2.0.0`, `v2.2.1`, `v2.2.2`, `v2.3.0` all exist). Verified on the remote:
  `git ls-remote --tags origin` shows `refs/tags/v2.4.0^{}` dereferencing to
  `0f1228cbb8424f5decc9209c1a6ed59f5b392c5d` — the exact commit `main` points to.
- MCP tool surface unchanged: same 6 tools as every prior certification pass, zero schema drift
  (independently verified via Inspector against the merged `main`, see `MERGE_REPORT.md`).
- No GitHub Release created (not requested for this sprint).

## Remaining known limitations

- **CodeQL is not currently running for this repository** (see above) — unrelated to this
  sprint, unresolved since before it began.
- **`EventHistoryStore` is opt-in only** (`CLAUDE_DELEGATE_EVENT_HISTORY=file`); default replay
  behavior remains the pre-existing two-tier fallback (`runtime` → `workspace`). No backfill for
  history predating the feature being enabled — accurate description of what "not yet enabled"
  already meant, not a gap.
- **`OutputChunk` events are deliberately excluded** from the durable log (already durably owned
  by `stdout.log`/`stderr.log`) — full raw output remains available via the workspace layer, not
  via `replay()`'s durable tier.
- **Retention (`maxEventHistoryFiles`) only evicts confirmed-terminal jobs' files** — total
  on-disk file count can transiently exceed the cap while many jobs are in-flight, mirroring
  `workspaceManager.pruneWorkspaces()`'s own existing, identical behavior.
- **A whole-repository ponytail-audit run during this sprint's final gate** re-confirmed the
  prior sprint's finding that the `ObservabilityService` stack still has zero external
  (MCP-tool/Dashboard) consumers — `ReplayEngine`'s durable tier now has real internal logic,
  but nothing outside the module calls it yet. Separately, the same audit found three
  pre-existing, unrelated dead `RuntimeEvent` types (`ArtifactCreated`/`WorkspaceCreated`/
  `WorkspaceDeleted`, from `ADR-0002`, predating both recent sprints) — flagged as a standing
  question via a separate task, not resolved by this sprint (touches a different, previously-
  approved ADR's frozen contract).
- **Stdin-close self-shutdown (ADR-0004)** remains unverified against a real MCP host
  (pre-existing limitation, unaffected by this push).
