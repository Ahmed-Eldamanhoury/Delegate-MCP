# Stdin-Close Self-Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement ADR-0004's recommended fix — the server detects its own `stdin`
closing (its client having disconnected) and self-shuts-down through the exact same
graceful path `SIGINT`/`SIGTERM` already use, instead of relying entirely on an
externally-delivered signal that Windows/host behavior may never send.

**Architecture:** No new architecture. Extracts the existing inline shutdown-wiring logic
in `src/cli/entry.js` into a small, named, exported, dependency-injectable function
(`registerShutdownHandlers`) so it can be unit-tested without mocking `StdioServerTransport`,
`loadConfig`, or any other part of `main()`'s startup sequence. Adds one new listener
(`stdin.on("end", ...)`) alongside the existing `SIGINT`/`SIGTERM` registrations, routing
through the same `shutdown()` closure.

**Tech Stack:** Node.js (ESM), `node:test`, `node:events`.

## Global Constraints

- Do not modify: any of the 6 MCP tools' schemas, `docs/FOUNDATION_FREEZE.md`,
  `docs/OBSERVABILITY_FREEZE.md` guarantees, `RuntimeEventBus`'s `{publish, subscribe,
  subscribeAll}` contract, the Job lifecycle enum, `ExecutionContext`'s shape. No new MCP
  tools.
- TDD required: write failing tests first, then implement, then confirm green.
- `npm test` must show 0 failures both before and after.
- No new production dependencies.
- Match existing code style (this project's dependency-injection-via-default-parameter
  pattern, used throughout `debugRunner.js`/`debugInvoke.js`/`claudeCliService.js`).
- **Out of scope, explicitly**: verifying actual Claude Desktop / MCP-host child-process
  lifecycle behavior against a live connection. That would require disrupting the live
  session this work is being done in, and ADR-0004 already flags it as a separate,
  deliberately-scheduled future verification step — not this task's job. This task's job
  is: implement the mechanism correctly, prove it works via unit tests with injected
  fakes, and leave the live-behavior question exactly as open as ADR-0004 already
  documented it.
- Do not touch `README.md`/`docs/ARCHITECTURE.md`/`CHANGELOG.md` — documentation
  reconciliation happens centrally after the task lands, decided at that point whether
  this rises to a CHANGELOG entry (a bug-fix-shaped reliability hardening in server
  startup, not a user-facing behavior change to any MCP tool).
- Commit only the specific files touched — never `git add -A` or `.`. Do not amend or
  rebase.

---

## Task 1 — Extract and test the shutdown-wiring, add stdin-close handling

**Files:**
- Modify: `src/cli/entry.js`
- Test: `tests/entry.test.js` (new file — `entry.js` currently has zero test coverage)

**Problem:** `src/cli/entry.js`'s `main()` inlines its shutdown wiring:

```js
const shutdown = (signal) => {
  logger.info("shutting down", { signal });
  server
    .close()
    .catch((err) => logger.error("error during shutdown", { message: err.message }))
    .finally(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
```

This only reacts to explicit `SIGINT`/`SIGTERM`. Per `docs/adr/ADR-0004-server-instance-lifecycle.md`,
the MCP SDK's `StdioServerTransport` never detects its own `stdin` closing to self-shut-down
(confirmed there by reading the SDK's source directly), so if the actual MCP host process
disconnects without delivering a signal the process can catch (unreliable on Windows in
particular), this server process is orphaned indefinitely, still holding stale job state —
the confirmed root-cause candidate for the known concurrent-dispatch job-tracking defect.

**Fix:** extract the wiring into an exported, dependency-injectable function, and add a
`stdin.on("end", ...)` listener that routes through the same `shutdown()` closure.

- [ ] **Step 1: Write the failing tests**

Create `tests/entry.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerShutdownHandlers } from "../src/cli/entry.js";

function fakeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    info: (msg, meta) => calls.info.push({ msg, meta }),
    warn: (msg, meta) => calls.warn.push({ msg, meta }),
    error: (msg, meta) => calls.error.push({ msg, meta }),
    calls,
  };
}

