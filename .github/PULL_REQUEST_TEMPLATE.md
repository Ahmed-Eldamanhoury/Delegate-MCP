## What does this change?

<!-- One or two sentences. -->

## Why?

<!-- The problem this solves, or the issue it fixes (e.g. "Fixes #123"). -->

## Checklist

- [ ] `npm test` passes locally
- [ ] `CHANGELOG.md` updated (for any user-visible change)
- [ ] If this touches a frozen contract (9 MCP tools' schemas, job lifecycle,
      `ExecutionContext`, `RuntimeEventBus`, `ObservabilityService`'s public methods) — this PR
      explains why, and references the relevant ADR/freeze doc
- [ ] No new REST endpoints — REST contract is frozen at [`docs/REST_FREEZE.md`](../docs/REST_FREEZE.md)
- [ ] No `innerHTML` / `dangerouslySetInnerHTML` in `dashboard/src/` — RC6 security invariant
- [ ] No new hardcoded local paths, usernames, or secrets introduced

## Anything else reviewers should know?
