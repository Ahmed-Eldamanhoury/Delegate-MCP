# Persistent Event History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** implement `EventHistoryStore`, an append-only, restart-durable per-job event log,
consulted by `ReplayEngine` as a new tier between the volatile in-memory `TimelineStore` and
the coarse `workspace/metadata.json` fallback — integrated behind an opt-in config flag with
default behavior (in-memory only, today's exact `ReplayEngine` fallback chain) completely
unchanged.

**Architecture:** per `docs/adr/ADR-0006-persistent-event-history.md` (Proposed, pending
sign-off — read it first, this plan implements it, it does not re-derive it). One `.jsonl`
file per job under a new `eventHistoryDir`, append-only writes (no atomic-rewrite needed —
see ADR's Decision), `OutputChunk` events excluded (already durably owned by
`stdout.log`/`stderr.log`), no non-terminal-job recovery mutation needed (events are
immutable historical facts).

**Tech Stack:** Node.js (ESM), `node:test`, `node:fs`, `node:path` — no new dependencies.

**Do not begin implementation until `ADR-0006` and this plan are both explicitly approved.**

## Global Constraints

- No architecture changes beyond `ADR-0006` — if an implementer hits a decision the ADR
  doesn't cover, stop and ask; do not improvise a new design.
- Zero MCP schema change. Zero change to `ObservabilityService`'s public method set or
  call signatures.
- Default behavior (no env vars set) must be byte-for-byte unchanged at every task
  boundary — `npm test` must pass with 0 failures after every single task.
- No new production dependencies — `node:fs`/`node:path`/`node:crypto` only.
- `RuntimeEventBus` publishes/subscribes are synchronous; `EventHistoryStore.append()` must
  never be `async` and must never throw out of a bus subscriber (the bus already wraps
  subscribers individually, `runtimeEventBus.js:43-53`, but a well-behaved subscriber still
  shouldn't rely on that as its only safety net for a foreseeable I/O failure — catch and log
  internally, matching `FileJobStore._write()`'s own precedent).
- Match existing code style: dependency-injection-via-default-parameter, real `fs`/temp
  directories in tests (not mocked), one clear responsibility per file, reuse
  `isValidJobId()`/`getWorkspaceRoot()` conventions already established.
- Commit only the specific files each task actually touches — never `git add -A` or `.`.
  Do not amend or rebase.
- Each task must leave the repository in a state where `main` could merge it alone.

---

## Task 1: Implement `EventHistoryStore` (unit tests first, no wiring)

**Objective:** a standalone, append-only, per-job event log — `append(event)`,
`readAll(jobId)`, `has(jobId)` — built and tested in isolation, matching `FileJobStore`'s Task 1
precedent (`ADR-0005`).

**Files:**
- Create: `src/services/eventHistoryStore.js`
- Test: `tests/eventHistoryStore.test.js`

**Public interface:**
```js
export function createEventHistoryStore({ dir, logger }) {
  function append(event) { ... }
  function readAll(jobId) { ... }
  function has(jobId) { ... }
  return Object.freeze({ append, readAll, has });
}
```

- [ ] **Step 1: Write the failing tests**

Cover: `append()` creates `<dir>/<jobId>.jsonl` and writes one JSON line per call (verify via
reading the raw file, not just via `readAll()`); multiple `append()` calls for the same job
accumulate lines in call order; `readAll()` on a job with no file returns `[]`, never throws;
`readAll()` skips a corrupted/unparseable trailing line (logged via `logger.warn`, matching
`FileJobStore`'s corrupted-file message style) and still returns every line that did parse;
`has()` reflects file existence correctly (`true` after any `append()`, `false` for an unknown
job id); `append()`/`readAll()` reject/ignore a non-UUID job id before any path is constructed
from it (security regression, mirroring `FileJobStore`'s `_pathFor()`-style guard — reuse
`isValidJobId()` from `workspaceManager.js`, do not write a second validator); the directory is
created on first `append()` if it doesn't exist yet (mirroring `FileJobStore`'s constructor
behavior, but here lazily at first write, since there's no hydration step to eagerly create it
at construction — there is no in-memory cache to hydrate).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/eventHistoryStore.test.js` — expect every test to fail (module doesn't
exist yet).

- [ ] **Step 3: Implement `EventHistoryStore`**

```js
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidJobId } from "./workspaceManager.js";

/**
 * Append-only, per-job durable event log -- one JSON line per RuntimeEvent under `dir`.
 * No in-memory cache (unlike FileJobStore): reads go straight to disk, since this is a
 * cold/rare read path (replay fallback), not a hot one -- ObservabilityService's live
 * read path (getTimeline/getMetrics) never touches this file.
 * @param {{dir: string, logger?: {warn: Function}}} opts
 */
export function createEventHistoryStore({ dir, logger }) {
  function pathFor(jobId) {
    if (!isValidJobId(jobId)) {
      throw new Error(`Refusing to build an event-history path from an invalid job id: ${jobId}`);
    }
    return join(dir, `${jobId}.jsonl`);
  }

  function append(event) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(pathFor(event.jobId), JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      logger?.warn?.("eventHistoryStore: append failed", { jobId: event.jobId, message: err.message });
    }
  }

  function readAll(jobId) {
    const filePath = pathFor(jobId);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        logger?.warn?.("eventHistoryStore: skipping corrupted/unparseable event line", { jobId, message: err.message });
      }
    }
    return events;
  }

  function has(jobId) {
    return existsSync(pathFor(jobId));
  }

  return Object.freeze({ append, readAll, has });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/eventHistoryStore.test.js` — expect all tests to pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test` — expect 213 + (however many new tests Step 1 wrote), 0 failures.