function fakeServer(closeResult = Promise.resolve()) {
  let closeCalls = 0;
  return {
    close: () => {
      closeCalls += 1;
      return closeResult;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("SIGINT triggers graceful shutdown: server.close() then exit", async () => {
  const server = fakeServer();
  const signalSource = new EventEmitter();
  let exited = false;
  registerShutdownHandlers(server, fakeLogger(), {
    stdin: new EventEmitter(),
    exit: () => {
      exited = true;
    },
    signalSource,
  });

  signalSource.emit("SIGINT");
  await flushMicrotasks();

  assert.equal(server.closeCalls, 1);
  assert.equal(exited, true);
});

test("SIGTERM triggers graceful shutdown: server.close() then exit", async () => {
  const server = fakeServer();
  const signalSource = new EventEmitter();
  let exited = false;
  registerShutdownHandlers(server, fakeLogger(), {
    stdin: new EventEmitter(),
    exit: () => {
      exited = true;
    },
    signalSource,
  });

  signalSource.emit("SIGTERM");
  await flushMicrotasks();

  assert.equal(server.closeCalls, 1);
  assert.equal(exited, true);
});

test("stdin ending triggers the same graceful shutdown path as SIGINT/SIGTERM", async () => {
  const server = fakeServer();
  const stdin = new EventEmitter();
  let exited = false;
  registerShutdownHandlers(server, fakeLogger(), {
    stdin,
    exit: () => {
      exited = true;
    },
    signalSource: new EventEmitter(),
  });

  stdin.emit("end");
  await flushMicrotasks();

  assert.equal(server.closeCalls, 1);
  assert.equal(exited, true);
});

test("a server.close() rejection during stdin-triggered shutdown is logged, and shutdown still exits", async () => {
  const closeErr = new Error("close boom");
  const server = fakeServer(Promise.reject(closeErr));
  const stdin = new EventEmitter();
  const logger = fakeLogger();
  let exited = false;
  registerShutdownHandlers(server, logger, {
    stdin,
    exit: () => {
      exited = true;
    },
    signalSource: new EventEmitter(),
  });

  stdin.emit("end");
  await flushMicrotasks();

  assert.equal(exited, true);
  assert.equal(logger.calls.error.length, 1);
  assert.equal(logger.calls.error[0].meta.message, "close boom");
});

test("only one of the three triggers (SIGINT/SIGTERM/stdin-end) is needed to shut down -- they all share one shutdown path, not three independent ones", async () => {
  const server = fakeServer();
  const stdin = new EventEmitter();
  const signalSource = new EventEmitter();
  let exitCount = 0;
  registerShutdownHandlers(server, fakeLogger(), {
    stdin,
    exit: () => {
      exitCount += 1;
    },
    signalSource,
  });

  stdin.emit("end");
  await flushMicrotasks();

  assert.equal(server.closeCalls, 1);
  assert.equal(exitCount, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/entry.test.js`

Expected: FAIL with `registerShutdownHandlers is not a function` (or similar — it does
not exist in `src/cli/entry.js` yet), for every test.

- [ ] **Step 3: Implement the extraction and the new stdin handler**

In `src/cli/entry.js`, replace the whole file with:

```js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/index.js";
import { VERSION } from "../config/version.js";
import { validateConfig } from "../validation/configValidation.js";
import { createLogger } from "../logging/logger.js";
import { checkClaudeBinary } from "../server/health.js";
import { createMcpServer } from "../server/mcpServer.js";

/**
 * Wires graceful shutdown to three independent triggers, all sharing one `shutdown()` path:
 * SIGINT, SIGTERM, and (new) the process's own `stdin` ending. The MCP SDK's
 * `StdioServerTransport` never detects its own `stdin` closing to self-shut-down (confirmed
 * by reading its source in ADR-0004) -- if the actual MCP host disconnects without delivering
 * a signal this process can catch (unreliable on Windows in particular), this process would
 * otherwise sit orphaned indefinitely, still holding stale job state. Reacting to `stdin`
 * ending routes that case through the exact same graceful-shutdown path SIGINT/SIGTERM use,
 * rather than adding a second, different shutdown mechanism.
 *
 * @param {{close: () => Promise<void>}} server
 * @param {{info: Function, warn: Function, error: Function}} logger
 * @param {{stdin?: NodeJS.ReadStream, exit?: () => void, signalSource?: NodeJS.Process}} [deps]
 *   Injectable purely for testability -- production always uses the real `process`/`process.stdin`.
 * @returns {(trigger: string) => void} the shutdown function itself, exposed for testability
 */
export function registerShutdownHandlers(server, logger, { stdin = process.stdin, exit = () => process.exit(0), signalSource = process } = {}) {
  const shutdown = (trigger) => {
    logger.info("shutting down", { trigger });
    server
      .close()
      .catch((err) => logger.error("error during shutdown", { message: err.message }))
      .finally(exit);
  };
  signalSource.on("SIGINT", () => shutdown("SIGINT"));
  signalSource.on("SIGTERM", () => shutdown("SIGTERM"));
  stdin.on("end", () => shutdown("stdin-closed"));
  return shutdown;
}

export async function main() {
  const logger = createLogger("claude-delegate");

  const config = loadConfig(process.env);
  validateConfig(config);

  const health = await checkClaudeBinary(config);
  logger[health.ok ? "info" : "warn"]("claude binary health check", health);

  const server = createMcpServer({ config, logger, version: VERSION });
  registerShutdownHandlers(server, logger);

  await server.connect(new StdioServerTransport());
  logger.info("claude-delegate mcp server started", { version: VERSION });
}

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/entry.test.js`

Expected: all 5 tests pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: 184/184 passing (179 pre-existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/cli/entry.js tests/entry.test.js
git commit -m "Implement ADR-0004's stdin-close self-shutdown fix

extern.js's shutdown wiring is extracted into a named, exported,
dependency-injectable registerShutdownHandlers() function -- entry.js
previously had zero test coverage, and this is the seam that makes it
testable without mocking StdioServerTransport/loadConfig/the rest of
main()'s startup sequence.

Adds one new trigger alongside the existing SIGINT/SIGTERM: the
process's own stdin ending. Per ADR-0004, the MCP SDK's
StdioServerTransport never detects this itself, so an MCP host
disconnecting without delivering a catchable signal (unreliable on
Windows) previously left this process orphaned indefinitely, still
holding stale job state -- the confirmed root-cause candidate for the
known concurrent-dispatch job-tracking limitation.

Live MCP-host process-lifecycle verification remains explicitly out of
scope per ADR-0004 -- this task implements and unit-tests the
mechanism only.

5 new tests, 184/184 passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After the task

1. Dispatch a task-scoped reviewer (spec + code quality) — this sprint deliberately tries
   `delegate_task` for this role instead of the native `Agent` tool, as a direct
   comparison data point for the dogfooding evaluation.
2. If the reviewer finds fixable issues, fix them (tool choice recorded honestly based on
   fix size/complexity) and re-review.
3. Run the full whole-branch review, `verification-before-completion`, `ponytail-review`,
   `ponytail-audit`.
4. Decide, at that point, whether this reliability fix warrants a `CHANGELOG.md` entry
   (likely yes, following the pattern of the two prior Critical Stability Sprint fixes).
5. `finishing-a-development-branch`.
6. Write the sprint's six deliverables: `DOGFOODING_REPORT.md`, `DOGFOODING_METRICS.md`,
   `DOGFOODING_DECISION.md`, `SPRINT_REPORT.md`, `VALUE_REPORT.md`, `Lessons_Learned.md`.
