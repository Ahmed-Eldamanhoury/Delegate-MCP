import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnapshotBuilder } from "../src/services/snapshotBuilder.js";
import { createMetricsCollector } from "../src/services/metricsCollector.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function evt(type, jobId, payload = {}, timestamp = new Date().toISOString()) {
  return { eventId: `e-${Math.random()}`, timestamp, type, jobId, payload, version: 1 };
}

test("build() includes takenAt, current metrics, and active (non-terminal) jobs only", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "queued-job"));
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "running-job"));
  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "running-job", { to: "starting" }));
  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "running-job", { to: "running" }));
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "done-job"));
  collector.record(evt(EVENT_TYPES.JOB_COMPLETED, "done-job", { runtimeMs: 10 }));

  const snapshot = createSnapshotBuilder({ metricsCollector: collector }).build();

  assert.ok(snapshot.takenAt);
  assert.equal(snapshot.metrics.queuedJobs, 1);
  assert.equal(snapshot.metrics.runningJobs, 1);
  assert.equal(snapshot.metrics.completedJobs, 1);

  const jobIds = snapshot.activeJobs.map((j) => j.jobId).sort();
  assert.deepEqual(jobIds, ["queued-job", "running-job"], "terminal jobs must not appear in activeJobs");
});

test("snapshot is deeply immutable: mutation attempts at any level throw or are silently ignored, and never affect a later snapshot", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  const builder = createSnapshotBuilder({ metricsCollector: collector });
  const snapshot = builder.build();

  // ES modules are always strict mode, so assigning to a frozen object's property throws.
  assert.throws(() => (snapshot.metrics.queuedJobs = 999));
  assert.throws(() => snapshot.activeJobs.push({ jobId: "injected" }));
  assert.throws(() => (snapshot.activeJobs[0].jobId = "tampered"));

  // Even if the throws above were somehow swallowed, the live collector must be unaffected.
  const fresh = builder.build();
  assert.equal(fresh.metrics.queuedJobs, 1);
  assert.equal(fresh.activeJobs.length, 1);
  assert.equal(fresh.activeJobs[0].jobId, "j1");
});

test("two snapshots are independent objects — mutating one's clone never touches the other or live state", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  const builder = createSnapshotBuilder({ metricsCollector: collector });

  const first = builder.build();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j2"));
  const second = builder.build();

  assert.equal(first.activeJobs.length, 1, "a snapshot must not change after being taken, even as live state evolves");
  assert.equal(second.activeJobs.length, 2);
  assert.notEqual(first, second);
});

test("build() never calls any mutator on the collector (read-only)", () => {
  let recordCalls = 0;
  const fakeCollector = {
    getMetrics: () => ({ queuedJobs: 0 }),
    getActiveJobs: () => [],
    record: () => {
      recordCalls += 1;
    },
  };
  createSnapshotBuilder({ metricsCollector: fakeCollector }).build();
  assert.equal(recordCalls, 0);
});
