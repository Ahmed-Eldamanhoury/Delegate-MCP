import { test } from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { createDelegationService } from "../src/services/delegationService.js";
import { JobManager } from "../src/services/jobManager.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { loadConfig } from "../src/config/index.js";
import { toJobView } from "../src/models/job.js";
import { delayTask, failTask, waitUntil } from "./testUtils.js";

const logger = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

function baseInput(overrides = {}) {
  return {
    prompt: "say hi",
    model: "sonnet",
    effort: "low",
    allowed_tools: "Read Grep",
    trust_all: false,
    max_budget_usd: 1,
    ...overrides,
  };
}

test("submit() calls jobManager.submit with the right taskFn/metadata shape and calls workspace.createJobWorkspace", () => {
  const config = { spawnTimeoutMs: 1000, baseCwd: "/base" };
  const input = baseInput();
  const stubBus = { tag: "stub-bus" };

  const submitCalls = [];
  const jobManager = {
    bus: stubBus,
    submit(taskFn, metadata) {
      submitCalls.push({ taskFn, metadata });
      return "stub-job-id";
    },
  };

  const invokeCalls = [];
  const service = {
    invoke(prompt, context, cfg, opts) {
      invokeCalls.push({ prompt, context, cfg, opts });
      return Promise.resolve("stub-result");
    },
  };

  const workspaceCalls = [];
  const workspace = {
    createJobWorkspace(jobId, context, cfg, log) {
      workspaceCalls.push({ jobId, context, cfg, log });
    },
  };

  const delegationService = createDelegationService({ jobManager, config, logger, service, workspace });
  const jobId = delegationService.submit(input, "delegate_task");

  assert.equal(jobId, "stub-job-id");
  assert.equal(submitCalls.length, 1, "jobManager.submit must be called exactly once");
  assert.equal(typeof submitCalls[0].taskFn, "function");
  assert.deepEqual(submitCalls[0].metadata, {
    tool: "delegate_task",
    model: input.model,
    effort: input.effort,
    promptPreview: input.prompt.slice(0, 120),
  });

  assert.equal(workspaceCalls.length, 1, "workspace.createJobWorkspace must be called exactly once");
  assert.equal(workspaceCalls[0].jobId, "stub-job-id");
  assert.equal(workspaceCalls[0].cfg, config);
  assert.equal(workspaceCalls[0].log, logger);

  // Exercise the captured taskFn the way JobManager itself would (JobManager._run calls
  // taskFn(signal, markRunning, jobId)), proving submit() wires service.invoke with exactly
  // the (prompt, context, config, {signal, onSpawn, bus, jobId}) shape ADR-0010 specifies.
  const fakeSignal = { aborted: false };
  const markRunning = () => {};
  submitCalls[0].taskFn(fakeSignal, markRunning, "stub-job-id");

  assert.equal(invokeCalls.length, 1);
  assert.equal(invokeCalls[0].prompt, input.prompt);
  assert.equal(invokeCalls[0].cfg, config);
  assert.equal(invokeCalls[0].opts.signal, fakeSignal);
  assert.equal(invokeCalls[0].opts.onSpawn, markRunning);
  assert.equal(invokeCalls[0].opts.bus, stubBus);
  assert.equal(invokeCalls[0].opts.jobId, "stub-job-id");

  // The same ExecutionContext object built once inside submit() must be the one handed to
  // both workspace.createJobWorkspace and service.invoke -- not two independently built ones.
  assert.equal(workspaceCalls[0].context, invokeCalls[0].context);
});

test("submit() throws a ZodError for invalid input before calling jobManager.submit", () => {
  const config = { spawnTimeoutMs: 1000, baseCwd: "/base" };
  let submitCalled = false;
  const jobManager = {
    bus: {},
    submit() {
      submitCalled = true;
      return "should-not-happen";
    },
  };
  const service = {
    invoke() {
      throw new Error("service.invoke must not be called for invalid input");
    },
  };
  const workspace = {
    createJobWorkspace() {
      throw new Error("workspace.createJobWorkspace must not be called for invalid input");
    },
  };

  const delegationService = createDelegationService({ jobManager, config, logger, service, workspace });

  assert.throws(
    () => delegationService.submit({}, "delegate_task"), // missing required `prompt`
    (err) => err instanceof ZodError
  );
  assert.equal(submitCalled, false, "jobManager.submit must never be reached for invalid input");
});

test("getJob() returns undefined for an unknown id, and a toJobView()-shaped object for a known one", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const config = loadConfig({});
  const delegationService = createDelegationService({ jobManager: manager, config, logger });

  assert.equal(delegationService.getJob("00000000-0000-0000-0000-000000000000"), undefined);

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "completed");

  const job = manager.getJob(id);
  assert.deepEqual(delegationService.getJob(id), toJobView(job));
});

test("listJobs() with no arguments defaults to limit 20", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 25 });
  const config = loadConfig({});
  const delegationService = createDelegationService({ jobManager: manager, config, logger });

  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(manager.submit(delayTask(1, `job-${i}`)));
  }
  await Promise.all(ids.map((id) => waitUntil(() => manager.getJob(id).status === "completed")));

  const bare = delegationService.listJobs();
  const explicitEmpty = delegationService.listJobs({});
  assert.equal(bare.length, 20, "listJobs() with no arguments must default limit to 20");
  assert.equal(explicitEmpty.length, 20, "listJobs({}) with no limit must default limit to 20");

  // slice(-limit).reverse(): most recently submitted 20, newest first.
  assert.equal(bare[0].id, ids[24]);
  assert.equal(bare[19].id, ids[5]);
});

test("listJobs() with an explicit status filters correctly", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 5 });
  const config = loadConfig({});
  const delegationService = createDelegationService({ jobManager: manager, config, logger });

  const completedId = manager.submit(delayTask(5, "ok"));
  const failedId = manager.submit(failTask("boom"));
  await waitUntil(() => manager.getJob(completedId).status === "completed");
  await waitUntil(() => manager.getJob(failedId).status === "failed");

  const completedJobs = delegationService.listJobs({ status: "completed" });
  assert.equal(completedJobs.length, 1);
  assert.equal(completedJobs[0].id, completedId);

  const failedJobs = delegationService.listJobs({ status: "failed" });
  assert.equal(failedJobs.length, 1);
  assert.equal(failedJobs[0].id, failedId);
});

test("cancelJob() is a pure pass-through returning exactly what jobManager.cancelJob returns", () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const config = loadConfig({});
  const delegationService = createDelegationService({ jobManager: manager, config, logger });

  manager.submit(delayTask(50, "occupant")); // occupies the only concurrency slot
  const queuedId = manager.submit(delayTask(50, "second"));

  assert.equal(delegationService.cancelJob(queuedId), true);
  assert.equal(manager.getJob(queuedId).status, "cancelled");

  // Now terminal: both the service and the manager itself must agree it's un-cancellable.
  assert.equal(delegationService.cancelJob(queuedId), manager.cancelJob(queuedId));
  // Unknown id: both must agree too.
  assert.equal(delegationService.cancelJob("unknown-id"), manager.cancelJob("unknown-id"));
});
