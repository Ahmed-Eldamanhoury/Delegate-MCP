import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimelineStore } from "../src/services/timelineStore.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function evt(type, jobId, payload = {}, timestamp = new Date().toISOString()) {
  return { eventId: `e-${Math.random()}`, timestamp, type, jobId, payload, version: 1 };
}

test("getTimeline returns a job's events in recorded (chronological) order", () => {
  const store = createTimelineStore();
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "j1", {}, "2026-01-01T00:00:00.000Z"));
  store.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { to: "starting" }, "2026-01-01T00:00:00.100Z"));
  store.record(evt(EVENT_TYPES.JOB_STATE_CHANGED, "j1", { to: "running" }, "2026-01-01T00:00:00.200Z"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1", {}, "2026-01-01T00:00:00.300Z"));

  const timeline = store.getTimeline("j1");
  assert.deepEqual(
    timeline.map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_COMPLETED]
  );
  assert.deepEqual(
    timeline.map((e) => e.timestamp),
    ["2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.100Z", "2026-01-01T00:00:00.200Z", "2026-01-01T00:00:00.300Z"]
  );
});

test("events are isolated per jobId — never cross-contaminated", () => {
  const store = createTimelineStore();
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "a"));
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "b"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "a"));

  assert.equal(store.getTimeline("a").length, 2);
  assert.equal(store.getTimeline("b").length, 1);
});

test("getTimeline filters by type", () => {
  const store = createTimelineStore();
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "j1"));
  store.record(evt(EVENT_TYPES.JOB_PROGRESS, "j1"));
  store.record(evt(EVENT_TYPES.JOB_PROGRESS, "j1"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1"));

  const progressOnly = store.getTimeline("j1", { type: EVENT_TYPES.JOB_PROGRESS });
  assert.equal(progressOnly.length, 2);
  assert.ok(progressOnly.every((e) => e.type === EVENT_TYPES.JOB_PROGRESS));
});

test("getTimeline filters by since (inclusive, ISO-8601 lexicographic == chronological)", () => {
  const store = createTimelineStore();
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "j1", {}, "2026-01-01T00:00:00.000Z"));
  store.record(evt(EVENT_TYPES.JOB_PROGRESS, "j1", {}, "2026-01-01T00:00:05.000Z"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "j1", {}, "2026-01-01T00:00:10.000Z"));

  const recent = store.getTimeline("j1", { since: "2026-01-01T00:00:05.000Z" });
  assert.deepEqual(
    recent.map((e) => e.type),
    [EVENT_TYPES.JOB_PROGRESS, EVENT_TYPES.JOB_COMPLETED]
  );
});

test("unknown jobId returns an empty array, never throws", () => {
  const store = createTimelineStore();
  assert.deepEqual(store.getTimeline("nope"), []);
});

test("retention: oldest terminal job's timeline is evicted first once the cap is exceeded", () => {
  const store = createTimelineStore({ maxTimelineHistory: 2 });
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "a"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "a")); // terminal, oldest
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "b"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "b")); // terminal, second-oldest
  assert.equal(store.has("a"), true);

  store.record(evt(EVENT_TYPES.JOB_QUEUED, "c"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "c")); // pushes size to 3 -> evicts "a"

  assert.equal(store.has("a"), false, "oldest terminal job must be evicted");
  assert.equal(store.has("b"), true);
  assert.equal(store.has("c"), true);
});

test("retention: an in-flight (non-terminal) job's timeline is never evicted, even over cap", () => {
  const store = createTimelineStore({ maxTimelineHistory: 1 });
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "in-flight")); // never terminates in this test
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "a"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "a"));
  store.record(evt(EVENT_TYPES.JOB_QUEUED, "b"));
  store.record(evt(EVENT_TYPES.JOB_COMPLETED, "b"));

  assert.equal(store.has("in-flight"), true, "in-flight job must survive eviction regardless of cap");
});
