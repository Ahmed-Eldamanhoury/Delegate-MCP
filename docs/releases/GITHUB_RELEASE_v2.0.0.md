# GitHub Release — ready to paste

## Tag recommendation
`v2.0.0` (annotated tag, matching `package.json`'s version — see
[RELEASE_NOTES_v2.0.0.md](RELEASE_NOTES_v2.0.0.md)'s versioning note for why this isn't `v1.0.0`).

## Milestone recommendation
None needed for this release — it's the initial public release with no open issues/PRs to
group under a milestone yet. Consider creating a `v2.1` milestone once the roadmap items in
[ROADMAP.md](../../ROADMAP.md) get their own tracked issues.

## Release title
```
v2.0.0 — First public release
```

## Release description
```markdown
First public release of claude-delegate-mcp — an MCP server for Claude Desktop that delegates
tasks to a headless Claude Code CLI session, billed against your existing Claude subscription,
not a separate API key.

Certified ready per docs/CERTIFICATION_REPORT_v1.md and docs/RELEASE_CHECKLIST.md (9/9 PASS,
no High/Critical findings). Full release notes: docs/releases/RELEASE_NOTES_v2.0.0.md.

## Highlights
- Six MCP tools: delegate_task, delegate_submit, delegate_status, delegate_history,
  delegate_models, delegate_cancel
- Durable per-job Workspace persistence
- Real-time streaming progress via stream-json
- An internal, read-only Observability platform (metrics/timeline/replay/snapshots) — no
  external consumer yet, foundation for future Dashboard/API work
- 145/145 tests passing, zero MCP schema drift across the entire pre-release history

## Known limitations
See docs/releases/KNOWN_LIMITATIONS.md — none block this release.

## Roadmap
See ROADMAP.md — Dashboard, REST API, Plugin SDK, Prometheus/Grafana, all contract-designed,
none implemented yet.
```

Use "Generate release notes" (GitHub's auto-changelog) *in addition to* the description above
if you want a commit-by-commit appendix — the description above is the curated summary.
