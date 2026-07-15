# Persistent Job Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** implement `FileJobStore`, a file-backed, restart-durable implementation of the
`JobStore` interface, integrated behind an opt-in config flag with the default behavior
(in-memory) completely unchanged.

**Architecture:** per `docs/adr/ADR-0005-persistent-job-store.md` (frozen, approved,
read it first — this plan implements it, it does not re-derive it). One JSON file per
job under a new `jobStoreDir`, atomic writes (temp file + rename), an in-memory read
cache hydrated at construction, non-terminal jobs recovered as `failed` on hydration.

**Tech Stack:** Node.js (ESM), `node:test`, `node:fs`, `node:path` — no new dependencies.

## Global Constraints

- No architecture changes beyond ADR-0005 — if an implementer hits a decision ADR-0005
  doesn't cover, stop and ask; do not improvise a new design.
- Zero MCP schema change. Zero change to `JobManager`'s public method signatures.
- Default behavior (no env vars set) must be byte-for-byte unchanged at every task
  boundary — `npm test` must pass with 0 failures after every single task, not just at
  the end.
- No new production dependencies — `node:fs`/`node:path`/`node:crypto` only.
- Every write is synchronous (`*Sync` fs calls) — `jobManager.js` calls store methods
  unawaited; an async store would silently break durability. Do not introduce `await`
  anywhere in `FileJobStore`'s public methods.
- Match existing code style: dependency-injection-via-default-parameter (see
  `jobManager.js`, `entry.js`), real `fs`/temp directories in tests (not mocked), one
  clear responsibility per file.
- Commit only the specific files each task actually touches — never `git add -A` or `.`.
  Do not amend or rebase.
- Each task must leave the repository in a state where `main` could merge it alone —
  no task depends on a later task's code to compile or pass tests, only on an earlier
  task's.

---

## Task 0: Introduce the `JobStore` interface (no behavior change)

**Objective:** make the storage interface `docs/FOUNDATION_FREEZE.md` already named
("a 4-method interface") an explicit, documented JSDoc type, and point `jobManager.js`'s
own type annotation at it instead of the concrete `InMemoryJobStore` class. Zero runtime
behavior change — this is a documentation/type-annotation task only.

**Files:**
- Modify: `src/services/jobStore.js`
- Modify: `src/services/jobManager.js:16` (the constructor's JSDoc `@param` line only)

**Public interfaces affected:**
- Produces: `JobStore` — a JSDoc `@typedef` exported from `jobStore.js`, referenced via
  `import("./jobStore.js").JobStore` from any other file's JSDoc. This is what every
  later task's store implementation is documented against.

- [ ] **Step 1: Add the `JobStore` typedef to `jobStore.js`**

Open `src/services/jobStore.js`. Its current content:

```js
/**
 * Minimal storage interface for Job records. In-memory today; a future persistent store
 * (e.g. SQLite) can implement the same four methods and be swapped in via JobManager's
 * `store` dependency — no changes needed elsewhere.
 */
export class InMemoryJobStore {
```

Replace the file's header comment and class declaration with:

```js
/**
 * @typedef {Object} JobStore
 * @property {(job: import("../models/job.js").Job) => import("../models/job.js").Job} create
 * @property {(id: string) => import("../models/job.js").Job | undefined} get
 * @property {(id: string, patch: Partial<import("../models/job.js").Job>) => import("../models/job.js").Job | undefined} update
 * @property {() => import("../models/job.js").Job[]} list
 * @property {(id: string) => boolean} delete
 */

/**
 * In-memory implementation of {@link JobStore}. See
 * docs/adr/ADR-0005-persistent-job-store.md for `FileJobStore`, a restart-durable
 * alternative implementing the same interface — swapped in via `JobManager`'s `store`
 * dependency, no changes needed elsewhere.
 * @implements {JobStore}
 */
export class InMemoryJobStore {
```

Everything else in the file (the class body) is unchanged.

- [ ] **Step 2: Point `jobManager.js`'s JSDoc at the new type**

In `src/services/jobManager.js`, line 16 currently reads:

```js
  /** @param {{store?: InMemoryJobStore, maxConcurrent?: number, maxHistory?: number, logger?: object, bus?: ReturnType<typeof createRuntimeEventBus>}} [opts] */
```

Change `store?: InMemoryJobStore` to `store?: import("./jobStore.js").JobStore`:

```js
  /** @param {{store?: import("./jobStore.js").JobStore, maxConcurrent?: number, maxHistory?: number, logger?: object, bus?: ReturnType<typeof createRuntimeEventBus>}} [opts] */
```

No other line in `jobManager.js` changes. It still imports and constructs
`InMemoryJobStore` as its default value (line 4 and line 18) — this task changes what the
*type* is documented as, not what the *default instance* is.

- [ ] **Step 3: Run the full suite to confirm zero behavior change**

Run: `npm test`

Expected: same pass count as `main`'s current HEAD (185/185 as of this plan's writing —
if the count differs, something other than this task's doc-only edit changed behavior;
stop and investigate before proceeding). No new test is written for this task — there is
no new runtime behavior to assert against; the existing suite passing unchanged **is**
the verification.

- [ ] **Step 4: Commit**

