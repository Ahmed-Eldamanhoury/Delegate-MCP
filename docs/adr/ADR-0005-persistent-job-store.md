# ADR-0005: Persistent Job Store

## Status
**Frozen — approved for implementation** (design approved by user across two review
passes: initial design, then a 10-point architecture review that amended it — see
Amendment Log). Implementation follows in
`docs/superpowers/plans/persistent-job-store.md`.

## Amendment Log (post-initial-approval architecture review)

The initial draft was reviewed against 10 explicit architectural properties before being
frozen. Six real gaps were found and fixed here, not rubber-stamped:

1. **No explicit `JobStore` interface existed — only two classes duck-typed alike.**
   `src/services/jobManager.js`'s own JSDoc typed its `store` parameter as the *concrete*
   `InMemoryJobStore`, not an abstraction. Fixed: a `@typedef {Object} JobStore` is added
   to `jobStore.js` itself (see Public contract below), and `jobManager.js`'s JSDoc is
   updated to reference `JobStore`, not `InMemoryJobStore`. This is a one-line type-doc
   change to an existing file, not a behavior change.
2. **Renamed `PersistentJobStore` → `FileJobStore`.** "Persistent" is a category (SQLite,
   Postgres, Redis, S3 would all also be "persistent"); "File" names the actual mechanism.
   This directly supports point 3 below — the class name itself now stops implying it's
   the only persistent option.
3. **No storage format version.** Added: every job file carries a `storeVersion: 1`
   field, mirroring the precedent `ADR-0002` already set (`RuntimeEvent.version`, frozen
   at 1, independent of `package.json`). See Storage format below.
4. **No atomic-write guarantee — a crash mid-write could leave a torn/corrupted file.**
   Fixed: writes go through a temp-file-then-`rename()` sequence (same directory, same
   filesystem) instead of a direct `writeFileSync` to the final path. `rename()` is
   atomic on the same volume on both POSIX and NTFS — a reader can never observe a
   partially-written file. This is strictly stronger than "detect corruption and skip
   it," which was the original draft's only safeguard.
5. **No deterministic startup-recovery semantics for non-terminal jobs.** A job that was
   `queued`/`starting`/`running` when the process died has no live subprocess to ever
   complete it after restart — left as-is, `delegate_status` would report a "running" job
   forever, and any caller still awaiting it via `waitForCompletion()` would hang
   indefinitely. Fixed: hydration transitions any non-terminal job to `failed` with a
   fixed error message, deterministically, at load time. See Startup recovery below.
6. **No explicit migration path or out-of-scope section.** Both added below.

Points not requiring a fix (verified, not assumed): #2 (`JobManager` never imports
`FileJobStore`) and #4 (new backends need no `JobManager` change) were already true by
construction in the original design — confirmed by reading `jobManager.js` directly
(it imports only `InMemoryJobStore`, and only for its own default parameter); stated
explicitly below rather than left implicit. #8 (backward compatibility) was already
correct; the config value naming was adjusted alongside the rename in point 2 above
(`CLAUDE_DELEGATE_JOB_STORE=file`, not `=persistent`, so a future `=sqlite` sits next to
it without redefining what the flag already means).

## Context
`src/services/jobStore.js`'s `InMemoryJobStore` is the only implementation of the
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
  `JobStore` interface's method signatures.
- Zero change to default behavior: existing deployments continue using
  `InMemoryJobStore` unless a new config flag explicitly opts in.
- No new production dependency — synchronous `node:fs` only, matching the pattern
  `workspaceManager.js` already established.
- Respect the one binding constraint `jobManager.js` imposes on any store: every method
  is called **synchronously and unawaited**. A persistent implementation must therefore
  either do synchronous I/O or maintain durability some other way that doesn't require
  the caller to await — this ADR chooses synchronous I/O, the simplest option that needs
  no change to `jobManager.js`'s call sites at all.
- The interface itself must be a real abstraction `JobManager` depends on — not two
  classes that merely happen to share method names.

## Public contract — the `JobStore` interface

Added to `src/services/jobStore.js` (a JSDoc type, not a runtime construct — this
project has no TypeScript build step, so the "interface" is documented, not compiler-
enforced, matching how `RuntimeEventBus`'s `{publish, subscribe, subscribeAll}` shape in
`ADR-0002` is likewise a documented contract rather than a class hierarchy):

