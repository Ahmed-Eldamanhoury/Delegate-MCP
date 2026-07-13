# Maintainer Checklist — ongoing

Recurring responsibilities once the repo is public, per [CONTRIBUTING.md](../../CONTRIBUTING.md)
and [SECURITY.md](../../SECURITY.md). Not a one-time setup list — see
[PUBLISHING_CHECKLIST.md](PUBLISHING_CHECKLIST.md) for that.

## Per pull request
- [ ] `CI` workflow passes (Node 20.x/22.x × Ubuntu/Windows — see `.github/workflows/ci.yml`).
- [ ] `CHANGELOG.md` updated if the change is user-visible.
- [ ] If a frozen contract is touched (`docs/FOUNDATION_FREEZE.md`,
      `docs/OBSERVABILITY_FREEZE.md`), an ADR justifies it, per this project's established
      discipline (every prior capability shipped architecture-first, then implementation).
- [ ] No new hardcoded local paths, usernames, or secrets (the kind of leak already found and
      fixed once in this repo's own history — see `CHANGELOG.md`'s `[2.0.0]` entry).

## Per issue
- [ ] Triage against [docs/releases/KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — is this
      already a documented, accepted tradeoff rather than a new bug?
- [ ] Label per `.github/labels.yml`'s set.
- [ ] Security reports: confirm they came through GitHub's private vulnerability reporting
      (per `SECURITY.md`), not a public issue — redirect if not.

## Periodic
- [ ] Review and merge Dependabot PRs (`.github/dependabot.yml`, weekly for npm + GitHub
      Actions).
- [ ] Review CodeQL findings (`.github/workflows/codeql.yml`, runs on push/PR + weekly cron).
- [ ] Re-run the Inspector schema check
      (`npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`) before
      any release that touches `src/handlers/` or `src/models/schemas.js` — a byte-for-byte
      diff against the last known-good snapshot is this project's standing quality gate.
- [ ] Any change to `docs/FOUNDATION_FREEZE.md` or `docs/OBSERVABILITY_FREEZE.md` itself
      requires an ADR and a major version bump, per each document's own Breaking-change policy.
