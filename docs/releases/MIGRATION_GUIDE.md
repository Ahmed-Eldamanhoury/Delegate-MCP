# Migration Guide — v1.0.0

> **Versioning note**: "v1.0.0" is the release milestone name — the actual `package.json`
> version is `2.0.0` (see `CHANGELOG.md`'s `[2.0.0]` entry: `package.json` had already reached
> `1.9.0`, so bumping literally to `1.0.0` would have been a semver regression). No functional
> difference exists between v1.9.0 and v2.0.0.

## Version compatibility

This release is compatible with every prior version back to v1.4.3 (the first
`FOUNDATION_FREEZE.md` baseline) at the MCP protocol level — no schema in `tools/list` has
changed across that entire range, re-verified fresh via Inspector at every wave through
v1.9.0/v2.0.0.

## Upgrade path

There is no breaking change to migrate around. If you are running any version ≥ v1.4.3:

1. Pull/update the repository.
2. `npm install` (no new production dependency was added across this range — still only
   `@modelcontextprotocol/sdk` and `zod`, unchanged by `ADR-0011`'s REST work too, which uses
   only Node's built-in `http`/`crypto`/`url` modules).
3. Restart Claude Desktop so it re-connects to the MCP server.

No config migration, no data migration, no `claude_desktop_config.json` change is required.

## REST API is entirely opt-in — zero required action for an MCP-only user

`ADR-0011`'s REST API Foundation (`v2.8.0`) adds a **separate, standalone process**
(`node src/cli/restEntry.js`, or a future `npm run start:rest` script) — never a flag on the
existing stdio MCP process, never started automatically, never reachable from Claude Desktop's
own launch of `server.js`. If you only use this tool through Claude Desktop's MCP integration:

- **You do not need to do anything.** No new env var is required, no new file is written, no
  new port is opened, unless you deliberately run `restEntry.js` yourself.
- The existing stdio MCP server (`server.js` → `src/cli/entry.js`) is byte-for-byte unchanged
  in observable behavior — `docs/FOUNDATION_FREEZE.md`'s 9 tool schemas are untouched, and the
  one internal refactor behind this release (`createDelegationBackend()`, see `CHANGELOG.md`'s
  `[2.8.0]` entry) is a Extract-Function refactor verified behavior-preserving by the full
  pre-existing test suite passing unmodified.

If you *do* choose to run REST: it binds `127.0.0.1:8787` by default, generates and persists a
bearer token on first boot (`.delegate-rest-token` in the project root, or wherever
`CLAUDE_DELEGATE_REST_TOKEN_FILE` points), and requires that token on every request. See
[REST_FREEZE.md](../REST_FREEZE.md) for the full contract and
[ADR-0011](../adr/ADR-0011-rest-api-foundation.md) for the design rationale.

## Backward compatibility

Guaranteed by [docs/FOUNDATION_FREEZE.md](../FOUNDATION_FREEZE.md): tool names, input schemas,
the blocking/non-blocking execution contract, the job lifecycle, and the `ExecutionContext`
shape are all frozen. `docs/OBSERVABILITY_FREEZE.md` extends the same discipline to
`ObservabilityService`'s internal contract. Three MCP tools now expose it specifically:
`delegate_replay` ([ADR-0007](../adr/ADR-0007-mcp-replay-access.md)) exposes `replay()`,
`delegate_metrics` ([ADR-0008](../adr/ADR-0008-mcp-metrics-access.md)) exposes `getMetrics()`,
and `delegate_snapshot` ([ADR-0009](../adr/ADR-0009-mcp-snapshot-access.md)) exposes
`getSnapshot()` — those tools' own input/output schemas are what `FOUNDATION_FREEZE.md`
governs. The rest of `ObservabilityService`'s surface (`getTimeline()`/`ConsumerRegistry`)
still carries no external compatibility surface, since nothing exposes it.

## Frozen contracts

- [FOUNDATION_FREEZE.md](../FOUNDATION_FREEZE.md) — 9 MCP tools, schemas, execution contract, job lifecycle, `ExecutionContext`.
- [ADR-0001](../adr/ADR-0001-workspace-and-artifact-architecture.md) — Workspace layout and security model.
- [ADR-0002](../adr/ADR-0002-streaming-and-event-architecture.md) — `RuntimeEventBus` contract, event schema, streaming.
- [ADR-0003](../adr/ADR-0003-observability-architecture.md) / [OBSERVABILITY_FREEZE.md](../OBSERVABILITY_FREEZE.md) — Observability's public method set and data shapes.

## No breaking changes

None. v1.0.0 is a certification/packaging milestone over already-shipped, already-frozen
functionality — it does not introduce any new capability itself.

## Known behavioral changes

None since v1.4.3's `FOUNDATION_FREEZE.md` baseline. Everything added since then
(Workspace, RuntimeEventBus, Streaming, Observability) is strictly additive — existing tool
behavior, response shapes, and defaults are unchanged, verified by the same Inspector schema
diff run at every wave.