```js
/**
 * @typedef {Object} JobStore
 * @property {(job: import("../models/job.js").Job) => import("../models/job.js").Job} create
 * @property {(id: string) => import("../models/job.js").Job | undefined} get
 * @property {(id: string, patch: Partial<import("../models/job.js").Job>) => import("../models/job.js").Job | undefined} update
 * @property {() => import("../models/job.js").Job[]} list
 * @property {(id: string) => boolean} delete
 */
```

`jobManager.js`'s constructor JSDoc changes from `{store?: InMemoryJobStore, ...}` to
`{store?: JobStore, ...}` — a doc-only change; `jobManager.js` still imports
`InMemoryJobStore` for its own default value, and now additionally imports the `JobStore`
type via JSDoc's `import(...)` syntax for annotation purposes only (no runtime import of
`FileJobStore` is ever added to `jobManager.js` — that stays confined to whichever module
constructs a `JobManager`, i.e. `mcpServer.js`).

## Decision

Implement `FileJobStore` in `src/services/fileJobStore.js`, satisfying `JobStore` above:

```js
export class FileJobStore {
  constructor({ dir }) { ... }   // dir: directory to store one JSON file per job
  create(job) { ... }            // atomic-writes <dir>/<job.id>.json, caches in memory
  get(id) { ... }                // reads from the in-memory cache (hydrated at construction)
  update(id, patch) { ... }      // merges + atomic-rewrites <dir>/<id>.json, updates cache
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

**Atomic writes: temp file + rename, not a direct write.** Every `create`/`update` writes
to `<dir>/<id>.json.tmp` via `fs.writeFileSync`, then `fs.renameSync(tmpPath, finalPath)`.
`rename()` on the same filesystem/volume is atomic on both POSIX and NTFS — a concurrent
reader (or the next process's own hydration pass after a crash) can only ever observe the
fully-old or fully-new file content, never a torn write. This is what makes "corrupted
file" a hydration-time concern only (a file from a version of this code that predates
atomic writes, or external tampering) rather than something a normal crash can produce.

**In-memory cache, not read-through disk.** `get()`/`list()` read from a `Map` populated
once at construction (`hydrate()`: `fs.readdirSync(dir)` + `fs.readFileSync` per
`*.json` file — `*.tmp` files are ignored, since a leftover one only means a crash
happened between the temp write and the rename, and the pre-rename final file, if any,
is still the last good state). `create()`/`update()`/`delete()` write through to both
disk and the cache. This keeps read-path performance identical to `InMemoryJobStore` —
`jobManager.js` calls `store.list()` inside `_trimHistory()` on every job settlement, and
that must not become an O(n) disk read on every job completion.

**A separate directory from `workspace/`, not reused.** `workspace/jobs/<id>/metadata.json`
is `ADR-0001`'s best-effort *mirror*, explicitly never authoritative
(`docs/FOUNDATION_FREEZE.md`: *"`JobManager` is the single source of truth for job
state... Persistence layers (e.g. the workspace layer) mirror it; they do not replace
it"*). Writing `FileJobStore`'s files into the same directory would blur that
distinction. New config field `jobStoreDir` (env `CLAUDE_DELEGATE_JOB_STORE_DIR`, default
`<project>/job-store`) keeps them visibly separate. `isValidJobId()` (already exported
from `workspaceManager.js`) is reused here too — same UUID-before-path-join discipline
`ADR-0001`'s Security model established, applied to a second location.

**Opt-in via config, default unchanged.** New config field `jobStore` (env
`CLAUDE_DELEGATE_JOB_STORE`, default `"memory"`, accepts `"memory"` or `"file"` — named
after the mechanism, not the category, so a future `"sqlite"` value is additive to the
same field rather than redefining what an existing value means). `mcpServer.js`'s
`JobManager` construction picks `new FileJobStore({dir: config.jobStoreDir})` only when
`config.jobStore === "file"`; otherwise unchanged (`new InMemoryJobStore()`,
`JobManager`'s own default). Additive per `docs/FOUNDATION_FREEZE.md`'s Compatibility
guarantees (*"Adding a `DelegateConfig` field with a safe default is backward
compatible"*) — zero behavior change for any existing deployment unless the operator
explicitly sets the new env var.

## Storage format and versioning

Each job file's JSON shape: `{ storeVersion: 1, job: <Job> }` — the job record is
nested under a `job` key, not spread at the top level, specifically so a future format
change (e.g. adding a checksum, or wrapping multiple jobs per file) can add sibling keys
to the envelope without colliding with any field `models/job.js`'s `Job` shape might add
later. `storeVersion` is *this storage format's* version, independent of
`package.json`/`FOUNDATION_FREEZE.md`'s versioning — the same separation of concerns
`ADR-0002` already established for `RuntimeEvent.version`. Frozen at `1` for this ADR; a
future breaking change to the on-disk shape bumps it and hydration branches on the value
it reads. No migration-between-versions logic is written now (see Explicitly out of
scope) — the field's entire job this sprint is to make a *future* migration possible to
write at all, by ensuring every file unambiguously declares which format it's in.

## Startup recovery semantics (deterministic, specified)

`hydrate()` (called once, synchronously, from `FileJobStore`'s constructor):
1. If `dir` doesn't exist, create it (`fs.mkdirSync(dir, {recursive: true})`) and return
   with an empty cache — this is the first-run case, not an error.
2. `fs.readdirSync(dir)`, filter to `*.json` (excludes any leftover `*.tmp` from a
   crash-during-write, per the Decision above).
3. For each file, in the order `readdirSync` returns them (filesystem-dependent,
   deliberately not sorted — order here has no semantic meaning since `list()`'s callers
   never rely on store-returned order, matching `InMemoryJobStore.list()`'s own
   `[...this.jobs.values()]`, whose order is JS `Map` insertion order, not sorted either):
   - Parse; if `JSON.parse` throws or `storeVersion` is missing/unrecognized, log at
     `warn` and skip this file entirely (matches `ADR-0001`'s fail-safe precedent — never
     throw, never crash the server over one bad file).
   - **If the recovered job's `status` is non-terminal** (`queued`, `starting`, or
     `running` — `TERMINAL_STATUSES` from `models/job.js` defines terminal), it is
     rewritten in place as `failed` with `error: "process restarted before job completed"`
     and `finishedAt` set to the current hydration time, **before** being added to the
     cache. Rationale: there is no live subprocess to ever complete this job after a
     restart; reporting it as still `running` would be an observably false, permanently-
     stuck state for any caller polling `delegate_status`, and any in-process
     `waitForCompletion()` waiter from before the restart is gone anyway (waiters are
     never persisted — they're an in-memory `Map` of resolver functions). Terminal jobs
     (`completed`/`failed`/`cancelled`) are loaded unchanged — they are already correct.
4. The cache (`Map<id, Job>`) is now the store's read path for the remainder of the
   process's life, exactly as described in Decision above.

This is deterministic: the same directory contents always produce the same recovered
state, and non-terminal jobs never survive a restart as anything other than `failed`.

## Migration path

**Memory → file (turning persistence on):** flip `CLAUDE_DELEGATE_JOB_STORE=file` (and
optionally `CLAUDE_DELEGATE_JOB_STORE_DIR`) and restart. There is no data to carry over
from the old `InMemoryJobStore` — by definition, nothing written there ever survived a
restart before this ADR, so "migrating" existing in-memory history is not a real
requirement; the very first job submitted after the flag flips is the first one ever
persisted. Not a gap — an accurate description of what "in-memory" already meant.

**File → memory (turning persistence off):** flip the flag back (or unset it) and
restart. Existing `*.json` files under `jobStoreDir` are left untouched on disk — nothing
deletes them — but are no longer read; `delegate_history` reverts to showing only jobs
submitted since the restart, same as it always did under the default. An operator who
wants the old on-disk history back can flip the flag on again against the same directory.

**File → a future backend (e.g. SQLite, once it exists):** not built by this ADR (see
Explicitly out of scope), but the path this ADR enables: a future `SqliteJobStore` reads
`storeVersion`-tagged files the same way `FileJobStore.hydrate()` does and imports them
once, or a one-off migration script does the same — made possible specifically because
every file self-declares its format via `storeVersion`, per Storage format above.

## Explicitly out of scope this sprint

- Any backend other than flat files — no SQLite, PostgreSQL, Redis, or S3 implementation.
  This ADR builds `FileJobStore` only; the interface is designed so those can be added
  later without touching `JobManager` (see Public contract), but none are built now.
- Any automated migration tool/script between store backends (memory→file needs none, as
  described above; file→future-backend is deferred until a second backend actually
  exists to migrate to).
- `storeVersion` migration/upgrade logic for a *future* format change — only the version
  field itself, and hydration's ability to reject an unrecognized version safely, are
  built now. Writing the actual upgrade path happens when a version 2 format is proposed.
- Compaction, vacuuming, or any cleanup beyond what `JobManager._trimHistory()`'s existing
  eviction already triggers via `delete()`.
- Encryption at rest, file permissions hardening beyond the process's own default umask,
  or any multi-process/distributed access pattern — single-process assumption, unchanged
  from every other component in this codebase (`docs/releases/KNOWN_LIMITATIONS.md`'s
  "Current scope boundaries").
- Live verification that this survives a real, uncontrolled process kill (`SIGKILL`) mid-
  write on the actual host OS/filesystem — the atomic-rename mechanism is a standard,
  well-understood guarantee, but this ADR's testing plan (below) verifies it via a
  deliberate, controlled restart, not a fuzzed kill-signal experiment. Flagging this the
  same way `ADR-0004` flagged live MCP-host verification as a separate, deliberately-
  scheduled concern rather than something to guess at.

## Failure handling

Matching `ADR-0001`'s precedent for the workspace layer: a `FileJobStore` write failure
(disk full, permissions) must never surface as a tool-call error or crash the process,
since `JobManager`'s in-memory correctness must not depend on the disk succeeding. Each
write is wrapped; a failure is logged and the in-memory cache is still updated (so the
running process behaves exactly as `InMemoryJobStore` would for the remainder of that
run) — the durability guarantee this ADR adds is "survives an intentional/graceful
restart," not "impervious to disk failure," which was never a real requirement here (no
other component in this codebase makes that stronger claim either).

## Testing plan

Unit: each of the 5 methods against a real temp directory (not mocked `fs`, matching
`workspaceManager.test.js`'s existing style) — create writes the expected file (verify via
the temp-then-rename sequence leaves no `.tmp` file behind on success) and returns the
job; update merges correctly and rewrites atomically; list/get reflect the current cache;
delete removes both file and cache entry; hydration at construction correctly rebuilds
the cache from an existing directory of files; a corrupted/unparseable file, and a file
with a missing/unrecognized `storeVersion`, are both skipped and logged during hydration,
not thrown; **a non-terminal job (`running`) found during hydration is rewritten to
`failed` with the documented error message** — the core startup-recovery property, tested
directly, not assumed; `isValidJobId()` rejects a non-UUID id before any path is
constructed from it (security regression test, mirroring `workspaceManager.test.js`'s
equivalent). Integration: a full `JobManager` instance constructed with
`{store: new FileJobStore(...)}` runs a real job lifecycle end-to-end, then a **second**
`JobManager`/`FileJobStore` pair constructed against the same directory sees the
completed job via `listJobs()` — the actual "survives a restart" property, proven, not
assumed. A second integration test kills the first `JobManager` mid-job (never lets it
reach a terminal state) and confirms the second instance's hydration recovers it as
`failed`, not stuck `running`.

## Compatibility impact

None on any `docs/FOUNDATION_FREEZE.md` guarantee. Zero MCP schema change. Two new
optional config fields (`jobStore`, `jobStoreDir`), both defaulting to today's exact
behavior. `jobManager.js` gains one JSDoc type-annotation change (`JobStore` instead of
`InMemoryJobStore`) and no behavior change; no MCP tool handler changes.

## Alternatives considered

- **SQLite** (`better-sqlite3` or similar): rejected — a new production dependency for a
  workload (≤`maxHistory` records, synchronous access, single process) that flat files
  already serve without one. `docs/FOUNDATION_FREEZE.md`'s own Extension points note names
  SQLite only as an illustrative example, not a requirement. Left open as a future
  `JobStore` implementation, not foreclosed by this ADR (see Public contract).
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
- **Direct `writeFileSync` to the final path (no temp-file/rename)**: rejected after the
  architecture review — cheaper (one syscall instead of write+rename) but leaves a window
  where a crash mid-write produces a torn, unparseable file, silently losing that job's
  last update. The atomic-rename approach costs one extra syscall per write in exchange
  for a structural guarantee instead of a best-effort one.
- **Reporting a recovered non-terminal job's status unchanged (e.g., still `running`)**:
  rejected — this would be an observably false state with no path to ever resolve (no
  subprocess exists to complete it), and any `waitForCompletion()`-style caller would hang
  forever. Marking it `failed` on recovery is honest and matches how a real crash is
  reported in every other path this codebase has (`_run()`'s own `catch` block).
