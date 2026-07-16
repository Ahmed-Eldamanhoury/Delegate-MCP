import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { createObservabilityService } from "../src/services/observabilityService.js";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";
import { persistJobArtifacts } from "../src/services/workspaceManager.js";
import { toJobView } from "../src/models/job.js";
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
  assert.deepEqual(
    Object.keys(observability).sort(),
    [
      "close",
      "getConsumerHealth",
      "getConsumerStatistics",
      "getMetrics",
      "getSnapshot",
      "getTimeline",
      "listConsumers",
      "registerConsumer",
      "replay",
      "touchConsumer",
      "unregisterConsumer",
    ].sort()
  );
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

test("replay() sources from runtime while retained, then falls back to workspace once evicted", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-svc-replay-"));
  try {
    const observability = createObservabilityService({ bus, config: { workspaceRoot }, maxTimelineHistory: 1 });
    const idA = manager.submit(delayTask(5, "a"));
    await waitUntil(() => manager.getJob(idA).status === "completed");
    persistJobArtifacts(idA, toJobView(manager.getJob(idA)), { workspaceRoot }, undefined);

    assert.equal(observability.replay(idA).source, "runtime");

    const idB = manager.submit(delayTask(5, "b")); // pushes TimelineStore past its cap of 1
    await waitUntil(() => manager.getJob(idB).status === "completed");

    const replayed = observability.replay(idA);
    assert.equal(replayed.source, "workspace", "evicted from runtime, must fall back to the persisted workspace mirror");
    assert.ok(replayed.timeline.length > 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

// --- Task 7 (ponytail-audit dedup): createObservabilityService must use the eventHistoryStore
// instance it's handed for ReplayEngine's durable tier, not construct its own from
// config.eventHistory/config.eventHistoryDir (that construction now happens exactly once, in
// mcpServer.js's createMcpServer/selectEventHistoryStore, shared with the write-side bridge). ---

test("createObservabilityService's ReplayEngine durable tier uses exactly the passed eventHistoryStore, never one reconstructed from config.eventHistoryDir", () => {
  const dirWithData = mkdtempSync(join(tmpdir(), "obs-svc-eh-shared-"));
  const dirConfigPointsAt = mkdtempSync(join(tmpdir(), "obs-svc-eh-unused-"));
  try {
    const jobId = "c9b9a6a0-1a2b-4c3d-9e8f-0a1b2c3d4e5f";
    const passedStore = createEventHistoryStore({ dir: dirWithData });
    passedStore.append({
      eventId: "e1",
      jobId,
      type: EVENT_TYPES.JOB_QUEUED,
      timestamp: new Date().toISOString(),
      payload: {},
    });

    const bus = createRuntimeEventBus();
    // config.eventHistoryDir deliberately points at a DIFFERENT, empty directory -- if this
    // function still built its own store from config (the old, duplicated behavior), replay
    // would find nothing there and fall through to "unavailable". Finding the data instead
    // proves it used the exact `eventHistoryStore` object passed in.
    const observability = createObservabilityService({
      bus,
      config: { eventHistory: "file", eventHistoryDir: dirConfigPointsAt },
      eventHistoryStore: passedStore,
    });

    const result = observability.replay(jobId);
    assert.equal(result.source, "durable");
    assert.equal(result.timeline.length, 1);
  } finally {
    rmSync(dirWithData, { recursive: true, force: true });
    rmSync(dirConfigPointsAt, { recursive: true, force: true });
  }
});

test("createObservabilityService's ReplayEngine durable tier is unavailable when eventHistoryStore isn't passed, even if config.eventHistory is 'file' -- construction happens only in mcpServer.js now", () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-svc-eh-not-passed-"));
  try {
    const bus = createRuntimeEventBus();
    const observability = createObservabilityService({
      bus,
      config: { eventHistory: "file", eventHistoryDir: dir },
      // no eventHistoryStore passed
    });

    const result = observability.replay("d3f1a2b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b");
    assert.equal(result.source, "unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSnapshot() reflects live activeJobs and is immutable", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 1 });
  const observability = createObservabilityService({ bus });

  manager.submit(delayTask(50, "still-running"));
  await waitUntil(() => observability.getSnapshot().activeJobs.length > 0);

  const snapshot = observability.getSnapshot();
  assert.equal(snapshot.activeJobs.length, 1);
  assert.throws(() => (snapshot.metrics.queuedJobs = 999));
});

test("consumer registry round-trips through the service: register, list, health, statistics, unregister", () => {
  const bus = createRuntimeEventBus();
  const observability = createObservabilityService({ bus });

  const handle = observability.registerConsumer("dashboard", { transport: "http" });
  assert.equal(observability.listConsumers().length, 1);
  assert.equal(observability.getConsumerHealth(handle.id).active, true);
  assert.deepEqual(observability.getConsumerStatistics(), { activeCount: 1, totalRegistered: 1 });

  assert.equal(observability.unregisterConsumer(handle.id), true);
  assert.equal(observability.listConsumers().length, 0);
  assert.deepEqual(observability.getConsumerStatistics(), { activeCount: 0, totalRegistered: 1 });
});

test("concurrency: replay/getSnapshot/consumer registry all stay correct while several jobs run at once", async () => {
  const bus = createRuntimeEventBus();
  const manager = new JobManager({ bus, maxConcurrent: 5 });
  const observability = createObservabilityService({ bus });
  observability.registerConsumer("consumer-a");
  observability.registerConsumer("consumer-b");

  const ids = [10, 15, 5, 20, 8].map((ms) => manager.submit(delayTask(ms, "x")));
  await Promise.all(ids.map((id) => waitUntil(() => manager.getJob(id).status === "completed")));

  for (const id of ids) {
    assert.equal(observability.replay(id).source, "runtime");
  }
  assert.equal(observability.getSnapshot().activeJobs.length, 0);
  assert.equal(observability.getConsumerStatistics().activeCount, 2);
});
