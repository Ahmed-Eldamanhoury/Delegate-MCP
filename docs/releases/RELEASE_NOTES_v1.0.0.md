# Release Notes — v1.0.0

`claude-delegate-mcp`: an MCP server that hands tasks off from Claude Desktop to a headless
Claude Code CLI session, billed against the user's existing Claude subscription — no separate
API key or billing.

Certified ready per [docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md). This
document summarizes that certification for a GitHub Releases audience; see the linked report
for full evidence.

> **Versioning note**: "v1.0.0" here is this project's first official/certified release
> *milestone* name. Because `package.json` had already reached `1.9.0` through this project's
> prior wave-by-wave versioning, the actual shipped `package.json`/npm-semver version is
> **`2.0.0`** — bumping backward to a literal `1.0.0` would have been a semver regression
> against existing history. See `CHANGELOG.md`'s `[2.0.0]` entry for the full explanation.
> There is no functional difference between v1.9.0 and v2.0.0.

## Major capabilities

- **Six MCP tools**: `delegate_task`, `delegate_submit`, `delegate_status`, `delegate_history`,
  `delegate_models`, `delegate_cancel` — full details in [README.md](../../README.md).
- **Execution engine**: `JobManager` runs delegated tasks with bounded concurrency, cancellation,
  and a full lifecycle (`queued → starting → running → {completed|failed|cancelled}`). See
  [docs/ARCHITECTURE.md](../ARCHITECTURE.md#job-lifecycle).
- **Workspace**: a durable, write-once on-disk mirror of every job (metadata, redacted
  context, stdout/stderr, result) — see
  [ADR-0001](../adr/ADR-0001-workspace-and-artifact-architecture.md).
- **Streaming**: real `stream-json` protocol parsing gives live progress
  (`"Thinking… (~N tokens)"`, then response text) via MCP `notifications/progress` — see
  [ADR-0002](../adr/ADR-0002-streaming-and-event-architecture.md).
- **Observability platform**: `RuntimeEventBus` plus a read-only `ObservabilityService`
  (metrics, per-job timelines, replay, immutable snapshots, consumer registry) — see
  [ADR-0003](../adr/ADR-0003-observability-architecture.md) and
  [docs/OBSERVABILITY_FREEZE.md](../OBSERVABILITY_FREEZE.md). Not yet exposed through any tool
  or UI — internal foundation only.

## Architecture

Layered `src/{config,models,services,handlers,server,cli,logging,validation}` structure; one
shared `JobManager` as the single source of truth for job state. Full breakdown:
[docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Security

No shell in the CLI spawn (command-injection prevention), Windows process-tree cleanup on
cancellation, manual buffer-growth protection, UUID path validation before any filesystem
access, `ExecutionContext.environment` redaction at the disk layer, and a Passive Observation
Rule making Observability structurally read-only. Full detail:
[docs/CERTIFICATION_REPORT_v1.md#security-status](../CERTIFICATION_REPORT_v1.md#security-status).

## Compatibility

Zero MCP schema change since `FOUNDATION_FREEZE.md` (v1.4.3) — six tools, byte-identical
input schemas, re-verified via Inspector at every subsequent wave including this release.

## Testing

145/145 tests passing (unit, integration, concurrency, streaming, replay — see the
certification report's Testing Summary for the full breakdown).

## Performance

O(1) incremental job metrics; bounded job/workspace/timeline history with oldest-terminal-first
eviction; no verified bottleneck found in this release's certification pass.

## Known limitations

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the full, evidence-based list (none block
this release).

## Roadmap

See [ROADMAP_v1.1.md](ROADMAP_v1.1.md) for approved future initiatives (none implemented in
this release).
