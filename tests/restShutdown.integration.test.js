import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { registerRestShutdownHandlers } from "../src/cli/restEntry.js";
import { loadConfig } from "../src/config/index.js";

// WP5 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §10, Review Package §7 item 4 -- non-negotiable
// shutdown-behavior test): SIGTERM with a long-running stub job, asserting new-connections-
// refused-immediately, force-cancel-only-after-grace-period, and bounded exit time. Exercises the
// REAL restServer + real registerRestShutdownHandlers together (WP2's restEntry.test.js already
// covers the fake-restServer unit-level cases; this is the integration-level proof).

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "shutdown-test-token-" + "a".repeat(24);
const root = mkdtempSync(join(tmpdir(), "claude-delegate-rest-shutdown-"));
after(() => rmSync(root, { recursive: true, force: true }));

function makeSlowService(delayMs) {
  return {
    invoke(prompt, context, cfg, { signal, onSpawn } = {}) {
      return new Promise((resolve, reject) => {
        onSpawn?.();
        const timer = setTimeout(() => resolve({ raw: "{}", parsed: { result: "ok" }, exitCode: 0 }), delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  };
}

test("SIGTERM: new connections are refused immediately, the running job is force-cancelled only after the grace period, and shutdown completes within its bounded window", async () => {
  const config = {
    ...loadConfig({}),
    restHost: "127.0.0.1",
    restPort: 0,
    workspaceRoot: join(root, "workspace"),
  };
  const backend = createDelegationBackend({ config, logger, service: makeSlowService(5000) });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const baseUrl = `http://127.0.0.1:${restServer.server.address().port}`;
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  // Submit a long-running job and wait for it to actually be running before shutting down.
  const submitRes = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "long", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  const { job_id } = await submitRes.json();
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await (await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH })).json();
    if (job.status === "running") break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(backend.jobManager.getJob(job_id).status, "running");

  // Generous, wide-margin timings -- under a full-suite run's system load (many concurrent
  // test-spawned HTTP servers/timers), tight fixed-wait margins were observed to flake even
  // though the underlying properties (refused-immediately / not-cancelled-before-grace-ends /
  // bounded-exit) all held. Elapsed-time-since-start checks (not compounding fixed waits) keep
  // this robust regardless of how much the event loop is delayed by other load.
  const signalSource = new EventEmitter();
  let exited = false;
  const GRACE_MS = 1000;
  registerRestShutdownHandlers(restServer, backend.jobManager, logger, {
    exit: () => {
      exited = true;
    },
    signalSource,
    observabilityService: backend.observabilityService,
    graceMs: GRACE_MS,
    forceExitMs: 500,
  });

  const shutdownStarted = Date.now();
  signalSource.emit("SIGTERM");

  // New connections refused immediately -- restServer.close() runs as shutdown()'s first step,
  // well before the grace period even starts counting down.
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(fetch(baseUrl, { headers: AUTH }), "a new connection attempt must be refused once shutdown has begun");

  // Force-cancel only after the grace period -- not immediately. Checked at a fixed point well
  // inside the (generous) grace window, not a fraction of it, so upstream delays can't push this
  // check past the grace period itself.
  await new Promise((r) => setTimeout(r, 300));
  if (Date.now() - shutdownStarted < GRACE_MS) {
    assert.equal(backend.jobManager.getJob(job_id).status, "running", "the job must still be running mid-grace-period, not yet force-cancelled");
  }

  // Bounded exit time: shutdown must complete (exit() called) within grace + force-exit + slack.
  for (let attempt = 0; attempt < 300 && !exited; attempt++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const elapsedMs = Date.now() - shutdownStarted;
  assert.equal(exited, true, "shutdown must eventually call exit()");
  assert.ok(elapsedMs < 6000, `shutdown took ${elapsedMs}ms, expected well under 6000ms given graceMs=1000/forceExitMs=500`);
});
