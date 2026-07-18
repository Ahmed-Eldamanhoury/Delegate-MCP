import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerRestShutdownHandlers } from "../src/cli/restEntry.js";

// WP2 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §10): REST's richer shutdown sequence -- stop
// accepting connections -> bounded grace period -> force-cancel any still non-terminal jobs ->
// wait for settlement (bounded) -> close observability -> exit. Small graceMs/forceExitMs values
// keep these tests fast; production uses the real 5000ms/2000ms defaults.

function fakeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    info: (msg, meta) => calls.info.push({ msg, meta }),
    warn: (msg, meta) => calls.warn.push({ msg, meta }),
    error: (msg, meta) => calls.error.push({ msg, meta }),
    calls,
  };
}

function fakeRestServer() {
  let closeCalls = 0;
  return {
    close: async () => {
      closeCalls += 1;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

function fakeJobManager({ jobs = [] } = {}) {
  const cancelled = [];
  const jobsById = new Map(jobs.map((j) => [j.id, j]));
  return {
    listJobs: () => [...jobsById.values()],
    cancelJob: (id) => {
      cancelled.push(id);
      return true;
    },
    waitForCompletion: (id) =>
      new Promise((resolve) => {
        // Resolves once the fake job's own "settle" trigger (attached by the test) fires.
        jobsById.get(id)?.onSettle?.(() => resolve(jobsById.get(id)));
      }),
    get cancelled() {
      return cancelled;
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("SIGINT with no non-terminal jobs: closes the REST server, waits out the grace period, then exits -- no force-cancel needed", async () => {
  const restServer = fakeRestServer();
  const jobManager = fakeJobManager({ jobs: [] });
  const signalSource = new EventEmitter();
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    graceMs: 5,
    forceExitMs: 5,
  });

  signalSource.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(restServer.closeCalls, 1);
  assert.deepEqual(jobManager.cancelled, []);
  assert.equal(exited, true);
});

test("SIGTERM force-cancels any still non-terminal job after the grace period, then waits for it to settle before exiting", async () => {
  const restServer = fakeRestServer();
  let settleCallback;
  const job = { id: "job-1", status: "running", onSettle: (cb) => (settleCallback = cb) };
  const jobManager = fakeJobManager({ jobs: [job] });
  const signalSource = new EventEmitter();
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    graceMs: 5,
    forceExitMs: 1000, // generous -- this test settles the job itself rather than timing out
  });

  signalSource.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 20)); // past the grace period

  assert.deepEqual(jobManager.cancelled, ["job-1"], "the still-running job must be force-cancelled after the grace period");
  assert.equal(exited, false, "must not exit before the cancelled job actually settles");

  settleCallback(); // the job's cancelJob()-triggered abort finally settles, asynchronously
  await flushMicrotasks();

  assert.equal(exited, true);
});

test("exits after forceExitMs even if a force-cancelled job never actually settles -- bounded, not indefinite", async () => {
  const restServer = fakeRestServer();
  const job = { id: "stuck-job", status: "running", onSettle: () => {} }; // never resolves
  const jobManager = fakeJobManager({ jobs: [job] });
  const signalSource = new EventEmitter();
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    graceMs: 20,
    forceExitMs: 30,
  });

  signalSource.emit("SIGINT");
  // Generous wait window (well beyond graceMs+forceExitMs) -- under a full-suite run's system
  // load (many concurrent test-spawned HTTP servers/timers), a too-tight margin here was
  // observed to flake even though the underlying property (bounded, not indefinite exit) held.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(exited, true, "shutdown must exit within its bounded window even if the job never settles");
});

test("a second SIGTERM during an in-progress shutdown is a no-op -- re-entrancy guard", async () => {
  const restServer = fakeRestServer();
  const jobManager = fakeJobManager({ jobs: [] });
  const signalSource = new EventEmitter();
  let exitCount = 0;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exitCount += 1;
    },
    signalSource,
    graceMs: 20,
    forceExitMs: 5,
  });

  signalSource.emit("SIGTERM");
  signalSource.emit("SIGTERM"); // fires mid-grace-period, must not re-enter
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(restServer.closeCalls, 1, "restServer.close() must only be called once");
  assert.equal(exitCount, 1, "exit() must only be called once");
});

test("calls observabilityService.close() alongside the rest of the shutdown sequence, when one is provided", async () => {
  const restServer = fakeRestServer();
  const jobManager = fakeJobManager({ jobs: [] });
  const signalSource = new EventEmitter();
  let observabilityClosed = false;
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    observabilityService: {
      close: () => {
        observabilityClosed = true;
      },
    },
    graceMs: 5,
    forceExitMs: 5,
  });

  signalSource.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(observabilityClosed, true);
  assert.equal(exited, true);
});

test("shutdown still works fine when observabilityService is omitted", async () => {
  const restServer = fakeRestServer();
  const jobManager = fakeJobManager({ jobs: [] });
  const signalSource = new EventEmitter();
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    graceMs: 5,
    forceExitMs: 5,
  });

  signalSource.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(exited, true);
});

test("no stdin-close listener -- REST has no client pipe to watch", async () => {
  // process.stdin's baseline "end" listener count isn't necessarily 0 in every environment (the
  // test runner itself may attach one) -- compare before/after to isolate what THIS function
  // does, rather than asserting an absolute count this test doesn't control.
  const before = process.stdin.listenerCount("end");
  const restServer = fakeRestServer();
  const jobManager = fakeJobManager({ jobs: [] });
  const signalSource = new EventEmitter();
  let exited = false;

  registerRestShutdownHandlers(restServer, jobManager, fakeLogger(), {
    exit: () => {
      exited = true;
    },
    signalSource,
    graceMs: 5,
    forceExitMs: 5,
  });

  assert.equal(process.stdin.listenerCount("end"), before, "must not attach anything to the real process.stdin");
  assert.equal(exited, false);
});

test("importing restEntry.js has no import-time side effects -- it must not start the server", () => {
  const entryPath = fileURLToPath(new URL("../src/cli/restEntry.js", import.meta.url));
  const entryUrl = pathToFileURL(entryPath).href;
  const script = `import(${JSON.stringify(entryUrl)}).then(() => { process.stdout.write("imported-ok"); process.exit(0); });`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(output, "imported-ok");
});
