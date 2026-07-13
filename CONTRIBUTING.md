# Contributing

`claude-delegate-mcp` is a private, single-maintainer project (`"private": true` in
`package.json`, no public repository/remote configured) — it is not currently accepting
external contributions.

If you have local access to this repository and want to change something:

1. Read [docs/FOUNDATION_FREEZE.md](docs/FOUNDATION_FREEZE.md) and
   [docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md) first — they define what's
   frozen and why. Changes that would break a documented guarantee need an ADR
   (`docs/adr/`), not just a code change.
2. Run `npm test` before and after — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#development)
   for the test conventions used in this codebase (`node:test`, no external framework).
3. Update `CHANGELOG.md` for any user-visible change, following the existing entry format.

There is no CI, no issue tracker, and no pull request process configured for this repository
at this time.
