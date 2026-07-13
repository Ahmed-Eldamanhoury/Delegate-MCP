import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayEngine } from "../src/services/replayEngine.js";
import { createTimelineStore } from "../src/services/timelineStore.js";
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
