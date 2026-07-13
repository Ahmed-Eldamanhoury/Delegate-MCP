import { test } from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/services/jobManager.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { createObservabilityService } from "../src/services/observabilityService.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";
import { delayTask, failTask, waitUntil } from "./testUtils.js";

test("a full completed-job lifecycle is reflected in both metrics and timeline", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const observability = createObservabilityService({ bus });

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "completed");

  const metrics = observability.getMetrics();
  assert.equal(metrics.completedJobs, 1);
  assert.equal(metrics.queuedJobs, 0);
  assert.equal(metrics.runningJobs, 0);
  assert.ok(metrics.averageRuntimeMs >= 0);

  const timeline = observability.getTimeline(id);
  assert.deepEqual(
    timeline.map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_COMPLETED]
  );
});

test("a failed job is reflected as failedJobs, not completedJobs", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const observability = createObservabilityService({ bus });

  const id = manager.submit(failTask("boom"));
  await waitUntil(() => manager.getJob(id).status === "failed");

  const metrics = observability.getMetrics();
  assert.equal(metrics.failedJobs, 1);
  assert.equal(metrics.completedJobs, 0);
  assert.deepEqual(
    observability.getTimeline(id).map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_FAILED]
  );
});

test("cancelling a queued job is reflected as cancelledJobs with queuedJobs back at zero", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  manager.submit(delayTask(50, "occupant")); // occupies the only concurrency slot
  const observability = createObservabilityService({ bus });

  const id = manager.submit(delayTask(50, "second"));
  manager.cancelJob(id);
  await waitUntil(() => manager.getJob(id).status === "cancelled");

  const metrics = observability.getMetrics();
  assert.equal(metrics.cancelledJobs, 1);
  assert.equal(metrics.queuedJobs, 0);
});

test("concurrency: multiple simultaneous jobs are all correctly counted, no lost updates", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 5 });
  const observability = createObservabilityService({ bus });

  const ids = [10, 15, 5, 20, 8].map((ms) => manager.submit(delayTask(ms, "x")));
  await Promise.all(ids.map((id) => waitUntil(() => manager.getJob(id).status === "completed")));

  const metrics = observability.getMetrics();
  assert.equal(metrics.completedJobs, 5);
  assert.equal(metrics.runningJobs, 0);
  assert.equal(metrics.queuedJobs, 0);
  for (const id of ids) {
    assert.equal(
      observability.getTimeline(id).at(-1).type,
      EVENT_TYPES.JOB_COMPLETED,
      "every job's own timeline must end in its own JobCompleted, never mixed with another job's"
    );
  }
});

test("Passive Observation Rule: ObservabilityService exposes no job/bus mutator methods", () => {
  const bus = createRuntimeEventBus();
  const observability = createObservabilityService({ bus });

  for (const forbidden of ["submit", "cancelJob", "publish", "waitForCompletion"]) {
    assert.equal(typeof observability[forbidden], "undefined", `must not expose ${forbidden}`);
  }
  assert.deepEqual(Object.keys(observability).sort(), ["close", "getMetrics", "getTimeline"]);
});

test("Passive Observation Rule: observing a job never changes JobManager's own state or timing", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const observability = createObservabilityService({ bus });

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "completed");
  observability.getMetrics();
  observability.getTimeline(id);

  const job = manager.getJob(id);
  assert.equal(job.status, "completed");
  assert.equal(manager.cancelJob(id), false, "a terminal job must remain immutable regardless of observation");
});

test("close() unsubscribes from the bus — further events are no longer observed", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const observability = createObservabilityService({ bus });
  observability.close();

  const id = manager.submit(delayTask(5, "done"));
  await waitUntil(() => manager.getJob(id).status === "completed");

  const metrics = observability.getMetrics();
  assert.equal(metrics.completedJobs, 0, "no events should have been recorded after close()");
});

test("retention cap is honored end-to-end: oldest terminal job's timeline is evicted", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 3 });
  const observability = createObservabilityService({ bus, maxTimelineHistory: 2 });

  const idA = manager.submit(delayTask(5, "a"));
  await waitUntil(() => manager.getJob(idA).status === "completed");
  const idB = manager.submit(delayTask(5, "b"));
  await waitUntil(() => manager.getJob(idB).status === "completed");
  const idC = manager.submit(delayTask(5, "c"));
  await waitUntil(() => manager.getJob(idC).status === "completed");

  assert.deepEqual(observability.getTimeline(idA), [], "oldest terminal job's timeline must be evicted past the cap");
  assert.ok(observability.getTimeline(idC).length > 0);
});