- [ ] **Step 6: Commit**

```
git add src/services/eventHistoryStore.js tests/eventHistoryStore.test.js
git commit -m "Implement EventHistoryStore: append-only durable event log, unit-tested in isolation

..."
```

**Rollback strategy:** delete the two new files — nothing else references this module yet.

---

## Task 2: Wire `EventHistoryStore` into the bus behind a config flag

**Objective:** an opt-in bus subscriber (mirroring `workspaceEventBridge.js`'s shape), config
fields with validated, backward-compatible defaults.

**Files:**
- Modify: `src/config/index.js` (add `eventHistory`, `eventHistoryDir` fields)
- Modify: `src/validation/configValidation.js` (validate the two new fields, same style as
  `jobStore`/`jobStoreDir`'s checks)
- Modify: `src/server/mcpServer.js` (construct + wire `EventHistoryStore` when
  `config.eventHistory === "file"`)
- Create: `src/services/eventHistoryBridge.js` (the `wireEventHistoryToEventBus` function —
  kept separate from `eventHistoryStore.js` itself, mirroring how `workspaceEventBridge.js` is
  a separate file from `workspaceManager.js`)
- Test: `tests/configValidation.test.js` (append), `tests/mcpServer.test.js` (append),
  `tests/eventHistoryBridge.test.js` (new)

- [ ] **Step 1: Write the failing tests** — config defaults (`eventHistory: "memory"`,
  `eventHistoryDir` defaulting to `<project>/event-history`), `validateConfig` rejects an
  unrecognized `eventHistory` value and an empty `eventHistoryDir`, `wireEventHistoryToEventBus`
  calls `eventHistoryStore.append()` for every event **except** `OutputChunk`, and a construction
  helper (mirroring `selectJobStore`) that only wires the bridge when `config.eventHistory ===
  "file"`.

- [ ] **Step 2: Run to verify RED.**

- [ ] **Step 3: Implement.** `eventHistoryBridge.js`:
```js
import { EVENT_TYPES } from "../models/runtimeEvent.js";

/** @param {{bus, eventHistoryStore, logger?}} opts @returns {() => void} unsubscribe */
export function wireEventHistoryToEventBus({ bus, eventHistoryStore }) {
  return bus.subscribeAll((event) => {
    if (event.type === EVENT_TYPES.OUTPUT_CHUNK) return; // already durable via stdout.log/stderr.log
    eventHistoryStore.append(event);
  });
}
```
`config/index.js`: add `DEFAULT_EVENT_HISTORY_DIR = join(PROJECT_ROOT, "event-history")`,
`eventHistory: env.CLAUDE_DELEGATE_EVENT_HISTORY || "memory"`, `eventHistoryDir:
env.CLAUDE_DELEGATE_EVENT_HISTORY_DIR || DEFAULT_EVENT_HISTORY_DIR`. `configValidation.js`: add
the two checks matching `jobStore`/`jobStoreDir`'s exact style. `mcpServer.js`: after
`createObservabilityService(...)`, add:
```js
if (config.eventHistory === "file") {
  const eventHistoryStore = createEventHistoryStore({ dir: config.eventHistoryDir, logger });
  wireEventHistoryToEventBus({ bus, eventHistoryStore });
}
```

- [ ] **Step 4: Run to verify GREEN.**

- [ ] **Step 5: Run the full suite.**

- [ ] **Step 6: Commit.**

**Rollback strategy:** `git revert` — Task 1's file stands alone; reverting this commit removes
the wiring and two config fields, returning `mcpServer.js` to not constructing
`EventHistoryStore` at all.

---

## Task 3: Retention — cap `.jsonl` file count, oldest-completed-first

**Objective:** bound total event-history disk usage the same way `workspaceManager.pruneWorkspaces()`
bounds workspace directories — as its own task, since it's a distinct concern from Task 2's wiring.

**Files:**
- Modify: `src/services/eventHistoryStore.js` (add a `prune(maxFiles)` function, or a
  standalone `pruneEventHistory(dir, maxFiles)` — implementer's choice, matching whichever
  existing precedent — `workspaceManager.pruneWorkspaces()` vs. `JobManager._trimHistory()` —
  reads cleaner against this file's shape; note the choice in the commit message)
- Modify: `src/config/index.js` (`maxEventHistoryFiles`, default `100`, matching
  `maxWorkspaceHistory`'s default)
- Modify: `src/validation/configValidation.js`
- Modify: `mcpServer.js` or `eventHistoryBridge.js` (call prune after each terminal event,
  mirroring `workspaceEventBridge.js`'s own terminal-event-triggered pruning)
- Test: append to `eventHistoryStore.test.js`, `configValidation.test.js`

- [ ] **Step 1: Write the failing tests.** Creating more than `maxEventHistoryFiles` completed
  jobs' logs evicts the oldest by file mtime; an in-flight job's log (no terminal event
  observed for it yet) is never evicted even over the cap — this requires the pruning function
  to know which jobs are terminal, which it can determine either from a manifest it maintains
  or by having the bridge only call prune with a known-terminal job id excluded from eviction
  consideration until its own terminal event fires. Implementer's design choice; state it
  explicitly in the report.

- [ ] **Step 2-6:** RED, implement, GREEN, full suite, commit — same shape as prior tasks.

**Rollback strategy:** `git revert` — Tasks 1-2 unaffected; reverting removes only the cap
enforcement, leaving unbounded (but still correct) event-history growth, same risk profile as
before this task existed.

---

## Task 4: Extend `ReplayEngine`'s fallback chain with the new "durable" tier

**Objective:** `replay(jobId)` consults the durable log when `TimelineStore` no longer has the
job, before falling back to the coarse workspace reconstruction.

**Files:**
- Modify: `src/services/replayEngine.js`
- Modify: `src/services/observabilityService.js` (construct `EventHistoryStore` / pass it into
  `createReplayEngine` when configured — small, additive change to its own construction call)
- Test: `tests/replayEngine.test.js` (append)

- [ ] **Step 1: Write the failing tests.** A job with a durable log but no `TimelineStore` entry
  (simulating eviction or restart) returns `source: "durable"` with every event from the log
  projected to `TimelineEntry` shape; a job with neither a durable log nor a `TimelineStore`
  entry still falls back to `source: "workspace"`, unchanged from today; `OutputChunk` events
  are absent from a `"durable"` result even for a job that produced them (proving Task 2's
  exclusion is actually observed end-to-end here, not just at the bridge layer).

- [ ] **Step 2-6:** RED, implement (`createReplayEngine`'s constructor gains an optional
  `eventHistoryStore` param — `undefined` when `config.eventHistory !== "file"`, preserving
  today's exact behavior when unset), GREEN, full suite (`npm test`), commit.

**Expected review checkpoint:** confirm `ObservabilityService.replay()`'s call signature is
byte-identical before and after this task (only `replayEngine.js`'s internals and
`observabilityService.js`'s one construction call change); confirm a job with **both** a
`TimelineStore` entry and a durable log still returns `source: "runtime"` (correct priority
order preserved, durable tier is a fallback, not a replacement for the fast path).

**Rollback strategy:** `git revert` — `ReplayEngine` reverts to its current two-tier fallback;
Tasks 1-3's durable-writing machinery is unaffected (unused, not broken) by the revert.

---

## Task 5: E2E restart test + fix the `close()` wiring gap

**Objective:** prove the whole system survives a restart with full-fidelity replay (not just
`EventHistoryStore` in isolation), and fix the discovered, unrelated defect
(`ARCHITECTURE_REVIEW.md`): `ObservabilityService.close()` is never actually called during
graceful shutdown.

**Files:**
- Test: `tests/eventHistoryE2E.test.js` (new) — real `RuntimeEventBus` + `JobManager` +
  `wireEventHistoryToEventBus`, a job runs to completion, a second `EventHistoryStore`/
  `ReplayEngine` pair over the same directory replays it with `source: "durable"`.
- Modify: `src/server/mcpServer.js` (return/expose the `ObservabilityService` instance, or
  store it so `createMcpServer()`'s caller can reach it)
- Modify: `src/cli/entry.js` (`registerShutdownHandlers` calls the `ObservabilityService`'s
  `close()` alongside `server.close()`)
- Test: append to `mcpServer.test.js`/`entry.test.js` proving `close()` is actually invoked
  during shutdown (e.g. a fake `ObservabilityService` whose `close` is a spy)

**Expected review checkpoint:** confirm the `close()` fix doesn't change shutdown ordering in a
way that could drop an in-flight event (unsubscribing from the bus is safe at any point — a
missed event during shutdown is not a durability regression, since the process is exiting
anyway); confirm the E2E test's "restart" is a genuinely fresh pair of instances over the same
directory, not a reused object (mirroring `ADR-0005`'s own E2E test's rigor).

**Rollback strategy:** `git revert` — the E2E test and the `close()` fix are both independently
revertible without affecting Tasks 1-4.

---

## Task 6: Documentation

**Objective:** reconcile `CHANGELOG.md`, `README.md`, `docs/OBSERVABILITY_FREEZE.md`'s Extension
Points section (durable replay is now built, no longer "not built"), `docs/releases/
KNOWN_LIMITATIONS.md`, `docs/releases/SUPPORTED_FEATURES.md` — same pattern as this sprint's own
Task 6, using real test counts derived from `git log`, not estimates.

**Files:** `CHANGELOG.md`, `README.md`, `docs/OBSERVABILITY_FREEZE.md`,
`docs/releases/KNOWN_LIMITATIONS.md`, `docs/releases/SUPPORTED_FEATURES.md`

---

## Task 7: Full repository verification, review, ponytail audit, certification

Same final-gate shape as this sprint's own Task 7: fresh `npm test`, MCP Inspector `tools/list`
diff (expect zero change — this wave adds no MCP tool), a whole-branch review on the most
capable available model, `ponytail-review` the diff, `ponytail-audit` the whole repo,
`finishing-a-development-branch`.

---

## Self-review (writing-plans skill's own required check)

**Spec coverage:** every `ADR-0006` Decision element maps to a task — `EventHistoryStore` →
Task 1; opt-in wiring → Task 2; retention → Task 3; `ReplayEngine` integration → Task 4;
E2E proof + the `close()` fix (explicitly named in the ADR's Explicitly-out-of-scope section as
"worth bundling into this wave") → Task 5; docs → Task 6; final gates → Task 7. No gaps found.

**Placeholder scan:** every code step has complete, concrete code; exact test counts are
deliberately **not** pre-computed here (unlike `ADR-0005`'s plan) because this plan is written
before Task 1 has run — the prior sprint's own retrospective noted its hand-computed counts
drifted from reality more than once; this plan instead instructs each task to derive the real
pre/post count from `git log`/a fresh `npm test` run, matching the corrective practice this
sprint's own Task 6 already adopted.

**Type consistency:** `EventHistoryStore`'s constructor shape (`{dir, logger}`) matches
`FileJobStore`'s exactly, for consistency; `readAll()`'s return shape is a plain array of raw
`RuntimeEvent` objects, projected to `TimelineEntry` shape only inside `replayEngine.js` (Task
4) — `EventHistoryStore` itself has no dependency on `TimelineEntry`'s shape, keeping it a
generic durable-log primitive.