```bash
git add src/services/jobStore.js src/services/jobManager.js
git commit -m "Introduce the JobStore interface as an explicit JSDoc type

jobManager.js's own constructor JSDoc typed its store parameter as the
concrete InMemoryJobStore class, not an abstraction -- found during
ADR-0005's architecture review. Adds a JobStore typedef to jobStore.js
(the same shape FOUNDATION_FREEZE.md already named informally) and
points jobManager.js's annotation at it instead.

Zero behavior change: jobManager.js still imports and defaults to
InMemoryJobStore; only the documented type changed. Full suite
unchanged (185/185).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm zero lines of executable logic changed (diff
should be entirely inside `/** ... */` comments), and that `npm test`'s pass count is
identical to pre-task `main`.

**Rollback strategy:** `git revert` the single commit — pure doc/type-annotation change,
no data or state to reconcile, safe to revert at any time independent of later tasks
(later tasks' code still runs correctly even if `jobManager.js`'s JSDoc reverts to typing
`store` as `InMemoryJobStore`, since JSDoc types are non-enforcing annotations, not
runtime checks).

---

## Task 1: Implement `FileJobStore` (unit tests first, no integration)

**Objective:** implement the file-backed `JobStore`, fully unit-tested in isolation
against real temp directories. `JobManager` is not touched in this task — `FileJobStore`
is constructed directly by its own tests only.

**Files:**
- Create: `src/services/fileJobStore.js`
- Create: `tests/fileJobStore.test.js`

**Public interfaces affected:**
- Consumes: `JobStore` (Task 0), `isValidJobId` from `src/services/workspaceManager.js`
  (already exported, unchanged).
- Produces: `FileJobStore` class, `export class FileJobStore { constructor({dir, logger}) }`
  implementing `create(job)`, `get(id)`, `update(id, patch)`, `list()`, `delete(id)` —
  exact same signatures as `InMemoryJobStore`. Later tasks (2, 3) import this class by
  name from `../services/fileJobStore.js`.

**Deliberately deferred to Task 3 (do not implement here):** hydration is intentionally
*naive* in this task — it assumes every `*.json` file under `dir` is well-formed. Do not
add try/catch around `JSON.parse` and do not add non-terminal-job recovery logic; Task 3
adds both, each with its own RED→GREEN cycle proving they're needed.

- [ ] **Step 1: Write the failing tests**

Create `tests/fileJobStore.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createJob } from "../src/models/job.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function freshDir() {
  return join(root, `store-${Math.random().toString(36).slice(2)}`);
}

const ID_A = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";
const ID_B = "7a1c9e2d-4b3f-4a5e-9c1d-2f6b8a0e5d4c";

test("create() writes a JSON file and returns the job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  const job = createJob(ID_A, { tool: "delegate_task" });

  const result = store.create(job);

  assert.deepEqual(result, job);
  const filePath = join(dir, `${ID_A}.json`);
  assert.ok(existsSync(filePath));
  const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(onDisk.storeVersion, 1);
  assert.deepEqual(onDisk.job, job);
  // no leftover temp file after a successful write
  assert.equal(existsSync(`${filePath}.tmp`), false);
});

test("get() returns a created job by id, undefined for an unknown id", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  const job = createJob(ID_A);
  store.create(job);

  assert.deepEqual(store.get(ID_A), job);
  assert.equal(store.get(ID_B), undefined);
});

test("update() merges a patch, rewrites the file, and returns the updated job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));

  const updated = store.update(ID_A, { status: "completed", exitCode: 0 });

  assert.equal(updated.status, "completed");
  assert.equal(updated.exitCode, 0);
  assert.equal(store.get(ID_A).status, "completed");
  const onDisk = JSON.parse(readFileSync(join(dir, `${ID_A}.json`), "utf8"));
  assert.equal(onDisk.job.status, "completed");
});

test("update() on an unknown id returns undefined and writes nothing", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });

  assert.equal(store.update(ID_A, { status: "completed" }), undefined);
  assert.equal(existsSync(join(dir, `${ID_A}.json`)), false);
});

test("list() returns every created job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));
  store.create(createJob(ID_B));

  const ids = store.list().map((j) => j.id).sort();
  assert.deepEqual(ids, [ID_A, ID_B].sort());
});

test("delete() removes both the file and the cache entry, returns true; false for unknown id", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));

  assert.equal(store.delete(ID_A), true);
  assert.equal(store.get(ID_A), undefined);
  assert.equal(existsSync(join(dir, `${ID_A}.json`)), false);
  assert.equal(store.delete(ID_A), false);
});

test("constructor creates dir if it doesn't exist yet, hydrates empty cache", () => {
  const dir = freshDir();
  assert.equal(existsSync(dir), false);

  const store = new FileJobStore({ dir });

  assert.ok(existsSync(dir));
  assert.deepEqual(store.list(), []);
});

test("constructor hydrates its cache from an existing directory of well-formed job files", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  first.create(createJob(ID_A));
  first.create(createJob(ID_B));

  const second = new FileJobStore({ dir });

  const ids = second.list().map((j) => j.id).sort();
  assert.deepEqual(ids, [ID_A, ID_B].sort());
});

test("isValidJobId is enforced before any path is constructed from an id", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });

  assert.throws(() => store.create({ ...createJob(ID_A), id: "../../etc/passwd" }));
  assert.throws(() => store.update("../../etc/passwd", { status: "completed" }));
});

test("a write failure is caught, logged via logger.warn, and does not throw", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  // Force the exact .tmp path _write() targets to already exist as a directory, so
  // writeFileSync(tmpPath, ...) fails with EISDIR -- a deterministic, portable way to
  // trigger a real fs write failure without relying on permission bits (unreliable on
  // Windows, this project's primary dev platform).
  mkdirSync(join(dir, `${ID_A}.json.tmp`));
  const warnings = [];
  const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };
  const store = new FileJobStore({ dir, logger });

  assert.doesNotThrow(() => store.create(createJob(ID_A)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /write failed/i);
  assert.equal(warnings[0].meta.jobId, ID_A);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fileJobStore.test.js`

Expected: FAIL — `Cannot find module '../src/services/fileJobStore.js'` (the file
doesn't exist yet).

- [ ] **Step 3: Implement `FileJobStore`**

Create `src/services/fileJobStore.js`:

```js
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isValidJobId } from "./workspaceManager.js";

