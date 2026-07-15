# ADR-0005: Persistent Job Store

## Status
Proposed (design approved by user; implementation follows in
`docs/superpowers/plans/persistent-job-store.md`).

## Context
`src/services/jobStore.js`'s `InMemoryJobStore` is the only implementation of the
4-method (`create`/`get`/`update`/`list`, plus `delete` used by `JobManager._trimHistory()`)
storage interface `docs/FOUNDATION_FREEZE.md` already froze as an extension point: *"a
future persistent store (e.g. SQLite) can implement the same four methods and be swapped
in via `JobManager`'s `store` dependency — no changes needed elsewhere."* Today, every
job record — status, timestamps, result, error — lives only in a `Map` in process memory.
A server restart (including the graceful `stdin`-close shutdown ADR-0004 just implemented)
loses all job history instantly, even though `workspace/jobs/<id>/metadata.json` still has
most of the same data on disk as a best-effort mirror (ADR-0001).

A prior sprint's `ponytail-audit` (see the prior Dogfooding Sprint's
`DOGFOODING_METRICS.md`) flagged `InMemoryJobStore`'s interface framing as speculative —
*"exactly one implementation and one instantiation site."* This ADR resolves that finding
by implementing a second, real implementation, rather than deleting the abstraction.

## Goals
- Job history survives a process restart.
- Zero change to any MCP tool schema, to `JobManager`'s public methods, or to the
  `JobStore` interface itself (`create`/`get`/`update`/`list`/`delete` — unchanged
  signatures).
- Zero change to default behavior: existing deployments continue using
  `InMemoryJobStore` unless a new config flag explicitly opts in.
- No new production dependency — synchronous `node:fs` only, matching the pattern
  `workspaceManager.js` already established.
- Respect the one binding constraint `jobManager.js` imposes on any store: every method
  is called **synchronously and unawaited** (`this.store.create(...)`, never
  `await this.store.create(...)`). A persistent implementation must therefore either do
  synchronous I/O or maintain its durability guarantee some other way that doesn't require
  the caller to await — this ADR chooses synchronous I/O, the simplest option that needs
  no change to `jobManager.js` at all.

## Decision

Implement `PersistentJobStore` in `src/services/persistentJobStore.js`, satisfying the
exact same interface as `InMemoryJobStore`:

```js
export class PersistentJobStore {
  constructor({ dir }) { ... }   // dir: directory to store one JSON file per job
  create(job) { ... }            // writes <dir>/<job.id>.json synchronously, caches in memory
  get(id) { ... }                // reads from the in-memory cache (hydrated at construction)
  update(id, patch) { ... }      // merges + rewrites <dir>/<id>.json synchronously, updates cache
  list() { ... }                 // returns from the in-memory cache
  delete(id) { ... }             // fs.rmSync the file, removes from cache
}
```

