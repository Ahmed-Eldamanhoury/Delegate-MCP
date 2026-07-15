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

## Task 0 — Fix `entry.js`'s import-time side effect (blocks Task 1's own tests)

**Discovered while resuming this plan:** `entry.js`'s bottom-of-file
`main().catch(...)` call executes unconditionally at *import* time, not only when
`server.js` is actually run. `tests/entry.test.js` (Task 1, already written) imports
`registerShutdownHandlers` from `entry.js` — which means merely importing it for testing
also runs the real `main()`: it calls the real `checkClaudeBinary`, creates a real
`McpServer`, and connects a real `StdioServerTransport` to the test process's own
`stdin`/`stdout`. That live server never exits on its own, so it holds the Node test
process open indefinitely — reproduced directly: `npm test` hung and had to be killed,
leaving orphaned `node.exe` processes; `node --test tests/entry.test.js` alone also
leaves a live server running after its 5 tests print PASS.

**Root cause:** `entry.js` conflates two responsibilities — "define `main`" and "run
`main`" — with no guard between them. The obvious fix (`import.meta.url ===
process.argv[1]`-style self-check) does **not work here**: `server.js` is the actual
documented entrypoint (`claude_desktop_config.json` points at it; its own header comment
says so) and reaches `entry.js` via `import "./src/cli/entry.js"` — meaning
`process.argv[1]` is always `server.js`'s path, never `entry.js`'s own, even in the one
legitimate production case. That self-check would silently break production startup.

**Fix:** stop `entry.js` from invoking `main()` itself. Export `main`; have `server.js`
(the one file whose whole job is "be the real entrypoint") import and call it. This makes
`entry.js` a pure module — safe to import from a test with zero side effects — without
relying on any environment-sniffing or path-comparison trick.

**Files:**
- Modify: `src/cli/entry.js` (remove the trailing `main().catch(...)` call; keep the
  `export async function main()` declaration itself unchanged)
- Modify: `server.js`
- Test: `tests/entry.test.js` (append one regression test)

**Interfaces:**
- Produces: `entry.js` still exports `registerShutdownHandlers` (unchanged signature) and
  `main` (unchanged signature, `async function main(): Promise<void>`), but no longer
  calls either at module load.

- [ ] **Step 1: Write the failing regression test**

Append to `tests/entry.test.js` (same file Task 1 already created):

```js
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("importing entry.js has no import-time side effects — it must not start the server", () => {
  const entryPath = fileURLToPath(new URL("../src/cli/entry.js", import.meta.url));
  const script = `import(${JSON.stringify(entryPath)}).then(() => { process.stdout.write("imported-ok"); process.exit(0); });`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(output, "imported-ok");
});
```

This spawns a fresh Node process that imports `entry.js` alone (never calling `main`) and
immediately exits. If `entry.js` still auto-runs `main()` on import, the spawned process
starts a live `StdioServerTransport` connected to its own `stdin`/`stdout` and never
exits — `execFileSync`'s 5s `timeout` kills it and throws, failing the test. `add` this
import block above the existing `import { registerShutdownHandlers } from ...` line at
the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/entry.test.js`

Expected: the new test fails/times out (the process hangs past 5000ms and
`execFileSync` throws `ETIMEDOUT`); the 5 pre-existing tests in this file still pass.

- [ ] **Step 3: Implement the fix**

In `src/cli/entry.js`, delete only the trailing block (keep everything above it,
including `export async function main() { ... }`, unchanged):

```js
main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});
```

In `server.js`, replace the whole file with:

```js
// Backward-compatible entrypoint — claude_desktop_config.json points at this exact path.
// Actual implementation lives in src/; see docs/ARCHITECTURE.md.
import { main } from "./src/cli/entry.js";

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/entry.test.js`

Expected: all 6 tests pass (5 from Task 1 + this one), and the command itself returns
promptly (no hang, no orphaned process left behind — confirm with the platform's process
list if in doubt).

