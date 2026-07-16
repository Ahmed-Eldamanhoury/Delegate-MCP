# MCP Replay Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** implement `delegate_replay`, a new, read-only MCP tool exposing
`ObservabilityService.replay(jobId)` to this server's actual users — the first user-facing
capability built on top of the `ADR-0003`/`ADR-0006` observability foundation.

**Architecture:** per `docs/adr/ADR-0007-mcp-replay-access.md` (Proposed, pending sign-off —
read it first, this plan implements it, it does not re-derive it). One new handler file, one
new `registerTool` call, zero changes to `ObservabilityService`/`ReplayEngine`/any existing
tool.

**Tech Stack:** Node.js (ESM), `node:test` — no new dependencies.

**Scale note:** this wave is deliberately small relative to `ADR-0005`/`ADR-0006`'s 7-8 task
sprints — it is a thin MCP-facing wrapper over already-shipped, already-tested infrastructure,
not new persistence/architecture. Three tasks, scaled to the actual size of the work.

**Do not begin implementation until `ADR-0007` and this plan are both explicitly approved.**

## Global Constraints

- No architecture changes beyond `ADR-0007` — if an implementer hits a decision the ADR doesn't
  cover, stop and ask; do not improvise.
- Zero change to any of the six existing MCP tools' schemas. Zero change to
  `ObservabilityService`'s public method set or `replay()`'s signature.
- `npm test` must pass with 0 failures after every task.
- No new production dependencies.
- Match this codebase's real handler-testing convention exactly: no per-handler unit test
  files exist today (verified — none of the six existing handlers has one); handlers are
  constructed directly and called as plain functions in integration-style tests
  (`tests/asyncExecution.integration.test.js` is the precedent). Do not invent a new testing
  pattern for this one handler.
- Commit only the specific files each task actually touches — never `git add -A` or `.`.

---

## Task 1: Implement `delegateReplayHandler` (TDD)

**Objective:** the handler itself, in isolation, following `delegateStatusHandler.js`'s exact
shape.

**Files:**
- Create: `src/handlers/delegateReplayHandler.js`
- Test: append to `tests/asyncExecution.integration.test.js` (the established precedent for
  handler testing — see Global Constraints), or a new file if the implementer judges the
  existing file has grown too large for one more handler's tests; note the choice made.

**Public interface:**
```js
export function createDelegateReplayHandler({ observabilityService }) {
  return async function delegateReplayHandler({ job_id }) { ... }
}
```

- [ ] **Step 1: Write the failing tests**

