# Security Policy

This is a single-maintainer, locally-run MCP server
([repository](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP)). If you find a security
issue, please report it privately (see below) rather than filing a public issue.

## Supported versions

Only the latest version on `main` is supported. There is no LTS/backport policy.

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

Use GitHub's private vulnerability reporting: open the
[repository's Security tab](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/security) and
click "Report a vulnerability." Do not open a public issue for a security report, and do not
post details anywhere public before the maintainer has had a chance to review and, if needed,
fix it.
