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

/**
 * A fake store whose prune() is scripted: `evictionsByCall[i]` is the array of job ids
 * "evicted" on the i-th call to prune(). Records the *set contents* it was handed each call
 * (a snapshot copy, taken before that call's own eviction is applied) so tests can inspect
 * exactly what the bridge's tracking Set looked like at each terminal event.
 */
function fakeEventHistoryStoreWithPrune(evictionsByCall = []) {
  const calls = { append: [], prune: [] };
  let pruneCallCount = 0;
  return {
    calls,
    append: (event) => calls.append.push(event),
    prune: ({ maxFiles, terminalJobIds }) => {
      calls.prune.push({ maxFiles, terminalJobIdsSnapshot: [...terminalJobIds] });
      const evicted = evictionsByCall[pruneCallCount] ?? [];
      pruneCallCount += 1;
      return evicted;
    },
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

test("prune() is not called for non-terminal events", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStoreWithPrune();

  wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: 100 });
  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_PROGRESS, jobId: "job-1", payload: {} });

  assert.equal(eventHistoryStore.calls.prune.length, 0);
});

test("prune() is called with maxFiles and the terminal job id included in terminalJobIds after a terminal event", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStoreWithPrune();

  wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: 42 });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });

  assert.equal(eventHistoryStore.calls.prune.length, 1);
  assert.equal(eventHistoryStore.calls.prune[0].maxFiles, 42);
  assert.deepEqual(eventHistoryStore.calls.prune[0].terminalJobIdsSnapshot, ["job-1"]);
});

for (const type of [EVENT_TYPES.JOB_COMPLETED, EVENT_TYPES.JOB_FAILED, EVENT_TYPES.JOB_CANCELLED]) {
  test(`${type} triggers a prune() call (all three terminal types are tracked)`, () => {
    const bus = createRuntimeEventBus();
    const eventHistoryStore = fakeEventHistoryStoreWithPrune();

    wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: 10 });
    bus.publish({ type, jobId: "job-1", payload: {} });

    assert.equal(eventHistoryStore.calls.prune.length, 1);
  });
}

test("prune() is skipped entirely when maxFiles is not provided (backward compatible with callers that don't cap)", () => {
  const bus = createRuntimeEventBus();
  const eventHistoryStore = fakeEventHistoryStoreWithPrune();

  wireEventHistoryToEventBus({ bus, eventHistoryStore }); // no maxFiles
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });

  assert.equal(eventHistoryStore.calls.prune.length, 0);
});

test("the bridge's terminal-tracking set stays bounded: job ids prune() reports as evicted are removed and never resurface in a later call", () => {
  const bus = createRuntimeEventBus();
  // Script: call 1 (job-1 completes) evicts nothing yet; call 2 (job-2 completes) evicts job-1;
  // call 3 (job-3 completes) should then see a tracking set that no longer contains job-1.
  const eventHistoryStore = fakeEventHistoryStoreWithPrune([[], ["job-1"], []]);

  wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: 1 });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-2", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-3", payload: {} });

  const [call1, call2, call3] = eventHistoryStore.calls.prune;
  assert.deepEqual(call1.terminalJobIdsSnapshot.sort(), ["job-1"]);
  assert.deepEqual(call2.terminalJobIdsSnapshot.sort(), ["job-1", "job-2"]);
  // job-1 was evicted on call 2 -- by call 3 it must be gone from the tracking set, proving
  // the set doesn't grow unboundedly across the process's lifetime.
  assert.deepEqual(call3.terminalJobIdsSnapshot.sort(), ["job-2", "job-3"]);
  assert.ok(!call3.terminalJobIdsSnapshot.includes("job-1"));
});
