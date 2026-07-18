import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { delayTask } from "./testUtils.js";

// WP0 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §4): createDelegationBackend() is the
// Extract-Function refactor of createMcpServer's inline construction block. This file proves the
// two things WP0's acceptance criteria name -- the returned shape, and independent-instance
// isolation (Review Package §7 item 3: two separate calls in one process, mirroring real
// entry.js + restEntry.js, never share module-level state) -- plus that the returned pieces are
// actually wired together, not just present.

const root = mkdtempSync(join(tmpdir(), "claude-delegate-delegationbackend-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("createDelegationBackend returns exactly {jobManager, bus, observabilityService, delegationService, eventHistoryStore} for the default config", () => {
  const config = loadConfig({});
  const backend = createDelegationBackend({ config, logger });

  assert.ok(backend.jobManager instanceof JobManager);
  assert.equal(typeof backend.bus.publish, "function");
  assert.equal(typeof backend.bus.subscribeAll, "function");
  assert.equal(typeof backend.observabilityService.getMetrics, "function");
  assert.equal(typeof backend.observabilityService.close, "function");
  assert.equal(typeof backend.delegationService.submit, "function");
  assert.equal(typeof backend.delegationService.getJob, "function");
  assert.equal(typeof backend.delegationService.listJobs, "function");
  assert.equal(typeof backend.delegationService.cancelJob, "function");
  assert.equal(backend.eventHistoryStore, undefined, "default config has eventHistory unset -> 'memory'");

  assert.deepEqual(
    Object.keys(backend).sort(),
    ["bus", "delegationService", "eventHistoryStore", "jobManager", "observabilityService"]
  );
});

test("createDelegationBackend constructs a real EventHistoryStore when config.eventHistory is 'file', shared between the write-side bridge and ObservabilityService's replay engine", () => {
  const dir = join(root, "shared-instance-a");
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: dir };

  const backend = createDelegationBackend({ config, logger });
  assert.ok(backend.eventHistoryStore, "expected a constructed EventHistoryStore");

  // Write directly through the exact object createDelegationBackend constructed -- production
  // code reaches this same object only via the write-side bridge (wireEventHistoryIfEnabled), so
  // this stands in for "the bridge wrote an event", without also populating TimelineStore's
  // runtime tier (which a bus.publish() would, making replay() prefer "runtime" over "durable"
  // and defeating the point of this test -- mirrors tests/mcpServer.test.js's own idiom for the
  // equivalent createMcpServer-level test).
  const jobId = "7c9e6ea1-4f7f-4c8b-9d2a-1e6b0c9f2a3d";
  backend.eventHistoryStore.append({
    eventId: "e1",
    jobId,
    type: "JobQueued",
    timestamp: new Date().toISOString(),
    payload: {},
  });

  const replayed = backend.observabilityService.replay(jobId);
  assert.equal(replayed.source, "durable", "the bridge and the replay engine must observe the SAME eventHistoryStore instance");
  assert.equal(replayed.timeline.length, 1);
});

test("createDelegationBackend actually wires jobManager -> delegationService -> observabilityService together (a submitted job is visible through both)", async () => {
  const config = loadConfig({});
  const backend = createDelegationBackend({ config, logger });

  const jobId = backend.jobManager.submit(delayTask(5, "done"));
  await backend.jobManager.waitForCompletion(jobId);

  const viaDelegationService = backend.delegationService.getJob(jobId);
  assert.equal(viaDelegationService.status, "completed");

  const snapshot = backend.observabilityService.getSnapshot();
  assert.equal(snapshot.metrics.completedJobs, 1);
});

test("createDelegationBackend accepts an optional service override, passed through to the DelegationService it constructs -- WP5's integration tests need this to avoid spawning the real claude CLI", async () => {
  const config = loadConfig({});
  const invokeCalls = [];
  const service = {
    invoke: (prompt, context, cfg, opts) => {
      invokeCalls.push(prompt);
      opts.onSpawn?.();
      return Promise.resolve({ raw: "{}", parsed: { result: "stub" }, exitCode: 0 });
    },
  };

  const backend = createDelegationBackend({ config, logger, service });
  const jobId = backend.delegationService.submit(
    { prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 },
    "rest"
  );
  await backend.jobManager.waitForCompletion(jobId);

  assert.deepEqual(invokeCalls, ["hi"], "the injected stub service, not the real CLI, must have been called");
  assert.equal(backend.delegationService.getJob(jobId).status, "completed");
});

test("two independent createDelegationBackend() calls in one process share no module-level state -- a job submitted via one is invisible to the other", async () => {
  const config = loadConfig({});
  const mcpSide = createDelegationBackend({ config, logger }); // mirrors entry.js's own call
  const restSide = createDelegationBackend({ config, logger }); // mirrors restEntry.js's own call

  const jobId = mcpSide.jobManager.submit(delayTask(5, "done"));
  await mcpSide.jobManager.waitForCompletion(jobId);

  assert.ok(mcpSide.delegationService.getJob(jobId), "the submitting backend sees its own job");
  assert.equal(restSide.delegationService.getJob(jobId), undefined, "a second independently-constructed backend never sees a job submitted to the first");
  assert.deepEqual(restSide.delegationService.listJobs(), [], "listJobs() on the second backend is also unaffected");

  assert.notEqual(mcpSide.bus, restSide.bus, "each call gets its own RuntimeEventBus instance");
  assert.notEqual(mcpSide.jobManager, restSide.jobManager, "each call gets its own JobManager instance");
});
