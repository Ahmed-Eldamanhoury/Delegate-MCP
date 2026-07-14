# Merge Report — Critical Stability Sprint

## Merged commits

`c1f3c72..7a25b98` on `main` (fast-forward, no merge commit — the feature branch was
already a direct descendant of `main`'s tip):

| Commit | Summary |
|---|---|
| `01d23ec` | Add Critical Stability Sprint plan (crash fix + instance-lifecycle ADR) |
| `6b99235` | Fix Debug Mode terminal launcher crashing the whole server on spawn failure |
| `bc82626` | Add ADR-0004: investigate duplicate server.js instance lifecycle |
| `f0b51f4` | Add liveness-checked PID file as a considered alternative in ADR-0004 |
| `9da6746` | Bump to 2.2.1, document the crash fix and ADR-0004 in canonical release docs |
| `7a25b98` | Add Critical Stability Sprint deliverables (sprint/review/value/performance reports) |

## Final commit hash

`7a25b9801feb4467d62554f48f4d99c5197ae4b7` (`main`, tagged `v2.2.1`)

## Test results

179/179 passing, re-run fresh on `main` immediately after the merge (not reused from the
worktree's last run):

```
tests 179
pass 179
fail 0
cancelled 0
skipped 0
todo 0
```

## Inspector verification

Ran `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`
against the merged `main` directly (not assumed from the source diff alone). Result:
exactly 6 tools — `delegate_task`, `delegate_submit`, `delegate_status`,
`delegate_history`, `delegate_models`, `delegate_cancel` — with input schemas
byte-identical to what was documented before this sprint (this sprint's diff touched
zero files under `src/models/schemas.js` or any MCP tool registration path, confirmed
independently by the whole-branch review). No drift.

## Pushed commit hash

`7a25b9801feb4467d62554f48f4d99c5197ae4b7` — pushed to `origin/main`
(`c1f3c72..7a25b98`, fast-forward). Annotated tag `v2.2.1` created and pushed
(`origin/v2.2.1`), since this sprint bumped the public release version
(`package.json` 2.2.0 → 2.2.1).

## Cleanup

Worktree `.claude/worktrees/critical-stability-sprint` removed and branch
`worktree-critical-stability-sprint` deleted — both fully merged into `main` at the time
of removal (identical tip commit), so no work was lost.
