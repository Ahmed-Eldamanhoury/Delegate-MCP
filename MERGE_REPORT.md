# Merge Report — Persistent Event History Sprint

## Merged commits

`195bce3..0f1228c` on `main` (fast-forward, no merge commit — the feature branch was already a
direct descendant of `main`'s tip):

| Commit | Summary |
|---|---|
| `948879e` | Implement EventHistoryStore: append-only durable event log, unit-tested in isolation |
| `56cba87` | Wire EventHistoryStore into the bus behind config.eventHistory (ADR-0006) |
| `26398c4` | Cap event-history .jsonl file count, oldest-completed-first (ADR-0006) |
| `8c81273` | Add durable tier to ReplayEngine's fallback chain (ADR-0006) |
| `98e2fac` | Add E2E restart proof and measured benchmark for EventHistoryStore (ADR-0006) |
| `49f50ac` | Wire ObservabilityService.close() into graceful shutdown |
| `b1670ed` | Reconcile docs for Persistent Event History (ADR-0006), bump to 2.4.0 |
| `eea7c99` | Fix docs claiming a literal "events.jsonl" filename that doesn't exist |
| `0f1228c` | Dedup EventHistoryStore construction: build once, share between bridge and ReplayEngine (ADR-0006) |

The last two commits (`eea7c99`, `0f1228c`) were produced during Task 7's own final-gate
review — a whole-branch code review and a whole-repo ponytail-audit each surfaced one real,
fixable finding, and both were fixed and re-reviewed before this merge, per the same discipline
`ADR-0005`'s sprint used.

## Final commit hash

`0f1228cbb8424f5decc9209c1a6ed59f5b392c5d` (`main`, tagged `v2.4.0`)

## Test results

278/278 passing, re-run fresh on `main` immediately after the merge (not reused from the
worktree's last run):

```
tests 278
pass 278
fail 0
cancelled 0
skipped 0
todo 0
```

## Inspector verification

Ran `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list` against the
merged `main` directly. Result: exactly 6 tools — `delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel` — zero schema drift.
This sprint added no MCP tool and changed no tool schema, confirmed independently rather than
assumed from the source diff.

## Integrity checks (explicitly requested before this report)

- **`main` is clean**: `git status --short` — no output, working tree clean.
- **`origin/main` matches**: `git rev-parse main origin/main` — both resolve to
  `0f1228cbb8424f5decc9209c1a6ed59f5b392c5d`, identical.
- **Tag points to the correct commit**: `git rev-parse v2.4.0^{commit}` →
  `0f1228cbb8424f5decc9209c1a6ed59f5b392c5d`, matching `main`'s tip exactly. See `PUSH_REPORT.md`
  for the remote-side confirmation.
- **All tests pass**: 278/278, confirmed above.
- **CI is green**: see `PUSH_REPORT.md` for the full CI/CodeQL breakdown.
- **No duplicate `EventHistoryStore` construction remains**: `grep -rn "createEventHistoryStore("
  src/` returns exactly two hits — the function's own definition
  (`src/services/eventHistoryStore.js:14`) and its single call site
  (`src/server/mcpServer.js:69`, inside the new `selectEventHistoryStore()`). This was itself a
  finding fixed during this sprint's final gate (commit `0f1228c`) — before that fix, the same
  store was constructed twice (once for the write-side bridge, once inside
  `ObservabilityService`), independently gated on the identical condition.
- **`EventHistoryStore` is the only implementation used by the new persistence path**: the single
  instance `selectEventHistoryStore()` constructs is threaded into both
  `wireEventHistoryIfEnabled` (write side) and `createObservabilityService` (read side, via
  `ReplayEngine`'s new "durable" tier) — confirmed by `grep -rln "eventHistoryStore\b" src/`
  returning exactly the 5 files that legitimately touch it (`mcpServer.js`,
  `eventHistoryBridge.js`, `eventHistoryStore.js`, `observabilityService.js`, `replayEngine.js`),
  and by two dedicated "directory-mismatch" tests (`tests/observabilityService.test.js`,
  `tests/mcpServer.test.js`) that only pass if the shared instance is genuinely what's used, not
  a second, independently-configured one.

## Cleanup

Worktree `.claude/worktrees/persistent-event-history` removed and branch
`worktree-persistent-event-history` deleted — both fully merged into `main` at the time of
removal (identical tip commit), so no work was lost.