const STORE_VERSION = 1;
const JSON_EXT = ".json";

/**
 * File-backed implementation of {@link import("./jobStore.js").JobStore} — one JSON file
 * per job under `dir`, atomic writes (temp file + rename, never a direct write to the
 * final path), an in-memory cache hydrated once at construction so get()/list() never
 * touch disk on the read path. See docs/adr/ADR-0005-persistent-job-store.md for the
 * full design rationale, including why hydration in *this* file is intentionally naive
 * (no corrupted-file handling, no non-terminal-job recovery) -- see
 * docs/services/fileJobStore.js's own Task 3 addendum once that lands.
 * @implements {import("./jobStore.js").JobStore}
 */
export class FileJobStore {
  /** @param {{dir: string, logger?: {warn: Function}}} opts */
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger;
    /** @type {Map<string, import("../models/job.js").Job>} */
    this.cache = new Map();
    this._hydrate();
  }

  /** @param {string} id @returns {string} */
  _pathFor(id) {
    if (!isValidJobId(id)) {
      throw new Error(`Refusing to build a job-store path from an invalid job id: ${id}`);
    }
    return join(this.dir, `${id}${JSON_EXT}`);
  }

  _hydrate() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      return;
    }
    for (const filename of readdirSync(this.dir)) {
      if (!filename.endsWith(JSON_EXT)) continue;
      const id = filename.slice(0, -JSON_EXT.length);
      if (!isValidJobId(id)) continue;
      const raw = JSON.parse(readFileSync(join(this.dir, filename), "utf8"));
      this.cache.set(id, raw.job);
    }
  }

  /** @param {import("../models/job.js").Job} job */
  _write(job) {
    const finalPath = this._pathFor(job.id);
    const tmpPath = `${finalPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify({ storeVersion: STORE_VERSION, job }), "utf8");
      renameSync(tmpPath, finalPath);
    } catch (err) {
      this.logger?.warn("FileJobStore write failed", { jobId: job.id, message: err.message });
    }
  }

  /** @param {import("../models/job.js").Job} job */
  create(job) {
    this.cache.set(job.id, job);
    this._write(job);
    return job;
  }

  /** @param {string} id */
  get(id) {
    return this.cache.get(id);
  }

  /** @param {string} id @param {Partial<import("../models/job.js").Job>} patch */
  update(id, patch) {
    const job = this.cache.get(id);
    if (!job) return undefined;
    const updated = { ...job, ...patch };
    this.cache.set(id, updated);
    this._write(updated);
    return updated;
  }

  list() {
    return [...this.cache.values()];
  }

  /** @param {string} id */
  delete(id) {
    if (!this.cache.has(id)) return false;
    this.cache.delete(id);
    try {
      unlinkSync(this._pathFor(id));
    } catch {
      // already gone -- delete() is idempotent, matching workspaceManager.pruneWorkspaces()'s
      // force-unlink precedent (ADR-0001).
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fileJobStore.test.js`

Expected: all 10 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: 195/195 (185 pre-existing + 10 new).

- [ ] **Step 6: Commit**

```bash
git add src/services/fileJobStore.js tests/fileJobStore.test.js
git commit -m "Implement FileJobStore: file-backed JobStore, unit-tested in isolation

One JSON file per job under a caller-supplied directory, atomic writes
(temp file + rename -- a crash mid-write can never produce a torn
file), an in-memory cache hydrated once at construction so get()/list()
never touch disk. Write failures are caught and logged, never thrown --
matching ADR-0001's fail-safe precedent for the workspace layer.

Hydration is intentionally naive in this commit: it assumes every file
is well-formed. Corrupted-file handling and non-terminal-job recovery
are Task 3's job, each with its own failing-test-first cycle -- adding
them here would mean this task's own tests can't prove they're needed.

Not yet wired into JobManager (Task 2).

10 new tests, 195/195 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm every `FileJobStore` method matches `JobStore`'s
signature exactly (Task 0's typedef); confirm no `await`/`async` anywhere in the class;
confirm the write-failure test actually forces a real `fs` error (not a stub) and that
`create()` doesn't throw through it; confirm no file in this task imports
`JobManager`/`mcpServer.js` (this task must not integrate anything yet).

**Rollback strategy:** delete `src/services/fileJobStore.js` and
`tests/fileJobStore.test.js`, `git revert` the commit. Nothing else in the repository
references `FileJobStore` yet (Task 2 is what wires it in) — safe, isolated revert.

---

## Task 2: Integrate `FileJobStore` with `JobManager` behind the config flag

**Objective:** wire `FileJobStore` into the server as an opt-in alternative to
`InMemoryJobStore`, selected by a new config flag. Default (`memory`) behavior is
byte-for-byte unchanged.

**Files:**
- Modify: `src/config/index.js`
- Modify: `src/server/mcpServer.js`
- Test: `tests/mcpServer.test.js` (new file — `mcpServer.js` currently has zero direct
  test coverage of its own; it's exercised indirectly via other tests and MCP Inspector)
- Test: `tests/fileJobStoreIntegration.test.js` (new file)

**Interfaces:**
- Consumes: `FileJobStore` (Task 1), `InMemoryJobStore` (existing, unchanged),
  `JobManager` (existing, unchanged — constructed with a `store` option exactly as it
  already supports).
- Produces: `selectJobStore(config, logger)` — exported from `src/server/mcpServer.js`,
  `(config: DelegateConfig, logger?) => JobStore`. Extracted specifically so the
  store-selection logic is unit-testable without spinning up a full `McpServer` (the
  same reason `entry.js` extracted `registerShutdownHandlers` in the prior sprint —
  `createMcpServer()` returns only the `McpServer` instance, never its internal
  `jobManager`, so there is no other way to observe which store class got selected
  without this extraction).

- [ ] **Step 1: Write the failing tests**

Create `tests/mcpServer.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectJobStore } from "../src/server/mcpServer.js";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { loadConfig } from "../src/config/index.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-mcpserver-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("selectJobStore returns InMemoryJobStore for the default config", () => {
  const config = loadConfig({});
  assert.ok(selectJobStore(config) instanceof InMemoryJobStore);
});

