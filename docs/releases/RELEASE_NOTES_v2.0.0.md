# Release Notes — v2.0.0

`claude-delegate-mcp`: an MCP server that hands tasks off from Claude Desktop to a headless
Claude Code CLI session, billed against your existing Claude subscription — no separate API
key or billing.

This is the project's first official public release. It was internally referred to as the
"v1.0.0" certification milestone throughout its release-engineering wave (see
[RELEASE_NOTES_v1.0.0.md](RELEASE_NOTES_v1.0.0.md)) — the actual `package.json`/npm-semver
version is **2.0.0**, because the pre-release development history had already reached 1.9.0
through this project's own wave-by-wave versioning; bumping literally to 1.0.0 would have been
a semver regression. There is no functional difference between what was internally v1.9.0 and
what ships as v2.0.0.

Certified ready per [docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md) —
this document summarizes that certification for GitHub Releases; see the linked report and
[RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) for full evidence.

## Overview

A local MCP server for Claude Desktop with six tools (`delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel`) that delegate work
to a headless `claude -p` session running a cheaper/different model tier — billed against your
existing subscription, not a separate API key.

## Major Features

- **Execution engine** — `JobManager`: bounded-concurrency job queue, cancellation, full
  lifecycle (`queued → starting → running → {completed|failed|cancelled}`).
- **Workspace** — a durable, write-once on-disk mirror of every job (metadata, redacted
  context, stdout/stderr, result), independent of in-memory history.
- **Streaming** — real `stream-json` protocol parsing gives live progress via MCP
  `notifications/progress` while a task runs.
- **Observability platform** — an internal `RuntimeEventBus` plus a strictly read-only
  `ObservabilityService` (metrics, per-job timelines, replay, immutable snapshots, a consumer
  registry). Not yet exposed through any tool or UI — foundation for future consumers only.

## Architecture

Layered `src/{config,models,services,handlers,server,cli,logging,validation}` structure with
one shared `JobManager` as the single source of truth for job state. See
[docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Workspace

Every job gets a durable on-disk record (`metadata.json`, redacted `context.json`, logs,
`result.json`) at `<workspaceRoot>/jobs/<job-id>/`, pruned automatically past a configurable
history cap. See [ADR-0001](../adr/ADR-0001-workspace-and-artifact-architecture.md).

## Streaming

`--output-format stream-json --verbose`, verified against real CLI captures (not assumed) —
see [ADR-0002](../adr/ADR-0002-streaming-and-event-architecture.md).

## Observability

`ObservabilityService` is the sole gateway for future monitoring consumers — Dashboard,
plugins, and future APIs will depend only on it, never on `RuntimeEventBus` directly. Read-only
by construction (Passive Observation Rule): it cannot mutate job state, cancel a job, or
execute a command. See [ADR-0003](../adr/ADR-0003-observability-architecture.md) and
[OBSERVABILITY_FREEZE.md](../OBSERVABILITY_FREEZE.md).

## Security

No shell in the CLI subprocess spawn (command-injection prevention), Windows process-tree
cleanup on cancellation, manual buffer-growth protection, UUID path validation before any
filesystem access, `ExecutionContext.environment` redaction, and Observability's structural
read-only guarantee. One hardening fix landed as part of this release: `DEFAULT_BIN` no longer
hardcodes a filesystem path — it's derived from `%APPDATA%` at runtime. Full detail:
[CERTIFICATION_REPORT_v1.md#security-status](../CERTIFICATION_REPORT_v1.md#security-status).

## Compatibility

Zero MCP schema change since `FOUNDATION_FREEZE.md` (originally v1.4.3) — six tools,
byte-identical input schemas, re-verified via Inspector through this release.

## Testing

145/145 tests passing — unit, integration, concurrency, streaming, and replay coverage. See
the certification report's Testing Summary for the full breakdown.

## Certification

[docs/CERTIFICATION_REPORT_v1.md](../CERTIFICATION_REPORT_v1.md): certified, 100% readiness
against its own gates, no High/Critical findings.

## Known Limitations

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the full, evidence-based list — none block
this release (no `ConsumerRegistry` auto-expiry, an informational-metric-only accuracy gap in
workspace artifact counting, replay fidelity degrading to "coarse" once a job's timeline is
evicted from memory, and streaming's real-world verification being limited to two CLI
captures).

## Future Roadmap

See [ROADMAP.md](../../ROADMAP.md) / [ROADMAP_v1.1.md](ROADMAP_v1.1.md) — Dashboard, REST API,
Plugin SDK, VS Code Extension, Prometheus/Grafana, all contract-designed, none implemented.
