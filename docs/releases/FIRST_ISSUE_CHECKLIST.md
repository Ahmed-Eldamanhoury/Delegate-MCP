# First Issue Checklist — for new contributors

A short checklist for picking up a `good first issue`-labeled issue, per
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Before you start
- [ ] Read [docs/ARCHITECTURE.md](../ARCHITECTURE.md) for the file layout and where your
      change likely belongs.
- [ ] Read [docs/FOUNDATION_FREEZE.md](../FOUNDATION_FREEZE.md) — if the issue touches the 6
      MCP tools, their schemas, the job lifecycle, or `ExecutionContext`, understand what's
      frozen before proposing a change there.
- [ ] `npm install` then `npm test` — confirm the suite passes on your machine before you
      change anything (no `claude` CLI install/login required to run tests).

## While working
- [ ] Keep the change scoped to the issue — this project has deliberately avoided speculative
      abstractions ("no interface with one implementation, no config for a value that never
      changes"); new code should follow the same discipline.
- [ ] Add or update a test alongside any behavioral change — see `tests/` for the existing
      `node:test` conventions (no external framework, no network/CLI dependency).
- [ ] Update `CHANGELOG.md` for any user-visible change.

## Before opening the PR
- [ ] `npm test` passes.
- [ ] Fill out [.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md)'s
      checklist honestly.
- [ ] Double-check your diff for anything personal (local paths, usernames, tokens) — this
      repo's own history had exactly that kind of leak fixed once already.