test("selectJobStore returns InMemoryJobStore when jobStore is explicitly 'memory'", () => {
  const config = { ...loadConfig({}), jobStore: "memory" };
  assert.ok(selectJobStore(config) instanceof InMemoryJobStore);
});

test("selectJobStore returns a FileJobStore backed by config.jobStoreDir when jobStore is 'file'", () => {
  const dir = join(root, "store-a");
  const config = { ...loadConfig({}), jobStore: "file", jobStoreDir: dir };
  const store = selectJobStore(config);
  assert.ok(store instanceof FileJobStore);
  assert.equal(store.dir, dir);
});
```

Create `tests/fileJobStoreIntegration.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { FileJobStore } from "../src/services/fileJobStore.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-integration-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("JobManager with a FileJobStore runs a full job lifecycle and persists it to disk", async () => {
  const dir = join(root, "store-a");
  const manager = new JobManager({ store: new FileJobStore({ dir }) });

  const id = manager.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: true };
  });
  const job = await manager.waitForCompletion(id);

  assert.equal(job.status, "completed");
  assert.deepEqual(job.result, { ok: true });
  assert.equal(manager.getJob(id).status, "completed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/mcpServer.test.js tests/fileJobStoreIntegration.test.js`

Expected: FAIL — `selectJobStore` is not exported from `mcpServer.js` yet (the
`fileJobStoreIntegration.test.js` file should already pass once Task 1 lands, since it
only exercises `JobManager` + `FileJobStore` directly with no new production code needed
— confirm this: if it fails, something is wrong with Task 1's `FileJobStore`, not this
task).

- [ ] **Step 3: Add the two new config fields**

In `src/config/index.js`, add after `const DEFAULT_WORKSPACE_ROOT = ...` (line 17):

```js
const DEFAULT_JOB_STORE_DIR = join(PROJECT_ROOT, "job-store");
```

Add to the `DelegateConfig` typedef (after the `@property {number} maxWorkspaceHistory`
line):

```js
 * @property {"memory"|"file"} jobStore
 * @property {string} jobStoreDir
```

Add to `loadConfig()`'s returned object (after the `maxWorkspaceHistory` line):

```js
    jobStore: env.CLAUDE_DELEGATE_JOB_STORE || "memory",
    jobStoreDir: env.CLAUDE_DELEGATE_JOB_STORE_DIR || DEFAULT_JOB_STORE_DIR,
```

- [ ] **Step 4: Add `selectJobStore` and wire it into `createMcpServer`**

In `src/server/mcpServer.js`, add to the imports (after the `JobManager` import):

```js
import { InMemoryJobStore } from "../services/jobStore.js";
import { FileJobStore } from "../services/fileJobStore.js";
```

Add this exported function before `createMcpServer`:

```js
/**
 * Picks the JobStore implementation per config.jobStore. Extracted as its own exported
 * function so it's unit-testable without constructing a full McpServer, which returns
 * only the server instance and never exposes its internal JobManager/store.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{warn: Function}} [logger]
 * @returns {import("../services/jobStore.js").JobStore}
 */
export function selectJobStore(config, logger) {
  if (config.jobStore === "file") {
    return new FileJobStore({ dir: config.jobStoreDir, logger });
  }
  return new InMemoryJobStore();
}
```

Change the `jobManager` construction (currently):

```js
  const jobManager = new JobManager({
    maxConcurrent: config.maxConcurrentJobs,
    maxHistory: config.maxJobHistory,
    logger,
    bus,
  });
```

to:

```js
  const jobManager = new JobManager({
    store: selectJobStore(config, logger),
    maxConcurrent: config.maxConcurrentJobs,
    maxHistory: config.maxJobHistory,
    logger,
    bus,
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/mcpServer.test.js tests/fileJobStoreIntegration.test.js`

Expected: all 4 new tests pass (3 in `mcpServer.test.js`, 1 in
`fileJobStoreIntegration.test.js`).

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: 199/199 (195 from Task 1 + 4 new).

- [ ] **Step 7: Verify default behavior is unchanged via MCP Inspector**

Run: `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`

Expected: same 6 tools, unchanged — proves the default (`jobStore` unset →
`InMemoryJobStore`) path through `createMcpServer` still boots identically to before this
task.

- [ ] **Step 8: Commit**

```bash
git add src/config/index.js src/server/mcpServer.js tests/mcpServer.test.js tests/fileJobStoreIntegration.test.js
git commit -m "Wire FileJobStore into JobManager behind a config flag, default unchanged

New config fields jobStore (env CLAUDE_DELEGATE_JOB_STORE, default
'memory') and jobStoreDir (env CLAUDE_DELEGATE_JOB_STORE_DIR, default
<project>/job-store). selectJobStore() -- exported from mcpServer.js
specifically so it's unit-testable without constructing a full
McpServer -- picks FileJobStore only when jobStore==='file'; every
existing deployment continues getting InMemoryJobStore exactly as
before.

Verified via MCP Inspector that the default path still boots
identically to pre-task main.

4 new tests, 199/199 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm `config.jobStore`/`jobStoreDir` both have safe
defaults matching pre-task behavior exactly; confirm `selectJobStore` is the *only* new
code path that constructs a `FileJobStore` in production code (no other call site);
confirm the Inspector check was actually run, not assumed.

**Rollback strategy:** `git revert` the commit. `jobManager.js`/`FileJobStore` are
unaffected (Task 1's file stands alone); reverting this commit simply removes the wiring
and the two config fields, returning `mcpServer.js` to unconditionally constructing
`InMemoryJobStore` via `JobManager`'s own default.

---

## Task 3: Startup hydration and recovery (hardening)

**Objective:** harden `FileJobStore._hydrate()` with the two properties ADR-0005
requires: a corrupted/unparseable file must never crash the server, and a non-terminal
job recovered from a crash must be deterministically marked `failed` (there is no live
subprocess left to ever complete it).

**Files:**
- Modify: `src/services/fileJobStore.js`
- Test: `tests/fileJobStore.test.js` (append new cases to the same file Task 1 created)

**Interfaces:**
- Consumes: `TERMINAL_STATUSES`, `JOB_STATUS` from `src/models/job.js` (existing,
  unchanged).
- Produces: no new exports — `FileJobStore`'s public method signatures are unchanged;
  only `_hydrate()`'s internal behavior gains the two properties above.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fileJobStore.test.js` (add this import to the existing import block at
the top of the file: `import { JOB_STATUS } from "../src/models/job.js";`):

```js
test("a corrupted (unparseable) job file is skipped during hydration, logged, and never crashes the constructor", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json`), "{ not valid json");
  const warnings = [];
  const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };

  const store = new FileJobStore({ dir, logger });

  assert.deepEqual(store.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /corrupted|unparseable/i);
});

