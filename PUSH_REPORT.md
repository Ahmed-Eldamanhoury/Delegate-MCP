# Push Report — MCP Replay Access Sprint

## Pushed commits

`8d64f22..f4ee76e` on `main` (fast-forward push, no merge commit) — same 13 commits listed in
`MERGE_REPORT.md`. Final commit hash: `f4ee76ed21a677c2f31949633487bf9ce75e89b5`, pushed to
`origin/main`. Annotated tag `v2.5.0` created on this commit and pushed to `origin/v2.5.0`.

## Test results

281/281 passing, re-run fresh on `main` immediately after the push:

```
tests 281
pass 281
fail 0
cancelled 0
skipped 0
todo 0
```

## CI results (GitHub Actions, triggered by this push)

| Workflow | Result | Detail |
|---|---|---|
| **CI** (`test`, 4-way matrix: ubuntu/windows × node 20/22.x) | ✅ **Success** | All 4 jobs green in 22-46s each: checkout, setup-node, `npm ci`, `npm test`, post-steps. Run [29525843233](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/actions/runs/29525843233). |
| **CodeQL** (`analyze`) | ❌ **Failure** | Pre-existing and environmental, not caused by this sprint — see below. Run [29525843226](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/actions/runs/29525843226). |

**CodeQL failure is the same pre-existing, environmental issue documented in every prior
sprint's push report.** Fails identically at the `analyze` step: *"Code scanning is not enabled
for this repository. Please enable code scanning in the repository settings."* Checked the last
5 CodeQL runs on `main` — every one failed identically, including every commit pushed *during*
this exact sprint, well before this sprint's own final push. This requires a repository-settings
change (GitHub Advanced Security / code scanning enablement), not a code fix — clearly
distinguished here from a sprint regression: nothing in this sprint's diff touches CI
configuration, and the failure signature (missing repository-level code-scanning permission) is
identical across every run checked, unrelated to what code was pushed. Not acted on, since
changing repository security settings wasn't requested.

## Repository status

- `main` is up to date with `origin/main` — `git rev-parse main origin/main` both resolve to
  `f4ee76ed21a677c2f31949633487bf9ce75e89b5`, identical.
- Feature branch `worktree-mcp-replay-access` merged and deleted; its worktree
  (`.claude/worktrees/mcp-replay-access`) removed and pruned.
- `package.json` version: `2.5.0`.
- Annotated tag `v2.5.0` created and pushed, matching this repo's own precedent of tagging every
  version bump (`v2.0.0`, `v2.2.1`, `v2.2.2`, `v2.3.0`, `v2.4.0` all exist). Verified on the
  remote: `git ls-remote --tags origin` shows `refs/tags/v2.5.0^{}` dereferencing to
  `f4ee76ed21a677c2f31949633487bf9ce75e89b5` — the exact commit `main` points to.
- MCP tool surface: 7 tools now (was 6) — `delegate_replay` added, zero schema drift on the
  other 6, independently verified via Inspector `tools/list` **and** a live `tools/call`
  invocation against the merged `main` (see `MERGE_REPORT.md`).
- No GitHub Release created (not requested for this sprint).

## Remaining known limitations

- **CodeQL is not currently running for this repository** (see above) — unrelated to this
  sprint, unresolved since before the Persistent Job Store Sprint began.
- **`ObservabilityService`'s read surface is now partially consumed.** `replay()` has its first
  external consumer (`delegate_replay`); `getMetrics()`, `getSnapshot()`, `getTimeline()`, and
  the whole `ConsumerRegistry` still have zero external consumers — a whole-repo ponytail-audit
  run during this sprint's final gate re-confirmed this status (narrower than before, not fully
  resolved) rather than re-flagging it as a new finding. Tracked separately (`task_026caee1`).
- **Three pre-existing, unrelated dead `RuntimeEvent` types** (`ArtifactCreated`/
  `WorkspaceCreated`/`WorkspaceDeleted`, from `ADR-0002`, predating this and the prior sprint)
  remain untouched — re-confirmed unchanged by this sprint's audit, tracked separately
  (`task_d7317142`), out of scope since it touches a different, previously-approved ADR's
  frozen contract.
- **`delegate_replay` intentionally omits filtering** (`type`/`since` parameters
  `getTimeline()` supports) — deferred per `ADR-0007` until a real consumer need appears; the
  schema shape is additively extensible without a breaking change if that happens.
- **Stdin-close self-shutdown (ADR-0004)** remains unverified against a real MCP host
  (pre-existing limitation, unaffected by this push).
