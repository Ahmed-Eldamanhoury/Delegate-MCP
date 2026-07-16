import { test } from "node:test";
import assert from "node:assert/strict";
import { wireEventHistoryToEventBus } from "../src/services/eventHistoryBridge.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function fakeEventHistoryStore() {
  const calls = { append: [] };
  return {
    calls,
    append: (event) => calls.append.push(event),
  };
}

const NON_OUTPUT_CHUNK_TYPES = Object.values(EVENT_TYPES).filter((type) => type !== EVENT_TYPES.OUTPUT_CHUNK);

for (const type of NON_OUTPUT_CHUNK_TYPES) {
  test(`${type} is appended to the event history store`, () => {
    const bus = createRuntimeEventBus();
    const eventHistoryStore = fakeEventHistoryStore();

    wireEventHistoryToEventBus({ bus, eventHistoryStore });
    const published = bus.publish({ type, jobId: "job-1", payload: {} });

    assert.equal(eventHistoryStore.calls.append.length, 1);
    assert.equal(eventHistoryStore.calls.append[0], published);
  });
}

test("OutputChunk is NOT appended to the event history store (already durable via stdout.log/stderr.log)", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStore();

  wireEventHistoryToEventBus({ bus, eventHistoryStore });
  bus.publish({ type: EVENT_TYPES.OUTPUT_CHUNK, jobId: "job-1", payload: { chunk: "hello" } });

  assert.equal(eventHistoryStore.calls.append.length, 0);
});

test("wireEventHistoryToEventBus appends every event in publish order for a mixed sequence, OutputChunk excluded", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStore();

  wireEventHistoryToEventBus({ bus, eventHistoryStore });

  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.OUTPUT_CHUNK, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_PROGRESS, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.OUTPUT_CHUNK, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });

  assert.deepEqual(
    eventHistoryStore.calls.append.map((e) => e.type),
    [EVENT_TYPES.JOB_QUEUED, EVENT_TYPES.JOB_PROGRESS, EVENT_TYPES.JOB_COMPLETED]
  );
});

test("returns an unsubscribe function that stops all future appends", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStore();

  const unsubscribe = wireEventHistoryToEventBus({ bus, eventHistoryStore });
  unsubscribe();

  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId: "job-1", payload: {} });

  assert.equal(eventHistoryStore.calls.append.length, 0);
});