**One file per job, not one flat file.** A single all-jobs JSON file would require a full
rewrite on every transition — up to 4 rewrites per job (`queued`→`starting`→`running`→
terminal) — growing linearly with total job count on every single write. Per-job files
keep each write's cost proportional to one job's own record, matching the O(1)-per-event
design this codebase already uses elsewhere (`MetricsCollector`'s incremental aggregates,
ADR-0003). This also lets `delete()` (called by `_trimHistory()`'s eviction) map directly
to `fs.unlinkSync()` — no read-modify-write of a shared file.

**In-memory cache, not read-through disk.** `get()`/`list()` read from a `Map` populated
once at construction (`hydrate()`: `fs.readdirSync(dir)` + `fs.readFileSync` per file,
`JSON.parse`, `Map.set`). `create()`/`update()`/`delete()` write through to both disk and
the cache. This keeps read-path performance identical to `InMemoryJobStore` — `jobManager.js`
calls `store.list()` inside `_trimHistory()` on every job settlement, and that must not
become an O(n) disk read on every job completion.

**A separate directory from `workspace/`, not reused.** `workspace/jobs/<id>/metadata.json`
is `ADR-0001`'s best-effort *mirror*, explicitly never authoritative
(`docs/FOUNDATION_FREEZE.md`: *"`JobManager` is the single source of truth for job
state... Persistence layers (e.g. the workspace layer) mirror it; they do not replace
it"*). Writing `PersistentJobStore`'s files into the same directory would blur that
distinction — an observer couldn't tell "the mirror" from "the actual backing store" by
looking at the directory. New config field `jobStoreDir` (env
`CLAUDE_DELEGATE_JOB_STORE_DIR`, default `<project>/job-store`) keeps them visibly
separate. `isValidJobId()` (already exported from `workspaceManager.js`) is reused here
too — same UUID-before-path-join discipline `ADR-0001`'s Security model established,
applied to a second location.

**Opt-in via config, default unchanged.** New config field `jobStore` (env
`CLAUDE_DELEGATE_JOB_STORE`, default `"memory"`, accepts `"memory"` or `"persistent"`).
`mcpServer.js`'s `JobManager` construction picks `new PersistentJobStore({dir:
config.jobStoreDir})` only when `config.jobStore === "persistent"`; otherwise unchanged
(`new InMemoryJobStore()`, `JobManager`'s own default). This is additive per
`docs/FOUNDATION_FREEZE.md`'s Compatibility guarantees (*"Adding a `DelegateConfig` field
with a safe default is backward compatible"*) — zero behavior change for any existing
deployment unless the operator explicitly sets the new env var.

## Failure handling

Matching `ADR-0001`'s precedent for the workspace layer: a `PersistentJobStore` write
failure (disk full, permissions) must never surface as a tool-call error or crash the
process, since `JobManager`'s in-memory correctness must not depend on the disk succeeding.
Each write is wrapped; a failure is logged and the in-memory cache is still updated (so the
running process behaves exactly as `InMemoryJobStore` would for the remainder of that
run) — the durability guarantee this ADR adds is "survives an intentional/graceful
restart," not "impervious to disk failure," which was never a real requirement here (no
other component in this codebase makes that stronger claim either).

## Testing plan

Unit: each of the 5 methods against a real temp directory (not mocked `fs`, matching
`workspaceManager.test.js`'s existing style) — create writes the expected file and
returns the job; update merges correctly and rewrites; list/get reflect the current cache;
delete removes both file and cache entry; hydration at construction correctly rebuilds
the cache from an existing directory of files; a corrupted/unparseable file on disk during
hydration is skipped and logged, not thrown (matching the fail-safe precedent above);
`isValidJobId()` rejects a non-UUID id before any path is constructed from it (security
regression test, mirroring `workspaceManager.test.js`'s equivalent). Integration: a full
`JobManager` instance constructed with `{store: new PersistentJobStore(...)}` runs a real
job lifecycle end-to-end, then a **second** `JobManager`/`PersistentJobStore` pair
constructed against the same directory sees the completed job via `listJobs()` — the
actual "survives a restart" property, proven, not assumed.

## Compatibility impact

None on any `docs/FOUNDATION_FREEZE.md` guarantee. Zero MCP schema change. Two new
optional config fields (`jobStore`, `jobStoreDir`), both defaulting to today's exact
behavior. No change to `JobManager`, `JobStore`'s method signatures, or any MCP tool
handler.

## Alternatives considered

- **SQLite** (`better-sqlite3` or similar): rejected — a new production dependency for a
  workload (≤`maxHistory` records, synchronous access, single process) that flat files
  already serve without one. `docs/FOUNDATION_FREEZE.md`'s own Extension points note names
  SQLite only as an illustrative example, not a requirement.
- **Single flat JSON file for all jobs**: rejected, see Decision above — full-file rewrite
  per transition doesn't scale with job count and breaks from this codebase's established
  O(1)-per-event pattern.
- **Async write-behind queue** (batch writes for throughput): rejected — `jobManager.js`
  never awaits store calls, so an async queue would create a window where a crash between
  the in-memory write and the deferred flush loses data, undermining the ADR's actual
  purpose. Synchronous writes are slightly slower per call but correctness-preserving,
  and job transitions are infrequent enough (a handful per job, not a hot loop) that the
  cost is negligible.
- **Reusing `workspace/jobs/<id>/metadata.json` directly as the store's backing file**:
  rejected — would conflate "best-effort mirror" (ADR-0001, allowed to lag/fail silently)
  with "authoritative backing store" (this ADR, must reflect `JobManager`'s state
  correctly), a distinction `docs/FOUNDATION_FREEZE.md` already draws explicitly.
