# MCP Snapshot Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** implement `delegate_snapshot`, a new, read-only MCP tool exposing
`ObservabilityService.getSnapshot()` to this server's actual users — the third and last tool in
the "thin MCP wrapper over `ObservabilityService`" family (`delegate_replay`, `ADR-0007`;
`delegate_metrics`, `ADR-0008`; this one, `ADR-0009`).

**Architecture:** per `docs/adr/ADR-0009-mcp-snapshot-access.md` (read it first, this plan
implements it, it does not re-derive it). One new handler file, one new `registerTool` call,
zero changes to `ObservabilityService`/`SnapshotBuilder`/`MetricsCollector`/any existing tool.

**Tech Stack:** Node.js (ESM), `node:test` — no new dependencies.

**Scale note:** this is the smallest of the three waves in this family — `getSnapshot()` returns
an already-frozen, already-shaped `{takenAt, metrics, activeJobs}` object with no branching
required in the handler (unlike `delegate_replay`'s empty-timeline text branch). Three tasks,
scaled to the actual size of the work; task 1 folds handler + registration together (`ADR-0007`/
`ADR-0008` split these into two tasks each — not warranted here given how little each step adds
on its own for a no-input, no-branch handler).

**Do not begin implementation until `ADR-0009` and this plan are both explicitly approved.**

## Global Constraints

- No architecture changes beyond `ADR-0009` — if an implementer hits a decision the ADR doesn't
  cover, stop and ask; do not improvise.
- Zero change to any of the eight existing MCP tools' schemas. Zero change to
  `ObservabilityService`'s public method set or `getSnapshot()`'s signature.
- `npm test` must pass with 0 failures after every task.
- No new production dependencies.
- Match this codebase's real handler-testing convention exactly: no per-handler unit test files
  exist today; handlers are constructed directly and called as plain functions in
  integration-style tests (`tests/asyncExecution.integration.test.js` is the precedent, already
  used by `delegate_replay`/`delegate_metrics`). Do not invent a new testing pattern for this one
  handler.
- Commit only the specific files each task actually touches — never `git add -A` or `.`.

---

## Task 1: Implement `delegateSnapshotHandler` (TDD) + register `delegate_snapshot`

**Objective:** the handler, following `delegateMetricsHandler.js`'s exact shape, wired into
`mcpServer.js` alongside the existing eight tools.

**Files:**
- Create: `src/handlers/delegateSnapshotHandler.js`
- Modify: `src/server/mcpServer.js`
- Test: append to `tests/asyncExecution.integration.test.js` (the established precedent), and to
  `tests/mcpServer.test.js` for tool-registration coverage — or new files if the implementer
  judges the existing ones have grown too large; note the choice made.

**Public interface:**
```js
export function createDelegateSnapshotHandler({ observabilityService }) {
  return async function delegateSnapshotHandler() { ... }
}
```

- [ ] **Step 1: Write the failing tests**

Cover: a real `JobManager` + real `ObservabilityService` (wired to the same `RuntimeEventBus`,
matching `asyncExecution.integration.test.js`'s existing setup pattern), calling the handler
directly returns `content`/`structuredContent` with `structuredContent` matching
`observabilityService.getSnapshot()`'s actual return shape (`takenAt` a string, `metrics` an
object, `activeJobs` an array) verbatim — no reshaping. A registration-level test confirms a
real `createMcpServer()` instance's registered tools include `delegate_snapshot` (mirror however
`delegate_replay`/`delegate_metrics` are already asserted in `tests/mcpServer.test.js`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/asyncExecution.integration.test.js tests/mcpServer.test.js` — expect
failure (module doesn't exist yet / tool not registered).

- [ ] **Step 3: Implement `delegateSnapshotHandler.js`**

```js
/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateSnapshotHandler({ observabilityService }) {
  return async function delegateSnapshotHandler() {
    const snapshot = observabilityService.getSnapshot();
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot };
  };
}
```

- [ ] **Step 4: Register the tool in `mcpServer.js`**

Add the `registerTool("delegate_snapshot", {...}, createDelegateSnapshotHandler({observabilityService}))`
call in `createMcpServer()`, using the description/annotations from `ADR-0009`'s Decision
section (`inputSchema: {}`, `annotations: { readOnlyHint: true, destructiveHint: false,
idempotentHint: true, openWorldHint: false }` — the same annotation block `delegate_metrics`/
`delegate_models` already use). `observabilityService` is already a local variable in scope at
this point in the function — no new construction needed.

- [ ] **Step 5: Run the tests to verify they pass, then the full suite**

Run: `npm test` — expect current baseline (derive the real pre/post counts from a fresh run,
do not pre-compute) + new tests, 0 failures.

- [ ] **Step 6: Inspector verification (required, not optional)**

Run: `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`

Expected: **exactly 9 tools** — the existing 8 (`delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel`, `delegate_replay`,
`delegate_metrics`) plus `delegate_snapshot`. Diff the other eight tools' schemas against the
pre-change snapshot — confirm byte-identical, not just "still present." Record the actual
command output in the report.

- [ ] **Step 7: Commit**

```
git add src/handlers/delegateSnapshotHandler.js src/server/mcpServer.js tests/asyncExecution.integration.test.js tests/mcpServer.test.js
git commit -m "Implement delegate_snapshot: thin MCP wrapper over ObservabilityService.getSnapshot() (ADR-0009)

