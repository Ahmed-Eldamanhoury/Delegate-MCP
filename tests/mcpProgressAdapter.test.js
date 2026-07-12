import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardJobProgressToMcp } from "../src/services/mcpProgressAdapter.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

test("forwards lifecycle events for the given jobId as notifications/progress, in order", async () => {
  const bus = createRuntimeEventBus();
  const notifications = [];
  const unsubscribe = forwardJobProgressToMcp({
    bus,
    jobId: "job-1",
    progressToken: "tok-1",
    sendNotification: async (n) => notifications.push(n),
  });

  bus.publish({ type: EVENT_TYPES.JOB_STATE_CHANGED, jobId: "job-1", payload: { from: "queued", to: "starting" } });
  bus.publish({ type: EVENT_TYPES.JOB_STATE_CHANGED, jobId: "job-1", payload: { from: "starting", to: "running" } });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });

  assert.equal(notifications.length, 3);
  assert.ok(notifications.every((n) => n.method === "notifications/progress"));
  assert.ok(notifications.every((n) => n.params.progressToken === "tok-1"));
  assert.deepEqual(
    notifications.map((n) => n.params.progress),
    [1, 2, 3]
  );
  assert.equal(notifications[0].params.message, "Job starting");
  assert.equal(notifications[2].params.message, "Job completed");

  unsubscribe();
});

test("ignores events for other job ids", async () => {
  const bus = createRuntimeEventBus();
  const notifications = [];
  forwardJobProgressToMcp({
    bus,
    jobId: "job-1",
    progressToken: "tok-1",
    sendNotification: async (n) => notifications.push(n),
  });

  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "some-other-job", payload: {} });

  assert.equal(notifications.length, 0);
});

test("does not forward OutputChunk (too high-frequency for a protocol notification channel)", async () => {
  const bus = createRuntimeEventBus();
  const notifications = [];
  forwardJobProgressToMcp({
    bus,
    jobId: "job-1",
    progressToken: "tok-1",
    sendNotification: async (n) => notifications.push(n),
  });

  bus.publish({ type: EVENT_TYPES.OUTPUT_CHUNK, jobId: "job-1", payload: { stream: "stdout", chunk: "x" } });

  assert.equal(notifications.length, 0);
});

test("unsubscribe stops forwarding", async () => {
  const bus = createRuntimeEventBus();
  const notifications = [];
  const unsubscribe = forwardJobProgressToMcp({
    bus,
    jobId: "job-1",
    progressToken: "tok-1",
    sendNotification: async (n) => notifications.push(n),
  });

  unsubscribe();
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });

  assert.equal(notifications.length, 0);
});

test("a rejected sendNotification is logged and swallowed, never affects the bus or other subscribers", async () => {
  const bus = createRuntimeEventBus();
  const warnings = [];
  const survivorEvents = [];
  bus.subscribe(EVENT_TYPES.JOB_COMPLETED, (e) => survivorEvents.push(e));

  forwardJobProgressToMcp({
    bus,
    jobId: "job-1",
    progressToken: "tok-1",
    sendNotification: async () => {
      throw new Error("client disconnected");
    },
    logger: { warn: (msg, meta) => warnings.push({ msg, meta }) },
  });

  assert.doesNotThrow(() => bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} }));
  // sendNotification is async — give its rejection a tick to be caught
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(survivorEvents.length, 1);
  assert.equal(warnings.length, 1);
});
