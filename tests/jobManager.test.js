import { test } from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/services/jobManager.js";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { JOB_STATUS } from "../src/models/job.js";
import { delayTask, failTask, waitUntil } from "./testUtils.js";

test("submit runs a task through queued -> running -> completed", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  const id = manager.submit(delayTask(10, "done"), { kind: "test" });

  // Note: submit() drains the queue synchronously up to the task's first await, so the job
  // may already be "running" by the time submit() returns — only the eventual state is asserted.
  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.COMPLETED);

  const job = manager.getJob(id);
  assert.equal(job.result, "done");
  assert.equal(job.exitCode, 0);
  assert.ok(job.startedAt && job.finishedAt);
  assert.ok(job.runtimeMs >= 0);
  assert.deepEqual(job.metadata, { kind: "test" });
});

test("a throwing task lands in failed with the error message", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  const id = manager.submit(failTask("boom"));

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.FAILED);
  assert.equal(manager.getJob(id).error, "boom");
});

test("cancelJob on a queued job removes it before it ever runs", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  manager.submit(delayTask(50, "first")); // occupies the only slot
  const secondId = manager.submit(delayTask(50, "second"));

  assert.equal(manager.getJob(secondId).status, JOB_STATUS.QUEUED);
  assert.equal(manager.cancelJob(secondId), true);

  const job = manager.getJob(secondId);
  assert.equal(job.status, JOB_STATUS.CANCELLED);
  assert.equal(job.startedAt, null);
});

test("cancelJob on a running job aborts it", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  const id = manager.submit(delayTask(2000, "never"));

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.RUNNING);
  assert.equal(manager.cancelJob(id), true);
  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.CANCELLED);
});

test("concurrency limit is respected: a second job does not start until the first finishes", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  const firstId = manager.submit(delayTask(30, "a"));
  const secondId = manager.submit(delayTask(10, "b"));

  await waitUntil(() => manager.getJob(secondId).status === JOB_STATUS.COMPLETED);

  const first = manager.getJob(firstId);
  const second = manager.getJob(secondId);
  assert.ok(new Date(second.startedAt).getTime() >= new Date(first.finishedAt).getTime());
});

test("cancelJob on an unknown id returns false", () => {
  const manager = new JobManager();
  assert.equal(manager.cancelJob("does-not-exist"), false);
});

test("a job exposes phase/progressMessage through starting -> running -> completed", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  // markRunning is deliberately delayed (unlike the synchronous delayTask helper) so "starting"
  // is observable as a real, if brief, async gap — mirroring the real subprocess-spawn delay.
  const id = manager.submit(
    (signal, markRunning) =>
      new Promise((resolve) => {
        setTimeout(() => {
          markRunning();
          setTimeout(() => resolve("done"), 10);
        }, 10);
      })
  );

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.STARTING);
  assert.equal(manager.getJob(id).phase, "starting");
  assert.equal(manager.getJob(id).progressMessage, "Spawning claude CLI subprocess");

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.RUNNING);
  assert.equal(manager.getJob(id).phase, "executing");

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.COMPLETED);
  const job = manager.getJob(id);
  assert.equal(job.phase, "completed");
  assert.equal(job.progressMessage, "Finished successfully");
  // A tight ">= 20" bound (the nominal sum of the two chained 10ms setTimeouts above) is
  // fragile to real timer/clock precision variance across environments -- observed failing
  // intermittently on Linux CI while always passing locally on Windows, with runtimeMs
  // reading fractionally under 20. The test's actual intent (per the comment at the top of
  // this test) is only to prove a real, non-synchronous async gap was measured, not to pin
  // an exact millisecond floor. ">= 10" keeps meaningful signal (still well under the ~18-19ms
  // actually observed) without the timing race a tight ">= 20" bound created.
  assert.ok(job.runtimeMs >= 10);
});

test("a store failure during the starting transition surfaces as a failed job, not an unhandled rejection", async () => {
  // The starting transition is JobManager's first store write for a job, made without anyone
  // awaiting/catching _run()'s promise (_drain() fires it and moves on) — so if it isn't inside
  // the same try/catch as every other transition, a throw here has nothing to catch it.
  let calls = 0;
  const store = new InMemoryJobStore();
  const realUpdate = store.update.bind(store);
  store.update = (id, patch) => {
    calls++;
    if (calls === 1) throw new Error("simulated store failure");
    return realUpdate(id, patch);
  };

  const manager = new JobManager({ store, maxConcurrent: 1 });
  const id = manager.submit(delayTask(10, "done"));

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.FAILED);
  assert.equal(manager.getJob(id).error, "simulated store failure");
});

test("_trimHistory evicts oldest terminal jobs once maxHistory is exceeded, never touching queued/running ones", async () => {
  // maxConcurrent: 1 makes completion order deterministic (strictly sequential), which the
  // eviction assertions below depend on.
  const manager = new JobManager({ maxConcurrent: 1, maxHistory: 2 });

  const completedIds = [];
  for (let i = 0; i < 4; i++) {
    completedIds.push(manager.submit(delayTask(5, `done-${i}`)));
  }
  await waitUntil(() => manager.getJob(completedIds[3]).status === JOB_STATUS.COMPLETED);

  let remaining = manager.listJobs();
  assert.equal(remaining.length, 2, "only maxHistory terminal jobs should be retained");
  assert.deepEqual(remaining.map((j) => j.id), completedIds.slice(-2), "oldest terminal jobs evicted first");

  // A job still in flight when the cap is already reached must never be evicted.
  const survivorId = manager.submit(delayTask(5000, "still running"));
  await waitUntil(() => manager.getJob(survivorId).status !== JOB_STATUS.QUEUED);

  remaining = manager.listJobs();
  assert.ok(remaining.some((j) => j.id === survivorId), "in-flight job must never be evicted");
  assert.ok(remaining.length <= 3); // 2 retained terminal + 1 in-flight

  manager.cancelJob(survivorId);
});

test("cancelling a job while it is still starting (before markRunning) aborts it", async () => {
  const manager = new JobManager({ maxConcurrent: 1 });
  // never calls markRunning — simulates a task that hasn't signaled real execution yet
  const id = manager.submit(
    (signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })
  );

  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.STARTING);
  assert.equal(manager.cancelJob(id), true);
  await waitUntil(() => manager.getJob(id).status === JOB_STATUS.CANCELLED);
});
