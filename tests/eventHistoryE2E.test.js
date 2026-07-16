import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";
import { wireEventHistoryToEventBus } from "../src/services/eventHistoryBridge.js";
import { createReplayEngine } from "../src/services/replayEngine.js";
import { createTimelineStore } from "../src/services/timelineStore.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-eventhistory-e2e-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a job's full event history survives a 'restart': a fresh EventHistoryStore/ReplayEngine pair over the same directory replays it with source 'durable', not just the coarse workspace fallback", async () => {
  const eventHistoryDir = join(root, "e2e-a");

  // --- "before restart": a real bus + JobManager, with the durable bridge wired exactly as
  // mcpServer.js's wireEventHistoryIfEnabled() does, and a job that runs to completion ---
  const bus = createRuntimeEventBus();
  const firstEventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
  wireEventHistoryToEventBus({ bus, eventHistoryStore: firstEventHistoryStore });

  const jobManager = new JobManager({ bus });
  const id = jobManager.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: true };
  });
  await jobManager.waitForCompletion(id);

  // --- "restart": brand-new EventHistoryStore + ReplayEngine instances constructed fresh over
  // the same directory -- not the same objects reused, and with a brand-new (empty)
  // TimelineStore standing in for a fresh process's in-memory state, so the only way this can
  // resolve is via the durable tier reading back off disk. ---
  const secondEventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
  const secondTimelineStore = createTimelineStore();
  const replayEngine = createReplayEngine({
    timelineStore: secondTimelineStore,
    eventHistoryStore: secondEventHistoryStore,
  });

  const result = replayEngine.replay(id);

  assert.equal(result.source, "durable");
  // Full fidelity, not the coarse 3-entry synthesis the workspace fallback would produce:
  // JobQueued, then two JobStateChanged transitions (queued->starting, starting->running),
  // then JobCompleted.
  assert.deepEqual(
    result.timeline.map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_STATE_CHANGED, EVENT_TYPES.JOB_COMPLETED]
  );
  // Durable replay entries are real recorded events, never marked `synthetic` (that flag is
  // exclusive to the workspace-metadata fallback tier).
  assert.ok(result.timeline.every((e) => e.synthetic === undefined));
  assert.equal(result.timeline[result.timeline.length - 1].payload.exitCode, 0);
});

test("a durable replay after 'restart' is unaffected by a second, unrelated job's events living in the same directory", async () => {
  const eventHistoryDir = join(root, "e2e-b");

  const bus = createRuntimeEventBus();
  const firstEventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
  wireEventHistoryToEventBus({ bus, eventHistoryStore: firstEventHistoryStore });

  const jobManager = new JobManager({ bus, maxConcurrent: 2 });
  const idA = jobManager.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: "a" };
  });
  const idB = jobManager.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: "b" };
  });
  await Promise.all([jobManager.waitForCompletion(idA), jobManager.waitForCompletion(idB)]);

  const secondEventHistoryStore = createEventHistoryStore({ dir: eventHistoryDir });
  const replayEngine = createReplayEngine({
    timelineStore: createTimelineStore(),
    eventHistoryStore: secondEventHistoryStore,
  });

  const resultA = replayEngine.replay(idA);
  const resultB = replayEngine.replay(idB);

  assert.equal(resultA.source, "durable");
  assert.equal(resultB.source, "durable");
  // Each job's durable log is isolated to its own file -- replaying one never picks up the
  // other's events, even though both were written to the same directory concurrently.
  assert.ok(resultA.timeline.every((e) => JSON.stringify(e) !== JSON.stringify(resultB.timeline[0])));
  assert.equal(resultA.timeline[resultA.timeline.length - 1].type, EVENT_TYPES.JOB_COMPLETED);
  assert.equal(resultB.timeline[resultB.timeline.length - 1].type, EVENT_TYPES.JOB_COMPLETED);
});