..."
```

**Expected review checkpoint:** confirm `observabilityService` passed into the new handler is
the SAME instance already used by the rest of `createMcpServer()` (not a second construction);
confirm none of the eight existing tools' `registerTool` calls were touched; confirm
`structuredContent` is `getSnapshot()`'s return value passed through verbatim, with no added
reshaping.

**Rollback strategy:** `git revert` — the handler file and its registration land in one commit;
reverting removes `delegate_snapshot` entirely, leaving the other eight tools untouched.

---

## Task 2: Documentation reconciliation

**Objective:** reconcile docs — per `CAPABILITY_ROADMAP_REBASELINE.md`'s own observation, the
real cost driver in this family is docs reconciliation, not code; `delegate_replay` took 6
review cycles to stop finding stale "no external consumer" claims, `delegate_metrics` took 2
applying that lesson. Aim to do this one right the first time.

**Docs to touch** (verify current wording with Read before editing — do not assume exact
existing text without checking):
- `CHANGELOG.md`: new entry naming `delegate_snapshot`, its purpose, and that it's the third and
  last tool in the `delegate_replay`/`delegate_metrics`/`delegate_snapshot` family.
- `docs/FOUNDATION_FREEZE.md`: "Frozen public APIs (MCP tools)" currently enumerates eight tools
  — add `delegate_snapshot (added in ADR-0009)`.
- `docs/OBSERVABILITY_FREEZE.md`: check the "New consumers" / Extension Rules section for any
  remaining "none implemented yet" language scoped to `getSnapshot()` specifically; update
  precisely (don't overclaim that `ConsumerRegistry` now has a consumer too — it explicitly
  doesn't, see `ADR-0009`'s Explicitly out of scope).
- `docs/releases/SUPPORTED_FEATURES.md`: reconcile the `ObservabilityService` row for
  `getSnapshot()` specifically, matching the same precise, non-overclaiming pattern
  `delegate_replay`/`delegate_metrics` already established there.
- `docs/releases/KNOWN_LIMITATIONS.md`: check whether anything here referenced "no consumer
  exists" for snapshot/active-jobs data and needs the same precise update.
- `README.md`: add `delegate_snapshot` to wherever the other tools are documented.
- `CAPABILITY_ROADMAP_REBASELINE.md`: mark `delegate_snapshot`/Rank 1 as shipped, mirroring how
  that document already marks Ranks 1-2 from the original roadmap as historical record.

- [ ] **Step 1: Read each doc's current wording, then edit.**
- [ ] **Step 2: `npm test`** — expect 0 failures (docs-only changes should not affect tests; run
  anyway per this project's standing discipline).
- [ ] **Step 3: Commit** — docs files only, in one commit or split per file, implementer's call.

**Rollback strategy:** revert the docs commit(s); no code coupling, so this is risk-free to
undo independently of Task 1.

---

## Task 3: Whole-branch review + certification

**Objective:** the same final-gate shape as every prior sprint in this family.

**Final gate** (same shape as `ADR-0007`/`ADR-0008`'s own final task):
1. Fresh `npm test` — expect 0 failures.
2. MCP Inspector `tools/list` diff — 9 tools, only `delegate_snapshot` new.
3. Whole-branch review (most capable available model) against the full range
   `git merge-base main HEAD..HEAD`.
4. `ponytail-review` the diff, `ponytail-audit` the whole repo.
5. `finishing-a-development-branch`.

**Rollback strategy:** revert whichever specific commit a Critical/Important finding traces to;
re-run Task 1/2's verification steps in full before proceeding to Step 5, per every prior
sprint's established recovery pattern.

---

## Self-review (writing-plans skill's own required check)

**Spec coverage:** every `ADR-0009` Decision element maps to a task — handler + registration →
Task 1; docs → Task 2; final gates → Task 3. No gaps found.

**Placeholder scan:** every code step has complete, concrete code. Exact test counts are
deliberately not pre-computed (matching the corrective practice `ADR-0007`/`ADR-0008`'s own
plans adopted) — Task 1 derives real pre/post counts from a fresh `npm test` run.

**Type consistency:** `delegateSnapshotHandler`'s dependency shape (`{observabilityService}`)
matches `delegateReplayHandler`/`delegateMetricsHandler`'s identical single-dependency-object
convention exactly.