test("a job file with a missing or unrecognized storeVersion is skipped during hydration", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json`), JSON.stringify({ storeVersion: 99, job: createJob(ID_A) }));
  const store = new FileJobStore({ dir });

  assert.deepEqual(store.list(), []);
});

test("a non-terminal job (running) recovered at hydration is rewritten to failed, deterministically, and the rewrite is persisted", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  const job = createJob(ID_A);
  first.create(job);
  first.update(ID_A, { status: JOB_STATUS.RUNNING, startedAt: new Date().toISOString() });

  const second = new FileJobStore({ dir });

  const recovered = second.get(ID_A);
  assert.equal(recovered.status, JOB_STATUS.FAILED);
  assert.equal(recovered.error, "process restarted before job completed");
  assert.ok(recovered.finishedAt);
  // the rewrite itself is durable -- a third instance sees the same recovered state,
  // not "running" again
  const third = new FileJobStore({ dir });
  assert.equal(third.get(ID_A).status, JOB_STATUS.FAILED);
});

test("a terminal job (completed) is loaded unchanged at hydration", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  first.create(createJob(ID_A));
  first.update(ID_A, { status: JOB_STATUS.COMPLETED, result: { ok: true } });

  const second = new FileJobStore({ dir });

  assert.equal(second.get(ID_A).status, JOB_STATUS.COMPLETED);
  assert.deepEqual(second.get(ID_A).result, { ok: true });
});

test("a leftover .tmp file from a crash mid-write is ignored during hydration, not mistaken for a job file", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json.tmp`), JSON.stringify({ storeVersion: 1, job: createJob(ID_A) }));

  const store = new FileJobStore({ dir });

  assert.deepEqual(store.list(), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/fileJobStore.test.js`

Expected: the corrupted-file test throws an uncaught `SyntaxError` out of the
constructor (proving hydration currently crashes on bad input, exactly the property
this task must fix); the non-terminal-recovery test fails because the recovered job's
status is still `"running"`, not `"failed"`.

- [ ] **Step 3: Harden `_hydrate()`**

In `src/services/fileJobStore.js`, add this import:

```js
import { TERMINAL_STATUSES, JOB_STATUS } from "../models/job.js";
```

Replace the `_hydrate()` method with:

```js
  _hydrate() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      return;
    }
    for (const filename of readdirSync(this.dir)) {
      if (!filename.endsWith(JSON_EXT)) continue;
      const id = filename.slice(0, -JSON_EXT.length);
      if (!isValidJobId(id)) continue;

      let raw;
      try {
        raw = JSON.parse(readFileSync(join(this.dir, filename), "utf8"));
      } catch (err) {
        this.logger?.warn("FileJobStore: skipping corrupted/unparseable job file at startup", {
          filename,
          message: err.message,
        });
        continue;
      }
      if (raw?.storeVersion !== STORE_VERSION || !raw.job) {
        this.logger?.warn("FileJobStore: skipping job file with missing/unrecognized storeVersion", {
          filename,
          storeVersion: raw?.storeVersion,
        });
        continue;
      }

      let job = raw.job;
      if (!TERMINAL_STATUSES.has(job.status)) {
        job = {
          ...job,
          status: JOB_STATUS.FAILED,
          error: "process restarted before job completed",
          finishedAt: new Date().toISOString(),
        };
        this._write(job); // persist the recovery so a later restart doesn't need to redo it
      }
      this.cache.set(id, job);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/fileJobStore.test.js`

Expected: all 15 tests pass (10 from Task 1 + 5 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: 204/204 (199 from Task 2 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/services/fileJobStore.js tests/fileJobStore.test.js
git commit -m "Harden FileJobStore hydration: corrupted files and non-terminal recovery

Two properties ADR-0005 requires, each proven with a failing test
first: (1) a corrupted/unparseable job file, or one with a missing or
unrecognized storeVersion, is now skipped and logged during hydration
instead of throwing out of the constructor; (2) a non-terminal job
(queued/starting/running) recovered after a crash is deterministically
rewritten to failed with a fixed error message -- there is no live
subprocess left to ever complete it, so leaving it 'running' would be
an observably false, permanently-stuck state. The rewrite is itself
persisted, so a later restart sees the recovered state directly.

5 new tests, 204/204 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm both new properties were actually RED before the
fix (re-run the pre-Step-3 test file against the pre-hardening class if there's any doubt
— the implementer's report must show real failing output, not just claim it); confirm
the non-terminal recovery rewrite is itself durable (the plan's third-instance test
checks this directly).

**Rollback strategy:** `git revert` the commit — reverts `_hydrate()` to Task 1's naive
version. This re-opens the two hardened gaps but does not break anything Task 2 already
wired in (the interface and call sites are unchanged); safe as an isolated revert if a
regression is found here specifically.

---

## Task 4: Configuration parsing and validation, backward-compatibility tests

**Objective:** add explicit validation for the two new config fields, matching
`validateConfig`'s existing fail-fast style, plus a dedicated set of tests proving
default (no-env-vars) behavior is unchanged.

**Files:**
- Modify: `src/validation/configValidation.js`
- Test: `tests/configValidation.test.js` (append to the existing file)

**Interfaces:**
- Consumes: `ConfigError` from `src/utils/errors.js` (existing, unchanged).
- Produces: no new exports — `validateConfig`'s signature is unchanged; it now also
  rejects an invalid `jobStore`/`jobStoreDir`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/configValidation.test.js`:

```js
test("validateConfig rejects an unrecognized jobStore value", () => {
  const config = { ...loadConfig({}), jobStore: "sqlite" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects an empty jobStoreDir", () => {
  const config = { ...loadConfig({}), jobStoreDir: "" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig accepts the default config with jobStore/jobStoreDir unset by the caller (loadConfig's own defaults apply)", () => {
  const config = loadConfig({});
  assert.equal(config.jobStore, "memory");
  assert.ok(config.jobStoreDir);
  assert.doesNotThrow(() => validateConfig(config));
});

test("validateConfig accepts jobStore explicitly set to 'file' with a valid jobStoreDir", () => {
  const config = { ...loadConfig({}), jobStore: "file", jobStoreDir: "/tmp/whatever" };
  assert.doesNotThrow(() => validateConfig(config));
});

test("loadConfig's defaults are backward compatible: no env vars produces the exact same jobStore/jobStoreDir as before this feature existed would have produced no fields at all -- this test pins today's default values so a future change to them is a deliberate, visible diff", () => {
  const config = loadConfig({});
  assert.equal(config.jobStore, "memory");
  assert.match(config.jobStoreDir, /job-store$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/configValidation.test.js`

Expected: the first two tests fail (`validateConfig` doesn't yet reject anything about
`jobStore`/`jobStoreDir` — `assert.throws` fails because nothing throws); the rest
already pass (Task 2 already made `loadConfig` produce these fields correctly).

- [ ] **Step 3: Add validation**

In `src/validation/configValidation.js`, add after the `maxWorkspaceHistory` check:

```js
  if (!["memory", "file"].includes(config.jobStore)) {
    problems.push('jobStore must be "memory" or "file"');
  }
  if (!config.jobStoreDir || typeof config.jobStoreDir !== "string") {
    problems.push("jobStoreDir must be a non-empty string");
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/configValidation.test.js`

Expected: all tests in the file pass (4 pre-existing + 5 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: 209/209 (204 from Task 3 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/validation/configValidation.js tests/configValidation.test.js
git commit -m "Validate jobStore/jobStoreDir, pin backward-compatible defaults

validateConfig now rejects an unrecognized jobStore value and an empty
jobStoreDir, matching its existing fail-fast style for every other
field. Added tests pin today's defaults (memory / <project>/job-store)
so any future change to them is a deliberate, visible diff rather than
a silent behavior change.

5 new tests, 209/209 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm the validation messages follow the exact style
of every other `problems.push(...)` line in the file (lowercase field name, "must be...
phrasing); confirm the backward-compatibility test actually pins concrete values (not a
vague "is truthy" check) so a future accidental default change would fail it visibly.

**Rollback strategy:** `git revert` the commit — `validateConfig` reverts to not checking
these two fields; existing valid configs are unaffected either way (this only ever
narrows what's *accepted*, so reverting only widens it back, never breaks a
config that was working under the new validation).

---

## Task 5: End-to-end integration, crash/restart/recovery, performance comparison

**Objective:** prove the whole system (not just `FileJobStore` in isolation) survives a
real restart, and produce a real, measured performance comparison against
`InMemoryJobStore` — not an estimate.

**Files:**
- Test: `tests/fileJobStoreE2E.test.js` (new file)
- Create: `scripts/benchmark-job-store.js` (not part of `npm test` — a manually-run
  measurement script, per this task's "do not estimate, use measured values" requirement)

**Interfaces:**
- Consumes: `JobManager`, `FileJobStore`, `InMemoryJobStore` — no new production code in
  this task, purely test/measurement.

- [ ] **Step 1: Write the crash/restart/recovery end-to-end test**

Create `tests/fileJobStoreE2E.test.js`:

```js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { FileJobStore } from "../src/services/fileJobStore.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-e2e-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a job abandoned mid-flight (simulated crash) is recovered as failed by a fresh JobManager+FileJobStore pair over the same directory", async () => {
  const dir = join(root, "e2e-a");
  const first = new JobManager({ store: new FileJobStore({ dir }) });

  let releaseJob;
  const stuck = new Promise((resolve) => {
    releaseJob = resolve;
  });
  const id = first.submit(async (signal, markRunning) => {
    markRunning();
    await stuck; // never resolves before the "crash" below -- simulates the process dying mid-job
    return { ok: true };
  });

  // wait for the job to actually reach "running" before simulating the crash -- bounded
  // so a real regression fails the test instead of hanging CI indefinitely
  for (let attempt = 0; first.getJob(id).status !== "running"; attempt++) {
    if (attempt >= 200) throw new Error("job never reached 'running' within 1s");
    await new Promise((r) => setTimeout(r, 5));
  }
  // "crash": no clean shutdown, no cancelJob() call -- the first JobManager is simply
  // abandoned, exactly like a killed process. releaseJob is never called.

  const second = new JobManager({ store: new FileJobStore({ dir }) });
  const recovered = second.getJob(id);

  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error, "process restarted before job completed");
  releaseJob(); // let the first JobManager's dangling promise settle so the test process can exit cleanly
});

test("a job that completed before the 'crash' is still visible after restart, unchanged", async () => {
  const dir = join(root, "e2e-b");
  const first = new JobManager({ store: new FileJobStore({ dir }) });
  const id = first.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: true };
  });
  await first.waitForCompletion(id);

  const second = new JobManager({ store: new FileJobStore({ dir }) });

  const recovered = second.getJob(id);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.result, { ok: true });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test tests/fileJobStoreE2E.test.js`

Expected: both tests pass. If the first test fails, it means Task 3's recovery logic
doesn't hold up under a *real* abandoned-job scenario (as opposed to a hand-crafted
fixture file) — stop and investigate rather than adjusting the test to fit.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: 211/211 (209 from Task 4 + 2 new).

- [ ] **Step 4: Write and run the performance comparison script**

Create `scripts/benchmark-job-store.js`:

```js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createJob } from "../src/models/job.js";
import { randomUUID } from "node:crypto";

const N = 200;

function bench(name, store) {
  const ids = Array.from({ length: N }, () => randomUUID());
  const start = process.hrtime.bigint();
  for (const id of ids) store.create(createJob(id));
  for (const id of ids) store.update(id, { status: "completed" });
  for (const id of ids) store.get(id);
  store.list();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${name}: ${N} jobs, create+update+get+list in ${elapsedMs.toFixed(2)}ms (${(elapsedMs / N).toFixed(3)}ms/job avg)`);
  return elapsedMs;
}

const memMs = bench("InMemoryJobStore", new InMemoryJobStore());

const dir = mkdtempSync(join(tmpdir(), "claude-delegate-benchmark-"));
const fileMs = bench("FileJobStore", new FileJobStore({ dir }));
rmSync(dir, { recursive: true, force: true });

console.log(`FileJobStore is ${(fileMs / memMs).toFixed(1)}x the wall-clock cost of InMemoryJobStore for this workload.`);
```

Run: `node scripts/benchmark-job-store.js`

Record the actual printed output verbatim in this task's implementer report — this
number goes into `IMPLEMENTATION_REPORT.md`'s Phase 5 metrics unmodified, not rounded or
estimated.

- [ ] **Step 5: Commit**

```bash
git add tests/fileJobStoreE2E.test.js scripts/benchmark-job-store.js
git commit -m "Add crash/restart E2E recovery tests and a measured store benchmark

Two end-to-end tests using real JobManager+FileJobStore pairs (not
hand-crafted fixture files, unlike Task 3's unit tests): a job actually
abandoned mid-flight is recovered as failed by a fresh instance over
the same directory; a job that completed before a restart is
unaffected. scripts/benchmark-job-store.js measures real wall-clock
cost (200 jobs, create+update+get+list) for both store implementations
-- run manually, output recorded verbatim in IMPLEMENTATION_REPORT.md,
not estimated.

2 new tests, 211/211 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm the E2E test's "crash" is genuine (no
`cancelJob()`, no clean shutdown call — the first `JobManager` is truly just abandoned);
confirm the benchmark script was actually executed and its real output (not a guess)
is what gets reported later.

**Rollback strategy:** both artifacts are additive test/tooling files with no production
code changed — `git revert` removes them with zero effect on any other task's code.

---

## Task 6: Documentation — CHANGELOG, README, KNOWN_LIMITATIONS, migration guide

**Objective:** reconcile canonical docs now that the feature is fully implemented and
tested. No code changes in this task.

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/releases/KNOWN_LIMITATIONS.md`
- Modify: `docs/releases/SUPPORTED_FEATURES.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a CHANGELOG entry**

Add a new top entry to `CHANGELOG.md` (version number and exact wording finalized once
Task 0-5's actual test counts are known — use the running counts this plan tracked:
211 total new/changed tests across Tasks 0-5 relative to the 185 baseline this plan
started from). Structure to match the existing 2.2.2 entry's style: a one-paragraph
sprint summary, an `### Added` section naming `FileJobStore`/`jobStore`/`jobStoreDir`,
and a `### Compatibility` section stating zero MCP schema change and the default-
unchanged guarantee, referencing `docs/adr/ADR-0005-persistent-job-store.md` for full
design detail.

- [ ] **Step 2: Update README.md**

Find README.md's configuration/environment-variables section (grep for
`CLAUDE_DELEGATE_WORKSPACE_DIR` to locate it — `jobStoreDir` documents identically).
Add `CLAUDE_DELEGATE_JOB_STORE` (default `memory`, accepts `memory`/`file`) and
`CLAUDE_DELEGATE_JOB_STORE_DIR` (default `<project>/job-store`) to that table/list,
matching its existing format exactly.

