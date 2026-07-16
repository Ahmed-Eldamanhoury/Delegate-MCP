import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function fakeObservabilityService() {
  let closeCalls = 0;
  return {
    close: () => {
      closeCalls += 1;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

test("shutdown calls observabilityService.close() (unsubscribing from the bus) alongside server.close(), when one is provided", async () => {
  const server = fakeServer();
  const observabilityService = fakeObservabilityService();
  const signalSource = new EventEmitter();
  let exited = false;
  registerShutdownHandlers(server, fakeLogger(), {
    stdin: new EventEmitter(),
    exit: () => {
      exited = true;
    },
    signalSource,
    observabilityService,
  });

  signalSource.emit("SIGINT");
  await flushMicrotasks();

  assert.equal(server.closeCalls, 1);
  assert.equal(observabilityService.closeCalls, 1);
  assert.equal(exited, true);
});

test("shutdown still works fine (doesn't throw, still exits) when observabilityService is omitted -- backward compat with the existing calling convention", async () => {
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

test("importing entry.js has no import-time side effects — it must not start the server", () => {
  const entryPath = fileURLToPath(new URL("../src/cli/entry.js", import.meta.url));
  const entryUrl = pathToFileURL(entryPath).href;
  const script = `import(${JSON.stringify(entryUrl)}).then(() => { process.stdout.write("imported-ok"); process.exit(0); });`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(output, "imported-ok");
});
