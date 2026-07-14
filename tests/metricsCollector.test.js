import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsCollector } from "../src/services/metricsCollector.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function evt(type, jobId, payload = {}, timestamp = new Date().toISOString()) {
  return { eventId: `e-${Math.random()}`, timestamp, type, jobId, payload, version: 1 };
}

test("queued -> starting -> running -> completed drives gauges/counters/runtime/queue-wait correctly", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1", {}, "2026-01-01T00:00:00.000Z"));
  assert.equal(collector.getMetrics().queuedJobs, 1);

  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { from: "queued", to: "starting" }, "2026-01-01T00:00:00.100Z"));
  let m = collector.getMetrics();
  assert.equal(m.queuedJobs, 0);
  assert.equal(m.averageQueueWaitMs, 100);

  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { from: "starting", to: "running" }));
  assert.equal(collector.getMetrics().runningJobs, 1);

  collector.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1", { runtimeMs: 500, exitCode: 0 }));
  m = collector.getMetrics();
  assert.equal(m.runningJobs, 0);
  assert.equal(m.completedJobs, 1);
  assert.equal(m.averageRuntimeMs, 500);
  assert.equal(m.maximumRuntimeMs, 500);
});

test("cancelling a still-queued job decrements queuedJobs, not runningJobs, via JobCancelled alone", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  collector.record(evt(EVENT_TYPES.JOB_CANCELLED, "j1", { runtimeMs: null }));

  const m = collector.getMetrics();
  assert.equal(m.queuedJobs, 0);
  assert.equal(m.runningJobs, 0);
  assert.equal(m.cancelledJobs, 1);
});

test("cancelling a running job decrements runningJobs, not queuedJobs", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { to: "starting" }));
  collector.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { to: "running" }));
  collector.record(evt(EVENT_TYPES.JOB_CANCELLED, "j1", { runtimeMs: 42 }));

  const m = collector.getMetrics();
  assert.equal(m.runningJobs, 0);
  assert.equal(m.cancelledJobs, 1);
  assert.equal(m.averageRuntimeMs, 42);
});

test("maximumRuntimeMs tracks the max across multiple completed/failed jobs", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_COMPLETED, "a", { runtimeMs: 100 }));
  collector.record(evt(EVENT_TYPES.JOB_FAILED, "b", { runtimeMs: 900 }));
  collector.record(evt(EVENT_TYPES.JOB_COMPLETED, "c", { runtimeMs: 300 }));

  const m = collector.getMetrics();
  assert.equal(m.maximumRuntimeMs, 900);
  assert.equal(m.averageRuntimeMs, (100 + 900 + 300) / 3);
  assert.equal(m.completedJobs, 2);
  assert.equal(m.failedJobs, 1);
});

test("JobProgress/OutputChunk bump streamingEvents/outputChunks, and eventCount counts every event", () => {
  const collector = createMetricsCollector();
  collector.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  collector.record(evt(EVENT_TYPES.JOB_PROGRESS, "j1", { phase: "thinking" }));
  collector.record(evt(EVENT_TYPES.JOB_PROGRESS, "j1", { phase: "responding" }));
  collector.record(evt(EVENT_TYPES.OUTPUT_CHUNK, "j1", { stream: "stdout" }));

  const m = collector.getMetrics();
  assert.equal(m.streamingEvents, 2);
  assert.equal(m.outputChunks, 1);
  assert.equal(m.eventCount, 4);
  assert.ok(m.progressRate >= 0);
});

test("with no config, workspaceSizeBytes/artifactCount stay null", () => {
  const collector = createMetricsCollector();
  const m = collector.getMetrics();
  assert.equal(m.workspaceSizeBytes, null);
  assert.equal(m.artifactCount, null);
});

test("with a config, workspaceSizeBytes/artifactCount are computed from real files on disk (read-only)", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-metrics-"));
  try {
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    const jobDir = join(workspaceRoot, "jobs", jobId);
    mkdirSync(join(jobDir, "artifacts"), { recursive: true });
    writeFileSync(join(jobDir, "metadata.json"), `{"id":"${jobId}"}`);
    writeFileSync(join(jobDir, "artifacts", "out.txt"), "hello world");

    const collector = createMetricsCollector({ config: { workspaceRoot } });
    const m = collector.getMetrics();
    assert.equal(m.artifactCount, 1);
    assert.ok(m.workspaceSizeBytes > 0);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("artifactCount excludes non-UUID directories under jobs/ (e.g. a manually placed 'notes' dir), while a real job's artifacts still count", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-metrics-"));
  try {
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    const jobDir = join(workspaceRoot, "jobs", jobId);
    mkdirSync(join(jobDir, "artifacts"), { recursive: true });
    writeFileSync(join(jobDir, "artifacts", "out.txt"), "hello world");

    // Not a valid job id (fails isValidJobId) — its contents must not be miscounted as artifacts.
    const notesDir = join(workspaceRoot, "jobs", "notes");
    mkdirSync(join(notesDir, "artifacts"), { recursive: true });
    writeFileSync(join(notesDir, "artifacts", "scratch.txt"), "not a job artifact");

    const collector = createMetricsCollector({ config: { workspaceRoot } });
    const m = collector.getMetrics();
    assert.equal(m.artifactCount, 1);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("a missing workspaceRoot is read as zero usage, never throws", () => {
  const collector = createMetricsCollector({ config: { workspaceRoot: join(tmpdir(), "does-not-exist-obs") } });
  const m = collector.getMetrics();
  assert.equal(m.workspaceSizeBytes, 0);
  assert.equal(m.artifactCount, 0);
});
