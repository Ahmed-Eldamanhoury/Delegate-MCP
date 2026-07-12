import { test } from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/services/jobManager.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";
import { delayTask, failTask, waitUntil } from "./testUtils.js";

function collectEvents(bus) {
  const events = [];
  bus.subscribeAll((event) => events.push(event));
  return events;
}

test("a completed job publishes exactly: JobQueued, JobStateChanged x2, JobCompleted — in order, no duplicates", async () => {
  const bus = createRuntimeEventBus();
  const events = collectEvents(bus);
  const manager = new JobManager({ bus, maxConcurrent: 1 });

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "completed");

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    EVENT_TYPES.JOB_QUEUED,
    EVENT_TYPES.JOB_STATE_CHANGED, // queued -> starting
    EVENT_TYPES.JOB_STATE_CHANGED, // starting -> running
    EVENT_TYPES.JOB_COMPLETED,
  ]);
  assert.ok(events.every((e) => e.jobId === id));

  const stateChanges = events.filter((e) => e.type === EVENT_TYPES.JOB_STATE_CHANGED);
  assert.deepEqual(
    stateChanges.map((e) => `${e.payload.from}->${e.payload.to}`),
    ["queued->starting", "starting->running"]
  );

  const completed = events.find((e) => e.type === EVENT_TYPES.JOB_COMPLETED);
  assert.equal(completed.payload.exitCode, 0);
  assert.ok(completed.payload.runtimeMs >= 0);
});

test("a failed job publishes JobFailed with the error, not JobCompleted or a duplicate", async () => {
  const bus = createRuntimeEventBus();
  const events = collectEvents(bus);
  const manager = new JobManager({ bus, maxConcurrent: 1 });

  const id = manager.submit(failTask("boom"));
  await waitUntil(() => manager.getJob(id).status === "failed");

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_FAILED]);
  const failed = events.find((e) => e.type === EVENT_TYPES.JOB_FAILED);
  assert.equal(failed.payload.error, "boom");
  assert.equal(events.filter((e) => e.type === EVENT_TYPES.JOB_COMPLETED).length, 0);
});

test("cancelling a queued job publishes JobQueued then JobCancelled directly (no StateChanged, it never started)", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  manager.submit(delayTask(50, "occupant")); // occupies the only slot

  const events = collectEvents(bus);
  const id = manager.submit(delayTask(50, "second"));
  assert.equal(manager.cancelJob(id), true);

  assert.deepEqual(
    events.map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_CANCELLED]
  );
});

test("cancelling a running job publishes JobCancelled, not JobFailed", async () => {
  const bus = createRuntimeEventBus();
  const events = collectEvents(bus);
  const manager = new JobManager({ bus, maxConcurrent: 1 });

  const id = manager.submit(delayTask(2000, "never"));
  await waitUntil(() => manager.getJob(id).status === "running");
  manager.cancelJob(id);
  await waitUntil(() => manager.getJob(id).status === "cancelled");

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_CANCELLED]);
});

test("concurrent jobs' events are correctly attributed to their own jobId, never cross-contaminated", async () => {
  const bus = createRuntimeEventBus();
  const events = collectEvents(bus);
  const manager = new JobManager({ bus, maxConcurrent: 3 });

  const idA = manager.submit(delayTask(10, "a"));
  const idB = manager.submit(delayTask(15, "b"));
  const idC = manager.submit(delayTask(5, "c"));

  await Promise.all(
    [idA, idB, idC].map((id) => waitUntil(() => manager.getJob(id).status === "completed"))
  );

  for (const id of [idA, idB, idC]) {
    const forThisJob = events.filter((e) => e.jobId === id).map((e) => e.type);
    assert.deepEqual(forThisJob, [
      EVENT_TYPES.JOB_QUEUED,
      EVENT_TYPES.JOB_STATE_CHANGED,
      EVENT_TYPES.JOB_STATE_CHANGED,
      EVENT_TYPES.JOB_COMPLETED,
    ]);
  }
  // No event ever has a jobId outside the three submitted.
  assert.ok(events.every((e) => [idA, idB, idC].includes(e.jobId)));
});

test("a store failure during the starting transition still publishes exactly one terminal event (JobFailed), not a duplicate", async () => {
  const bus = createRuntimeEventBus();
  const events = collectEvents(bus);
  const { InMemoryJobStore } = await import("../src/services/jobStore.js");
  const store = new InMemoryJobStore();
  const realUpdate = store.update.bind(store);
  let calls = 0;
  store.update = (id, patch) => {
    calls++;
    if (calls === 1) throw new Error("simulated store failure");
    return realUpdate(id, patch);
  };
  const manager = new JobManager({ bus, store, maxConcurrent: 1 });

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "failed");

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_FAILED]);
});