- [ ] **Step 3: Update KNOWN_LIMITATIONS.md**

In `docs/releases/KNOWN_LIMITATIONS.md`'s "Current scope boundaries" section, change:

```
- In-memory job store by default (`JobManager({store})` extension point exists but has no
  shipped persistent implementation).
```

to:

```
- In-memory job store by default; a file-backed alternative (`FileJobStore`) now exists
  and is opt-in via `CLAUDE_DELEGATE_JOB_STORE=file` (see
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md)). Still single-process/single-
  machine — no distributed store, no compaction beyond `JobManager`'s own history
  eviction.
```

Add a bullet to "Resolved since v1.0.0":

```
- **`JobManager({store})`'s extension point had no shipped persistent implementation**
  (fixed in this sprint): `FileJobStore` implements the same interface, opt-in via
  config, default behavior unchanged. See `CHANGELOG.md`'s entry and
  [ADR-0005](../adr/ADR-0005-persistent-job-store.md).
```

- [ ] **Step 4: Update SUPPORTED_FEATURES.md**

In `docs/releases/SUPPORTED_FEATURES.md`'s table, change the `Persistent job store` row
from:

```
| Persistent job store (non-in-memory) | **Deferred** | Extension point exists (`JobManager({store})`, 4-method interface), no implementation exists |
```