Cover: a real `JobManager` + real `ObservabilityService` (wired to the same `RuntimeEventBus`,
matching `asyncExecution.integration.test.js`'s existing setup pattern) runs one job to
completion; calling the handler directly returns `content`/`structuredContent` with
`source: "runtime"` and the job's actual event sequence (`JobQueued`, `JobStateChanged` ×2,
`JobCompleted`, matching the same event sequence `tests/eventHistoryE2E.test.js` already proved
for a trivial job); a `job_id` `ObservabilityService` has never seen returns
`{source: "unavailable", timeline: []}` in `structuredContent` and a human-readable
"no replay data available" message in `content[0].text` — **not** an `isError: true` response
(this is the ADR's deliberate design choice — verify it's actually implemented that way, not
accidentally mirroring `delegate_status`'s error-on-not-found behavior).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/asyncExecution.integration.test.js` (or the new file) — expect failure
(module doesn't exist yet).

- [ ] **Step 3: Implement `delegateReplayHandler.js`**

```js
/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateReplayHandler({ observabilityService }) {
  return async function delegateReplayHandler({ job_id }) {
    const { source, timeline } = observabilityService.replay(job_id);
    const text =
      timeline.length === 0
        ? `No replay data available for job ${job_id} (source: ${source}).`
        : `Replay for ${job_id} (source: ${source}, ${timeline.length} event${timeline.length === 1 ? "" : "s"}):\n` +
          timeline.map((e) => `  [${e.timestamp}] ${e.type}${e.synthetic ? " (synthetic)" : ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { source, timeline } };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

- [ ] **Step 5: Run the full suite**

Run: `npm test` — expect 278 (current baseline) + new tests, 0 failures.

- [ ] **Step 6: Commit**

```
git add src/handlers/delegateReplayHandler.js tests/asyncExecution.integration.test.js
git commit -m "Implement delegateReplayHandler: thin MCP wrapper over ObservabilityService.replay() (ADR-0007)

..."
```

**Rollback strategy:** delete the new handler file and its tests — nothing else references it
yet.

---

## Task 2: Register `delegate_replay` as a new MCP tool

**Objective:** wire the handler into `mcpServer.js`, verify the schema addition via Inspector.

**Files:**
- Modify: `src/server/mcpServer.js`
- Test: append to `tests/mcpServer.test.js`

- [ ] **Step 1: Write the failing test** — a real `createMcpServer()` instance's registered
  tools include `delegate_replay` (mirror however the existing tests, if any, assert tool
  registration for the other six — if none do this today, add a minimal check using whatever the
  `McpServer`/SDK instance exposes for introspection, or fall through to the Inspector check in
  Step 5 as the primary verification if unit-level introspection isn't practical; note which).

- [ ] **Step 2: Run to verify RED** (if a registration-level unit test is added).

- [ ] **Step 3: Implement** — add the `registerTool("delegate_replay", {...}, createDelegateReplayHandler({observabilityService}))`
  call in `createMcpServer()`, using the exact description/annotations from `ADR-0007`'s
  Decision section. `observabilityService` is already a local variable in scope at this point in
  the function (constructed earlier in the same function body) — no new construction needed.

- [ ] **Step 4: Run to verify GREEN, then the full suite** (`npm test`) — expect Task 1's count
  + any new registration test, 0 failures.

- [ ] **Step 5: Inspector verification (required, not optional)**

Run: `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`

Expected: **exactly 7 tools** — the existing 6 (`delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel`) plus
`delegate_replay`. Diff the other six tools' schemas against the pre-change snapshot (or the
last known-good one from `PUSH_REPORT.md`/`MERGE_REPORT.md` of the prior sprint) — confirm
byte-identical, not just "still present." Record the actual command output in the report.

- [ ] **Step 6: Commit**

**Expected review checkpoint:** confirm `observabilityService` passed into the new handler is
the SAME instance already used by the rest of `createMcpServer()` (not a second construction —
this project just spent a whole sprint fixing exactly that class of duplication, `ADR-0006`'s
final gate); confirm none of the six existing tools' `registerTool` calls were touched.

**Rollback strategy:** `git revert` — Task 1's handler file stands alone; reverting this commit
removes only the registration, leaving `delegate_replay` unreachable but present in the
codebase, matching every prior sprint's per-task revert precedent.

---

## Task 3: Documentation + final verification, review, ponytail, certification

**Objective:** reconcile docs (much smaller footprint than a persistence sprint — one new tool,
not a new subsystem), then the same final-gate shape as every prior sprint.

**Docs to touch** (verify current wording with Read before editing — do not assume exact
existing text without checking):
- `CHANGELOG.md`: new entry naming `delegate_replay`, its purpose, and that it's the first
  consumer of the `ADR-0003`/`ADR-0006` observability foundation.
- `docs/OBSERVABILITY_FREEZE.md`: the Extension Rules / "New consumers" section currently says
  something like *"call `ObservabilityService`'s existing methods; never subscribe to
  `RuntimeEventBus` directly ... None are implemented yet."* — update to note `delegate_replay`
  is the first one now implemented.
- `docs/releases/SUPPORTED_FEATURES.md`: the `ObservabilityService` row currently says *"but no
  MCP tool, Dashboard, or API exposes it yet. Zero external surface, zero external risk"* — this
  is now inaccurate for the `replay()` method specifically; reconcile precisely (don't overclaim
  that ALL of `ObservabilityService` has a consumer — only `replay()` does, via this one tool).
- `docs/releases/KNOWN_LIMITATIONS.md`: check whether anything here referenced "no consumer
  exists" for replay/observability data and needs the same precise, non-overclaiming update.
- `README.md`: add `delegate_replay` to wherever the other tools are documented, if they are.

**Final gate** (same shape as `ADR-0005`/`ADR-0006`'s own Task 7):
1. Fresh `npm test` — expect 0 failures.
2. MCP Inspector `tools/list` diff — 7 tools, only `delegate_replay` new.
3. Whole-branch review (most capable available model) against the full range
   `git merge-base main HEAD..HEAD`.
4. `ponytail-review` the diff, `ponytail-audit` the whole repo.
5. `finishing-a-development-branch`.

**Rollback strategy:** revert whichever specific commit a Critical/Important finding traces to;
re-run this task's Steps 1-2 in full before proceeding to Step 5, per every prior sprint's
established recovery pattern.

---

## Self-review (writing-plans skill's own required check)

**Spec coverage:** every `ADR-0007` Decision element maps to a task — handler → Task 1;
registration + schema verification → Task 2; docs + final gates → Task 3. No gaps found.

**Placeholder scan:** every code step has complete, concrete code. Exact test counts are
deliberately not pre-computed (matching the corrective practice `ADR-0006`'s own plan adopted
after the prior sprint's plan drifted from reality) — each task derives real pre/post counts
from a fresh `npm test` run.

**Type consistency:** `delegateReplayHandler`'s dependency shape (`{observabilityService}`)
matches every other handler's single-dependency-object convention exactly
(`{jobManager}` for status/history/cancel, `{config, logger, jobManager}` for task/submit).
