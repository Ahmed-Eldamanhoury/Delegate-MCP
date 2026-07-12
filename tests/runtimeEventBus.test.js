import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_SCHEMA_VERSION } from "../src/models/runtimeEvent.js";

test("publish fills eventId/timestamp/version and delivers to a matching subscriber", () => {
  const bus = createRuntimeEventBus();
  const received = [];
  bus.subscribe("JobQueued", (event) => received.push(event));

  const published = bus.publish({ type: "JobQueued", jobId: "job-1", payload: { model: "sonnet" } });

  assert.equal(received.length, 1);
  assert.equal(received[0], published);
  assert.ok(published.eventId);
  assert.ok(published.timestamp);
  assert.equal(published.version, EVENT_SCHEMA_VERSION);
  assert.deepEqual(published.payload, { model: "sonnet" });
});

test("subscribe only receives events of its own type", () => {
  const bus = createRuntimeEventBus();
  const queuedEvents = [];
  const completedEvents = [];
  bus.subscribe("JobQueued", (e) => queuedEvents.push(e));
  bus.subscribe("JobCompleted", (e) => completedEvents.push(e));

  bus.publish({ type: "JobQueued", jobId: "job-1" });
  bus.publish({ type: "JobCompleted", jobId: "job-1" });

  assert.equal(queuedEvents.length, 1);
  assert.equal(completedEvents.length, 1);
});

test("subscribeAll receives every event regardless of type", () => {
  const bus = createRuntimeEventBus();
  const all = [];
  bus.subscribeAll((e) => all.push(e.type));

  bus.publish({ type: "JobQueued", jobId: "job-1" });
  bus.publish({ type: "JobStateChanged", jobId: "job-1" });
  bus.publish({ type: "JobCompleted", jobId: "job-1" });

  assert.deepEqual(all, ["JobQueued", "JobStateChanged", "JobCompleted"]);
});

test("unsubscribe stops further delivery", () => {
  const bus = createRuntimeEventBus();
  const received = [];
  const unsubscribe = bus.subscribe("JobQueued", (e) => received.push(e));

  bus.publish({ type: "JobQueued", jobId: "job-1" });
  unsubscribe();
  bus.publish({ type: "JobQueued", jobId: "job-2" });

  assert.equal(received.length, 1);
});

test("a throwing subscriber is isolated: logged, doesn't affect siblings or the publisher", () => {
  const warnings = [];
  const bus = createRuntimeEventBus({ logger: { warn: (msg, meta) => warnings.push({ msg, meta }) } });
  const survivorReceived = [];

  bus.subscribe("JobQueued", () => {
    throw new Error("boom");
  });
  bus.subscribe("JobQueued", (e) => survivorReceived.push(e));

  assert.doesNotThrow(() => bus.publish({ type: "JobQueued", jobId: "job-1" }));
  assert.equal(survivorReceived.length, 1, "sibling subscriber must still receive the event");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].meta.message, /boom/);
});

test("publish() does not require a subscriber to exist", () => {
  const bus = createRuntimeEventBus();
  assert.doesNotThrow(() => bus.publish({ type: "JobQueued", jobId: "job-1" }));
});