to:

```
| Persistent job store (non-in-memory) | **Stable, opt-in** | `FileJobStore` implements the `JobStore` interface; default remains in-memory, opt in via `CLAUDE_DELEGATE_JOB_STORE=file`. See [ADR-0005](../adr/ADR-0005-persistent-job-store.md). |
```

- [ ] **Step 5: Run the full suite (docs-only change, confirm nothing broke)**

Run: `npm test`

Expected: 211/211, unchanged from Task 5.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md docs/releases/KNOWN_LIMITATIONS.md docs/releases/SUPPORTED_FEATURES.md
git commit -m "Document FileJobStore: CHANGELOG, README, KNOWN_LIMITATIONS, SUPPORTED_FEATURES

Reconciles canonical release docs now that the persistent job store
feature (ADR-0005) is fully implemented and tested. No code change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**Expected review checkpoint:** confirm every doc change accurately reflects what was
actually built (not aspirational) — cross-check each claim against the actual merged
diff from Tasks 0-5, the same discipline `FINAL_HEALTH_REPORT.md` used in the prior
sprint.

**Rollback strategy:** `git revert` — documentation only, zero functional risk.

---

## Task 7: Full repository verification, review, ponytail audit, certification

**Objective:** verify the whole branch as a unit before merging — this is the sprint's
final quality gate, not a new task in the feature sense.

