# Security Policy

This is a private, single-maintainer, locally-run MCP server — there is no public repository,
issue tracker, or user base to disclose to. If you have local access to this project and find
a security issue, contact the maintainer directly rather than filing it anywhere public.

## Supported versions

Only the latest version on `master` is supported. There is no LTS/backport policy.

## Security model (evidence, not aspiration — see linked docs for detail)

- **No shell subprocess execution**: `claudeCliService.js` spawns `claude.exe` directly via
  `spawn()` with no shell, so the arbitrary/caller-controlled `prompt` text is never
  interpreted for shell metacharacters. Do not point `CLAUDE_DELEGATE_BIN` at the `.cmd`/`.bat`
  shim or reintroduce `shell: true` — see [README.md's Security note](README.md#security-note).
- **Path safety**: every filesystem path derived from a job id is gated by a UUID-format check
  (`isValidJobId()`) before use, across Workspace, Replay, and metrics code.
- **Secret redaction**: `ExecutionContext.environment` (`process.env`) is never written to disk
  or exposed through an MCP response — see
  [docs/ARCHITECTURE.md's Workspace section](docs/ARCHITECTURE.md#workspace-persistence-layer).
- **Read-only Observability**: `ObservabilityService` cannot mutate job state, cancel a job, or
  execute a command, by construction — see
  [ADR-0003's Passive Observation Rule](docs/adr/ADR-0003-observability-architecture.md#passive-observation-rule).

Full audit evidence: [docs/CERTIFICATION_REPORT_v1.md](docs/CERTIFICATION_REPORT_v1.md#security-status).

## Reporting a vulnerability

Contact the maintainer directly. Do not open a public issue (none exists) or post details
anywhere public before the maintainer has had a chance to review and, if needed, fix it.
