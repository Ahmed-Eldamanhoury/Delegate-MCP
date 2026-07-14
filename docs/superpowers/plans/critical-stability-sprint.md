# Critical Stability Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one reproduced, High-severity production-stability defect found in this
sprint's audit (Debug Mode's terminal launcher can crash the entire MCP server), and
resolve the investigation into the duplicate-`server.js`-instance job-tracking problem —
implementing a fix only if one can be delivered without touching a frozen contract or
guessing at untested host behavior; otherwise producing an ADR and stopping.

**Architecture:** No architecture changes for Task 1 (a missing error listener on an
already-existing child process). Task 2 is investigation-only by design — see its ADR
requirement below; no code changes are in scope for it in this sprint.

**Tech Stack:** Node.js (ESM), `node:test`, `node:child_process`, `node:events`.

## Global Constraints

- Do not modify: any of the 6 MCP tools' schemas, `docs/FOUNDATION_FREEZE.md`,
  `docs/OBSERVABILITY_FREEZE.md` guarantees, `RuntimeEventBus`'s `{publish, subscribe,
  subscribeAll}` contract, the Job lifecycle enum, `ExecutionContext`'s shape. No new MCP
  tools.
- TDD required: write a failing test first, then implement, then confirm green.
- `npm test` must show 0 failures both before and after — the full suite, not just new
  tests.
- No new production dependencies.
- Match existing code style exactly (JSDoc conventions, comment style already present in
  the touched files).
- **Do NOT do**, per this sprint's explicit scope: refactoring, code cleanup,
  simplifications, `package-lock.json` updates, coverage improvements beyond the one
  regression test this fix requires, Node version/engines policy changes, dead-code
  removal, or any other housekeeping. Those are deferred to a separate future Cleanup
  Sprint. If you notice one of these while working, do not fix it — leave a one-line
  note in your final report instead.
- Update documentation only if the implementation actually requires it (this task does
  not touch anything documented in README/ARCHITECTURE/CHANGELOG's existing prose, so no
  doc changes are expected — confirm this remains true rather than editing docs
  speculatively).
- Commit only the specific files touched — never `git add -A` or `.`. Do not amend or
  rebase.

---

## Task 1 — Fix: Debug Mode terminal-launcher crash on spawn failure

**Files:**
- Modify: `src/services/debugTerminalLauncher.js:93-107` (the `launchDebugTerminal`
  function)
- Test: `tests/debugTerminalLauncher.test.js`

**Problem (verified, reproduced):** `launchDebugTerminal()` calls
`spawnFn(command, args, {...})` and immediately calls `child.unref()`, but never attaches
an `"error"` listener to the returned child process. If the actual OS-level spawn fails
asynchronously — a stale/broken terminal binary (e.g. a broken Windows Terminal App
Execution Alias), a permissions/AV block, or any other reason the command named by
`detectTerminal()`'s PATH probe turns out not to actually be executable — Node emits an
`"error"` event on the child. An `EventEmitter`'s `"error"` event with no listener throws
the error synchronously out of `.emit()`, which for a real `ChildProcess` surfaces as an
uncaught exception with no handler anywhere in this codebase (confirmed: no
`process.on("uncaughtException", ...)` exists in `src/cli/entry.js` or anywhere else).
This crashes the entire MCP server process — killing every other in-flight job, not just
the debug job that triggered it, since there is exactly one `server.js` process serving
all jobs for a given client connection.

**Fix:** attach a `child.once("error", () => {})` listener immediately after spawning,
before `child.unref()`. This does not change any return value or externally observable
success-path behavior — `invokeInDebugMode()`'s existing `response.json` poll loop
already has its own `DEBUG_TIMEOUT` failure path if the terminal never actually opens and
runs the debug job, so a swallowed launch error still surfaces to the user as a job
failure (a timeout), not silently as nothing at all — it just no longer takes the whole
server down with it.

**Interfaces:**
- Consumes: nothing new — `spawnFn`'s injected fake in tests must now support `.once()`
  in addition to `.unref()` (see Step 1's update to the existing test's fake child).
- Produces: no change to `launchDebugTerminal()`'s return shape
  (`{terminalKind, command, args}`) or call signature — purely internal.

- [ ] **Step 1: Update the existing fake-child test so it doesn't break once `.once()` is called**

`tests/debugTerminalLauncher.test.js`'s existing test constructs a fake child as a plain
object with only `.unref`. Once the fix calls `child.once("error", ...)`, that plain
object has no `.once` method and would throw `TypeError: fakeChild.once is not a
function`. Update it to add a no-op stub — find this existing test:

```js
test("launchDebugTerminal spawns with shell:false and detached:true, and unrefs the child", () => {
  let capturedCall = null;
  const fakeChild = { unref: () => {}, unrefCalled: false };
  fakeChild.unref = () => {
    fakeChild.unrefCalled = true;
  };
  const spawnFn = (command, args, options) => {
    capturedCall = { command, args, options };
    return fakeChild;
  };
```

and change the `fakeChild` declaration to:

```js
test("launchDebugTerminal spawns with shell:false and detached:true, and unrefs the child", () => {
  let capturedCall = null;
  const fakeChild = { unref: () => {}, once: () => {}, unrefCalled: false };
  fakeChild.unref = () => {
    fakeChild.unrefCalled = true;
  };
  const spawnFn = (command, args, options) => {
    capturedCall = { command, args, options };
    return fakeChild;
  };
```

(the rest of that test is unchanged).

- [ ] **Step 2: Write the new failing regression test**

Add this new test to `tests/debugTerminalLauncher.test.js`, after the existing
`"launchDebugTerminal spawns with shell:false..."` test. First add the import at the top
of the file, alongside the existing imports:

```js
import { EventEmitter } from "node:events";
```

Then the new test:

```js
test("launchDebugTerminal attaches an error listener so an async spawn failure never crashes the process", () => {
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const spawnFn = () => fakeChild;

  launchDebugTerminal({ ...PATHS, spawnFn, platform: "win32", pathExists: () => false });

  // Without an "error" listener attached, emitting "error" on an EventEmitter with no
  // listener throws synchronously (Node's special-cased behavior for the "error" event) --
  // exactly what happens when a real ChildProcess's underlying spawn fails asynchronously
  // (e.g. ENOENT for a stale/broken terminal binary) and nothing is listening. That would
  // crash the whole MCP server process, taking down every other in-flight job with it.
  assert.doesNotThrow(() => {
    fakeChild.emit("error", new Error("spawn wt.exe ENOENT"));
  });
});
```

- [ ] **Step 3: Run the tests to verify the new one fails and the existing one still passes**

Run: `node --test tests/debugTerminalLauncher.test.js`

Expected: the existing tests pass (Step 1's fix keeps them green), and the new test from
Step 2 FAILS with something like `Error: spawn wt.exe ENOENT` propagating out of
`fakeChild.emit("error", ...)` uncaught by `assert.doesNotThrow` — i.e. the assertion
itself throws because the emit throws.

- [ ] **Step 4: Implement the fix**

In `src/services/debugTerminalLauncher.js`, find:

```js
  const terminal = detectTerminal(platform, pathExists);
  const { command, args } = buildLaunchInvocation(terminal, { nodeExe, runnerScriptPath, invocationJsonPath, jobId });
  const child = spawnFn(command, args, { shell: false, detached: true, stdio: "ignore" });
  child.unref();
  return { terminalKind: terminal.kind, command, args };
```

and change it to:

```js
  const terminal = detectTerminal(platform, pathExists);
  const { command, args } = buildLaunchInvocation(terminal, { nodeExe, runnerScriptPath, invocationJsonPath, jobId });
  const child = spawnFn(command, args, { shell: false, detached: true, stdio: "ignore" });
  // A terminal-launch spawn failure (stale/broken binary, permissions, AV interference) fires
  // asynchronously as an "error" event on the child. With no listener, Node treats an
  // unhandled "error" event as an uncaught exception -- crashing the whole MCP server
  // process, including every other in-flight job, not just this debug job. Swallow it here
  // instead; invokeInDebugMode()'s existing response.json poll loop already times this job
  // out safely (DEBUG_TIMEOUT) if the terminal never actually opens.
  child.once("error", () => {});
  child.unref();
  return { terminalKind: terminal.kind, command, args };
```

- [ ] **Step 5: Run the tests to verify everything passes**

Run: `node --test tests/debugTerminalLauncher.test.js`

Expected: all tests pass, including the new one from Step 2.

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: 179/179 passing (178 pre-existing + 1 new).

- [ ] **Step 7: Commit**

```bash
git add src/services/debugTerminalLauncher.js tests/debugTerminalLauncher.test.js
git commit -m "Fix Debug Mode terminal launcher crashing the whole server on spawn failure

launchDebugTerminal() never attached an error listener to the spawned
child process. An async spawn failure (stale/broken terminal binary,
permissions, AV block) fired an unhandled 'error' event, which Node
treats as an uncaught exception -- crashing the entire MCP server
process and every other in-flight job with it, not just the debug job
that triggered it. Reproduced on this machine before the fix.

Swallowing the error here is safe: invokeInDebugMode()'s existing
response.json poll loop already times the job out (DEBUG_TIMEOUT) if
the terminal never actually opens and runs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2 — Investigation: duplicate `server.js` instances and job-tracking loss

**This is an investigation/ADR task, not a code task.** Per the user's explicit
instruction for this sprint: implement the safest solution only if it can be completed
without changing frozen public contracts and without guessing at unverified host
behavior; otherwise produce an ADR and stop.

**Files:**
- Create: `docs/adr/ADR-0004-server-instance-lifecycle.md`

**Background (already investigated by the controller before this plan was written, not
left for the ADR author to re-derive):**

- Confirmed via direct code reading: `src/cli/entry.js` has no lockfile, PID file, or
  port-bind check anywhere in its startup path — nothing prevents a second `server.js`
  process from starting concurrently with a live one.
- Confirmed via reading `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js`:
  `StdioServerTransport` only ever calls `this._stdin.on("data", ...)` and
  `this._stdin.on("error", ...)`. It registers no `"end"`/`"close"` handler on `stdin`
  and never calls `process.exit()` on its own. The server currently has **no
  self-detection mechanism for "my client has disconnected"** — it relies entirely on
  receiving an explicit `SIGINT`/`SIGTERM` from the OS/parent (handled in
  `src/cli/entry.js`'s `shutdown()`).
- This matters specifically because the transport is `stdio`, which is inherently a 1:1
  parent-child pipe: each legitimate concurrent Claude Desktop window/session spawning
  its own `server.js` is normal, correct, intended multi-client operation, NOT a bug —
  each instance only needs to track its own jobs. The bug is specifically **stale,
  orphaned instances that should have exited but didn't**, not "more than one instance
  exists."
- This means a naive global single-instance lock (e.g. a PID/lockfile that refuses a
  second `server.js` from starting at all) is very likely the WRONG fix — it would break
  legitimate concurrent multi-window usage, which is a real regression, not just "not the
  safest solution."
- The likelier correct, safer, narrowly-scoped fix is: detect the server's OWN `stdin`
  ending (`process.stdin.on("end", ...)` or `"close"`) and route it through the same
  `shutdown()` path `SIGINT`/`SIGTERM` already use in `src/cli/entry.js`. This only
  causes an instance whose OWN client has actually disconnected to exit — it does not
  affect any other concurrently-running, still-connected instance.
- **Why this sprint does not implement that fix directly**: correctness here depends on
  how the actual MCP host (Claude Desktop) manages its child process's lifecycle on
  Windows — specifically, whether it ever lets `server.js`'s stdin pipe end without also
  forcefully terminating the process, and whether Windows' limited/non-POSIX signal
  delivery model (Node's `SIGTERM` support on Windows is documented as limited compared
  to POSIX) already causes `shutdown()` to never fire on that path today. Verifying this
  with certainty would require deliberately killing/restarting the live MCP connection
  this very session depends on — a live-session-disrupting experiment that should not be
  done casually mid-sprint. Implementing a stdin-close-based shutdown without that
  verification risks getting server lifecycle semantics subtly wrong, which directly
  contradicts this sprint's explicit goal ("reliability, not code cleanliness" — a wrong
  "fix" is worse than the documented status quo).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/ADR-0004-server-instance-lifecycle.md` with these sections (use the same
ADR format as `docs/adr/ADR-0003-observability-architecture.md` — check that file's
heading structure before writing, and match it):

- **Context**: the confirmed findings above (no startup guard; no stdin-close detection
  in the SDK transport; stdio is inherently per-client; the actual bug is stale-instance
  accumulation, not "concurrency" per se). Cite the exact file:line evidence.
- **Decision**: no code change in this sprint. Recommend `stdin`-close-triggered
  self-shutdown (reusing the existing `shutdown()` function in `src/cli/entry.js`) as the
  leading candidate for a future wave, contingent on verifying actual Claude-Desktop /
  MCP-host child-process lifecycle behavior first (a live-session experiment, deliberately
  scheduled rather than done incidentally mid-sprint).
- **Alternatives considered**: (a) global single-instance lockfile/PID check — rejected
  as likely-wrong because it would block legitimate concurrent multi-window usage, not
  just duplicate/stale instances; (b) stdin-close self-shutdown — recommended, pending
  host-behavior verification; (c) do nothing — rejected because the underlying job-
  tracking-loss defect (documented in the prior sprint's `SPRINT_REPORT.md`) remains
  real, even if narrowly scoped and currently mitigated by "don't batch `delegate_*`
  calls."
- **Consequences**: the known limitation remains open and documented (same operating
  rule as before: avoid concurrent `delegate_*` MCP calls); a future wave should verify
  host behavior first, then implement (b) with its own dedicated test/review cycle.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-0004-server-instance-lifecycle.md
git commit -m "Add ADR-0004: investigate duplicate server.js instance lifecycle

Confirmed root-cause candidates for the known concurrent-dispatch
job-tracking limitation: no startup single-instance guard, and the MCP
SDK's StdioServerTransport never detects its own stdin closing to
self-shut-down. A naive global instance lock would break legitimate
concurrent multi-window usage, so it is rejected. The likelier correct
fix (stdin-close self-shutdown) requires verifying actual MCP-host
child-process lifecycle behavior first -- not done in this sprint, per
this sprint's explicit 'ADR and stop' instruction for anything not
safely implementable without guessing.

No code changes; investigation and decision record only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## After Both Tasks

1. Dispatch a task-scoped reviewer for Task 1 (spec + code quality) per
   `subagent-driven-development`.
2. Task 2 has no code to review in the usual sense (it's a decision record) — still
   worth a lightweight reviewer pass to confirm the ADR's evidence claims are accurate
   and its reasoning is sound, not just self-consistent.
3. Run the full whole-branch review, `verification-before-completion`, `ponytail-review`,
   `ponytail-audit`.
4. `finishing-a-development-branch`.
5. Write the sprint's deliverables: `SPRINT_REPORT.md` (framed as this sprint's Stability
   Report, per the user's explicit request), `REVIEW_REPORT.md`, `VALUE_REPORT.md`,
   `PERFORMANCE_REPORT.md`, and `CHANGELOG.md` only if the landed change actually warrants
   a changelog entry (a crash-fix in an opt-in, still-unreleased-to-any-external-user
   Debug Mode feature — decide at that point whether this rises to a user-facing
   changelog entry or stays internal to the sprint reports).