- [ ] **Step 5: Run the full suite (this also completes Task 1's own remaining
  verification — see the note below; there is no separate Task 1 dispatch)**

Run: `npm test`

Expected: 185/185 passing (179 pre-existing + 6 in `entry.test.js`), and the command
returns on its own within a normal test-run duration — no hang. If it does not return
within roughly 60 seconds, treat that as a failure: stop, do not wait it out or kill-and-
ignore it, and report BLOCKED with whatever output was captured — a second hang here
would mean another test file has the same import-time-side-effect problem, which is
itself a finding worth surfacing, not papering over.

- [ ] **Step 6: Verify `server.js` still starts normally (production behavior preserved)**

Run: `npx @modelcontextprotocol/inspector --cli node server.js --method tools/list`

Expected: returns the same 6 tools (`delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel`) as every
prior certification pass, then exits on its own — proving `server.js` still boots the
real server end-to-end after the refactor.

- [ ] **Step 7: Commit**

```bash
git add src/cli/entry.js server.js tests/entry.test.js
git commit -m "Fix entry.js starting a live server as an import-time side effect

entry.js's main().catch(...) ran unconditionally at module load, so
Task 1's own tests.js (which imports registerShutdownHandlers for unit
testing) also started a real, stdio-connected MCP server that never
exits -- hanging \`npm test\` indefinitely and leaving orphaned node.exe
processes (reproduced directly this sprint).

The import.meta.url-based entrypoint-detection idiom does not work
here: server.js is the actual documented entrypoint and reaches
entry.js via a re-export import, so process.argv[1] is always
server.js's path, never entry.js's own -- that guard would have
silently broken production startup instead.

Fix: entry.js no longer calls main() itself; server.js (the one file
whose job is being the real entrypoint) now imports and calls it
explicitly. entry.js is now a pure module with zero import-time side
effects, safe for tests. Verified server.js still boots the real
server end-to-end via MCP Inspector after the change.

6/6 entry.test.js tests passing, 185/185 full suite passing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 1 (historical — already implemented, folded into Task 0 above, no separate dispatch)

The `registerShutdownHandlers` extraction and stdin-close handling described below were
already implemented and left uncommitted by this plan's initial pass, before Task 0's
bug was discovered blocking verification. Task 0's Steps 4-7 above already run this
task's remaining verification (full suite, Inspector check) and its commit — there is
nothing left for a separate Task 1 implementer/reviewer dispatch to do. This section is
kept only as the original design record for `registerShutdownHandlers`.

**Files (already touched, see Task 0's commit for the final state):**
- Modified: `src/cli/entry.js`
- Test: `tests/entry.test.js` (new file — `entry.js` had zero test coverage before this)

**Problem:** `src/cli/entry.js`'s `main()` inlined its shutdown wiring:

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

> **Superseded by Task 0:** the trailing `main().catch(...)` block shown above is exactly
> the import-time side effect Task 0 removes from `entry.js` (moving the call into
> `server.js` instead). Step 3 here is already done in the working tree — this listing is
> historical context for how `registerShutdownHandlers` was extracted, not a step to
> redo. Do not re-add this trailing block after Task 0 has run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/entry.test.js`

Expected: all 6 tests pass (Task 0 added the 6th, the import-side-effect regression
test, to this same file).

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: 185/185 passing (179 pre-existing + 6 new in `entry.test.js`).

- [ ] **Step 6: Commit**

Task 0's own commit (Step 6 above) already includes `src/cli/entry.js`, `server.js`, and
`tests/entry.test.js` in full — by the time Task 0 lands, there is nothing left in the
working tree for Task 1 to separately commit. **Skip this step entirely; do not run
`git commit` again for the same files.** (The commit message originally drafted for this
step is superseded by Task 0's commit message, which covers both the extraction and the
side-effect fix together.)

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