**Files:** none new — this task reads/audits the accumulated diff from Tasks 0-6.

- [ ] **Step 1: Run the full suite fresh**

Run: `npm test`

Expected: 211/211.

- [ ] **Step 2: MCP Inspector schema check**

Run: `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`

Expected: same 6 tools as every prior certification pass — this feature adds no MCP
tool and changes no schema.

- [ ] **Step 3: Dispatch the final whole-branch review**

Use `superpowers:requesting-code-review`'s template
(`../requesting-code-review/code-reviewer.md`) against the full range
`git merge-base main HEAD..HEAD`, on the most capable available model per
`subagent-driven-development`'s Model Selection guidance (this is the highest-stakes
review point of the sprint).

- [ ] **Step 4: `ponytail-review` the full diff, `ponytail-audit` the whole repo**

Both are one-shot, list-only passes (see their own skill definitions) — apply any
Critical/Important findings via `superpowers:receiving-code-review`'s verify-before-
implementing discipline before proceeding.

- [ ] **Step 5: `finishing-a-development-branch`**

Verify tests, detect environment, present the standard options (merge/PR/keep/discard),
execute the chosen option.

**Expected review checkpoint:** this task's own output *is* the review checkpoint for
the whole sprint — no further gate after it besides the user's own sign-off on the
sprint's final deliverables.

**Rollback strategy:** if the whole-branch review or ponytail passes surface a Critical
finding, do not merge — dispatch a fix subagent against the specific task whose commit
introduced it, re-run that task's own tests, then re-run this task's Steps 1-4 in full
before proceeding to Step 5.

---

## Self-review (writing-plans skill's own required check)

**Spec coverage:** every ADR-0005 section maps to a task — Public contract/`JobStore`
typedef → Task 0; `FileJobStore`'s core Decision → Task 1; config flag + `mcpServer.js`
wiring → Task 2; Startup recovery semantics → Task 3; nothing in ADR-0005 assigns
config validation its own task explicitly, but `docs/FOUNDATION_FREEZE.md`'s existing
`validateConfig` pattern requires it — Task 4; Testing plan's Integration/restart
property → Task 5; no ADR section requires README/CHANGELOG changes mid-sprint (ADR-0005
itself says doc reconciliation happens "centrally after the task lands," mirroring the
prior sprint's own stated convention) → Task 6; final gates → Task 7. No gaps found.

**Placeholder scan:** no "TBD"/"TODO" in any task; every code step has complete code;
every test step has complete test bodies; every command has an exact expected output
(including exact, incrementing test counts per task, computed by hand: 185 baseline →
195 (Task 1, +10) → 199 (Task 2, +4) → 204 (Task 3, +5) → 209 (Task 4, +5) → 211
(Task 5, +2) → 211 (Task 6, docs-only) → 211 (Task 7, verification-only)).

**Type consistency:** `FileJobStore`'s constructor (`{dir, logger}`) is identical across
Tasks 1, 2, 3, 5. `selectJobStore(config, logger)`'s signature (Task 2) matches every
call site that references it (Task 2's own tests only — no other task calls it directly).
`JobStore`'s typedef (Task 0) method signatures match `FileJobStore`'s actual
implementation (Task 1) exactly — checked field-by-field during this review.
