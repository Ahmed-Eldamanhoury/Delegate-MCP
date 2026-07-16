import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayEngine } from "../src/services/replayEngine.js";
import { createTimelineStore } from "../src/services/timelineStore.js";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function evt(type, jobId, payload = {}, timestamp = new Date().toISOString()) {
  return { eventId: `e-${Math.random()}`, timestamp, type, jobId, payload, version: 1 };
}

test("prefers runtime (TimelineStore) when the job's timeline is still retained", () => {
  const timelineStore = createTimelineStore();
  timelineStore.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  timelineStore.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1"));

  const engine = createReplayEngine({ timelineStore });
  const result = engine.replay("j1");
  assert.equal(result.source, "runtime");
  assert.equal(result.timeline.length, 2);
});

test("falls back to workspace metadata.json when the timeline was evicted/never retained", () => {
  const timelineStore = createTimelineStore();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-replay-"));
  try {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const dir = join(workspaceRoot, "jobs", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        id: jobId,
        status: "completed",
        queuedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.100Z",
        finishedAt: "2026-01-01T00:00:00.500Z",
        runtimeMs: 400,
        exitCode: 0,
        error: null,
      })
    );

    const engine = createReplayEngine({ timelineStore, config: { workspaceRoot } });
    const result = engine.replay(jobId);
    assert.equal(result.source, "workspace");
    assert.deepEqual(
      result.timeline.map((e) => e.type),
      [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_COMPLETED]
    );
    assert.ok(result.timeline.every((e) => e.synthetic === true));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("returns unavailable when neither runtime nor workspace has anything", () => {
  const timelineStore = createTimelineStore();
  const engine = createReplayEngine({ timelineStore, config: { workspaceRoot: join(tmpdir(), "obs-replay-missing") } });
  const result = engine.replay("never-seen");
  assert.deepEqual(result, { source: "unavailable", timeline: [] });
});

test("replay is deterministic: same stored state replayed twice yields identical results", () => {
  const timelineStore = createTimelineStore();
  timelineStore.record(evt(EVENT_TYPES.JOB_QUEUED, "j1", {}, "2026-01-01T00:00:00.000Z"));
  timelineStore.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1", {}, "2026-01-01T00:00:01.000Z"));
  const engine = createReplayEngine({ timelineStore });

  const first = engine.replay("j1");
  const second = engine.replay("j1");
  assert.deepEqual(first, second);
});

test("replay never mutates the underlying TimelineStore (read-only)", () => {
  const timelineStore = createTimelineStore();
  timelineStore.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  const engine = createReplayEngine({ timelineStore });

  const result = engine.replay("j1");
  result.timeline.push({ eventId: "injected", timestamp: "x", type: "Fake", payload: {} });

  assert.equal(timelineStore.getTimeline("j1").length, 1, "mutating the returned array must not affect the store");
});

test("an invalid job id never throws and never reaches the filesystem", () => {
  const timelineStore = createTimelineStore();
  const engine = createReplayEngine({ timelineStore, config: { workspaceRoot: join(tmpdir(), "obs-replay-invalid") } });
  assert.deepEqual(engine.replay("../../etc/passwd"), { source: "unavailable", timeline: [] });
});

// --- Task 4: durable tier (ADR-0006) ---

test("falls back to durable (EventHistoryStore) when the timeline was evicted/never retained, projecting each RuntimeEvent to TimelineEntry shape", () => {
  const timelineStore = createTimelineStore();
  const dir = mkdtempSync(join(tmpdir(), "obs-replay-durable-"));
  try {
    const jobId = "22222222-2222-4222-8222-222222222222";
    const eventHistoryStore = createEventHistoryStore({ dir });
    const e1 = evt(EVENT_TYPES.JOB_QUEUED, jobId, {}, "2026-01-01T00:00:00.000Z");
    const e2 = evt(EVENT_TYPES.JOB_COMPLETED, jobId, { exitCode: 0 }, "2026-01-01T00:00:01.000Z");
    eventHistoryStore.append(e1);
    eventHistoryStore.append(e2);

    const engine = createReplayEngine({ timelineStore, eventHistoryStore });
    const result = engine.replay(jobId);

    assert.equal(result.source, "durable");
    assert.equal(result.timeline.length, 2);
    assert.deepEqual(result.timeline[0], {
      eventId: e1.eventId,
      timestamp: e1.timestamp,
      type: e1.type,
      payload: e1.payload,
    });
    assert.deepEqual(result.timeline[1], {
      eventId: e2.eventId,
      timestamp: e2.timestamp,
      type: e2.type,
      payload: e2.payload,
    });
    // narrowing projection: jobId/version (present on the raw RuntimeEvent) must not leak through
    assert.deepEqual(Object.keys(result.timeline[0]).sort(), ["eventId", "payload", "timestamp", "type"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to workspace, byte-identical to today, when an eventHistoryStore is provided but has no durable log for this job", () => {
  const timelineStore = createTimelineStore();
  const eventHistoryDir = mkdtempSync(join(tmpdir(), "obs-replay-eh-empty-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-replay-ws-"));
  try {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const dir = join(workspaceRoot, "jobs", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        id: jobId,
        status: "completed",
        queuedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.100Z",
        finishedAt: "2026-01-01T00:00:00.500Z",
        runtimeMs: 400,
        exitCode: 0,
        error: null,
      })
    );

    const eventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
    const engine = createReplayEngine({ timelineStore, eventHistoryStore, config: { workspaceRoot } });
    const result = engine.replay(jobId);

    assert.equal(result.source, "workspace");
    assert.deepEqual(
      result.timeline.map((e) => e.type),
      [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_COMPLETED]
    );
  } finally {
    rmSync(eventHistoryDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("returns unavailable when timelineStore, eventHistoryStore, and workspace all have nothing for the job (eventHistoryStore present but empty)", () => {
  const timelineStore = createTimelineStore();
  const eventHistoryDir = mkdtempSync(join(tmpdir(), "obs-replay-eh-empty2-"));
  try {
    const eventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
    const engine = createReplayEngine({
      timelineStore,
      eventHistoryStore,
      config: { workspaceRoot: join(tmpdir(), "obs-replay-missing2") },
    });
    const result = engine.replay("44444444-4444-4444-8444-444444444444");
    assert.deepEqual(result, { source: "unavailable", timeline: [] });
  } finally {
    rmSync(eventHistoryDir, { recursive: true, force: true });
  }
});

test("priority order: prefers runtime over durable when BOTH a live TimelineStore entry and a durable log exist for the same job", () => {
  const timelineStore = createTimelineStore();
  const dir = mkdtempSync(join(tmpdir(), "obs-replay-both-"));
  try {
    const jobId = "55555555-5555-4555-8555-555555555555";
    timelineStore.record(evt(EVENT_TYPES.JOB_QUEUED, jobId));
    timelineStore.record(evt(EVENT_TYPES.JOB_COMPLETED, jobId));

    const eventHistoryStore = createEventHistoryStore({ dir });
    eventHistoryStore.append(evt(EVENT_TYPES.JOB_QUEUED, jobId));
    eventHistoryStore.append(evt(EVENT_TYPES.JOB_COMPLETED, jobId));

    const engine = createReplayEngine({ timelineStore, eventHistoryStore });
    const result = engine.replay(jobId);

    assert.equal(result.source, "runtime");
    assert.equal(result.timeline.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OutputChunk events are excluded from a durable replay result end-to-end, even if somehow present in the raw log", () => {
  const timelineStore = createTimelineStore();
  const dir = mkdtempSync(join(tmpdir(), "obs-replay-outputchunk-"));
  try {
    const jobId = "66666666-6666-4666-8666-666666666666";
    const eventHistoryStore = createEventHistoryStore({ dir });
    // Task 2's bridge normally never writes OutputChunk (stdout/stderr already owned by
    // workspaceManager's stdout.log/stderr.log) -- this simulates a log that somehow contains
    // one anyway, to prove the read path itself also excludes it, not just the write side.
    eventHistoryStore.append(evt(EVENT_TYPES.JOB_QUEUED, jobId, {}, "2026-01-01T00:00:00.000Z"));
    eventHistoryStore.append(evt(EVENT_TYPES.OUTPUT_CHUNK, jobId, { chunk: "hello" }, "2026-01-01T00:00:00.500Z"));
    eventHistoryStore.append(evt(EVENT_TYPES.JOB_COMPLETED, jobId, {}, "2026-01-01T00:00:01.000Z"));

    const engine = createReplayEngine({ timelineStore, eventHistoryStore });
    const result = engine.replay(jobId);

    assert.equal(result.source, "durable");
    assert.deepEqual(
      result.timeline.map((e) => e.type),
      [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_COMPLETED]
    );
    assert.ok(!result.timeline.some((e) => e.type === EVENT_TYPES.OUTPUT_CHUNK));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("durable replay is not affected when eventHistoryStore is undefined (default config.eventHistory !== \"file\"): falls straight to workspace, unchanged from today", () => {
  const timelineStore = createTimelineStore();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "obs-replay-no-eh-"));
  try {
    const jobId = "77777777-7777-4777-8777-777777777777";
    const dir = join(workspaceRoot, "jobs", jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "metadata.json"),
      JSON.stringify({
        id: jobId,
        status: "completed",
        queuedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.100Z",
        finishedAt: "2026-01-01T00:00:00.500Z",
        runtimeMs: 400,
        exitCode: 0,
        error: null,
      })
    );

    // no eventHistoryStore passed at all -- mirrors config.eventHistory !== "file"
    const engine = createReplayEngine({ timelineStore, config: { workspaceRoot } });
    const result = engine.replay(jobId);
    assert.equal(result.source, "workspace");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
