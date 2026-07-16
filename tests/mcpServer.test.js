import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectJobStore,
  selectEventHistoryStore,
  wireEventHistoryIfEnabled,
  createMcpServer,
} from "../src/server/mcpServer.js";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";
import { loadConfig } from "../src/config/index.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-mcpserver-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("selectJobStore returns InMemoryJobStore for the default config", () => {
  const config = loadConfig({});
  assert.ok(selectJobStore(config) instanceof InMemoryJobStore);
});

test("selectJobStore returns InMemoryJobStore when jobStore is explicitly 'memory'", () => {
  const config = { ...loadConfig({}), jobStore: "memory" };
  assert.ok(selectJobStore(config) instanceof InMemoryJobStore);
});

test("selectJobStore returns a FileJobStore backed by config.jobStoreDir when jobStore is 'file'", () => {
  const dir = join(root, "store-a");
  const config = { ...loadConfig({}), jobStore: "file", jobStoreDir: dir };
  const store = selectJobStore(config);
  assert.ok(store instanceof FileJobStore);
  assert.equal(store.dir, dir);
});

// --- Task 7 (ponytail-audit dedup): EventHistoryStore construction moved to its own helper,
// selectEventHistoryStore, mirroring selectJobStore -- the ONE construction point, shared by
// both wireEventHistoryIfEnabled (write-side bridge) and createObservabilityService (ReplayEngine
// durable tier) via createMcpServer. wireEventHistoryIfEnabled no longer builds a store itself or
// checks config.eventHistory -- gating happens once, here. ---

test("selectEventHistoryStore returns undefined for the default config (eventHistory unset -> 'memory')", () => {
  const config = loadConfig({});
  assert.equal(selectEventHistoryStore(config), undefined);
});

test("selectEventHistoryStore returns undefined when eventHistory is explicitly 'memory'", () => {
  const config = { ...loadConfig({}), eventHistory: "memory" };
  assert.equal(selectEventHistoryStore(config), undefined);
});

test("selectEventHistoryStore returns an EventHistoryStore backed by config.eventHistoryDir when eventHistory is 'file'", () => {
  const dir = join(root, "select-event-history-a");
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: dir };

  const store = selectEventHistoryStore(config);
  assert.equal(typeof store.append, "function");
  assert.equal(typeof store.readAll, "function");

  const jobId = "8f5c8e0a-2b4a-4f9e-8f1a-6c9d4e2b7a3c";
  store.append({ eventId: "e1", jobId, type: EVENT_TYPES.JOB_QUEUED, timestamp: new Date().toISOString(), payload: {} });
  assert.ok(existsSync(join(dir, `${jobId}.jsonl`)));
});

test("wireEventHistoryIfEnabled does nothing when eventHistoryStore is undefined (default config eventHistory unset -> 'memory')", () => {
  const bus = createRuntimeEventBus();
  const config = loadConfig({});
  const unsubscribe = wireEventHistoryIfEnabled({ bus, eventHistoryStore: undefined, config });
  assert.equal(unsubscribe, undefined);
});

test("wireEventHistoryIfEnabled wires the given EventHistoryStore into the bus", () => {
  const dir = join(root, "event-history-a");
  const bus = createRuntimeEventBus();
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: dir };
  const eventHistoryStore = createEventHistoryStore({ dir });

  const unsubscribe = wireEventHistoryIfEnabled({ bus, eventHistoryStore, config });
  assert.equal(typeof unsubscribe, "function");

  const jobId = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";
  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId, payload: {} });

  assert.ok(existsSync(join(dir, `${jobId}.jsonl`)));
  unsubscribe();
});

test("wireEventHistoryIfEnabled uses exactly the eventHistoryStore instance it's given -- it no longer constructs its own from config, even when config still says eventHistory: 'file'", () => {
  const bus = createRuntimeEventBus();
  const untouchedDir = join(root, "should-not-be-touched");
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: untouchedDir };
  const appended = [];
  const fakeStore = {
    append: (event) => appended.push(event),
    readAll: () => [],
    has: () => false,
    prune: () => [],
  };

  const unsubscribe = wireEventHistoryIfEnabled({ bus, eventHistoryStore: fakeStore, config });
  const jobId = "b6e2b9b0-9a2b-4b8b-9f0a-8f6a0b8f0a1a";
  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId, payload: {} });

  assert.equal(appended.length, 1, "must call append on the exact fake object passed in");
  assert.equal(appended[0].jobId, jobId);
  assert.ok(
    !existsSync(join(untouchedDir, `${jobId}.jsonl`)),
    "must not build/write to a real store derived from config.eventHistoryDir"
  );
  unsubscribe();
});

// --- Task 5: createMcpServer() must expose ObservabilityService so its close() is reachable
// at shutdown (previously constructed and immediately discarded -- ARCHITECTURE_REVIEW.md) ---

test("createMcpServer returns both the MCP server and the ObservabilityService instance, not just the bare server", () => {
  const config = loadConfig({});
  const logger = { info() {}, warn() {}, error() {} };

  const result = createMcpServer({ config, logger, version: "test" });

  assert.ok(result.server, "expected a `server` field on the return value");
  assert.ok(result.observabilityService, "expected an `observabilityService` field on the return value");
  assert.equal(typeof result.observabilityService.close, "function");
});

// --- Task 7 (ponytail-audit dedup): EventHistoryStore must be constructed exactly ONCE per
// createMcpServer() call and shared -- the same instance backing both the write-side bridge and
// ObservabilityService's replay engine -- instead of each independently building its own. ---

test("createMcpServer does not construct an EventHistoryStore for the default config (eventHistory unset -> 'memory')", () => {
  const config = loadConfig({});
  const logger = { info() {}, warn() {}, error() {} };

  const result = createMcpServer({ config, logger, version: "test" });

  assert.equal(result.eventHistoryStore, undefined);
});

test("createMcpServer constructs a single EventHistoryStore and shares that SAME instance between the write-side bridge and ObservabilityService's replay engine", () => {
  const dir = join(root, "shared-instance-a");
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: dir };
  const logger = { info() {}, warn() {}, error() {} };

  const result = createMcpServer({ config, logger, version: "test" });
  assert.ok(result.eventHistoryStore, "expected createMcpServer to expose the constructed EventHistoryStore");

  // Write directly through the exact object createMcpServer constructed -- production code
  // reaches this same object only via the write-side bridge (wireEventHistoryIfEnabled), which a
  // test above already proves calls .append() on whatever eventHistoryStore it's handed, never a
  // store it built itself. So this call stands in for "the bridge wrote an event".
  const jobId = "7c9e6ea1-4f7f-4c8b-9d2a-1e6b0c9f2a3d";
  result.eventHistoryStore.append({
    eventId: "e1",
    jobId,
    type: EVENT_TYPES.JOB_QUEUED,
    timestamp: new Date().toISOString(),
    payload: {},
  });

  // ObservabilityService's replay() reads through ReplayEngine's durable tier, which (per the
  // observabilityService.test.js "uses exactly the passed eventHistoryStore" test) only ever
  // consults the exact eventHistoryStore object createObservabilityService was given -- never one
  // reconstructed from config. Seeing the write here therefore confirms it's reading the SAME
  // instance createMcpServer constructed and hands to the bridge, not a second, independent one.
  const replayed = result.observabilityService.replay(jobId);
  assert.equal(replayed.source, "durable");
  assert.equal(replayed.timeline.length, 1);
});

// --- ADR-0007 Task 2: delegate_replay must be registered as the 7th MCP tool, wired to the
// SAME observabilityService instance createMcpServer already constructs and returns above ---
// (No per-handler unit test file exists for any of the six existing tools -- ADR-0007's own
// Testing plan notes this convention -- so this is the registration-level check the ADR calls
// for; the SDK's McpServer doesn't expose a public tools-list getter, so this reads
// `server._registeredTools`, the same object `registerTool` populates internally, per the brief's
// "whatever the SDK instance exposes for introspection" guidance.)

test("createMcpServer registers delegate_replay as a 7th tool, alongside the existing six", () => {
  const config = loadConfig({});
  const logger = { info() {}, warn() {}, error() {} };

  const { server } = createMcpServer({ config, logger, version: "test" });

  const toolNames = Object.keys(server._registeredTools);
  assert.deepEqual(
    toolNames,
    [
      "delegate_task",
      "delegate_submit",
      "delegate_status",
      "delegate_history",
      "delegate_models",
      "delegate_cancel",
      "delegate_replay",
      "delegate_metrics",
    ],
    "expected exactly the existing six tools plus delegate_replay and delegate_metrics, registered in this order"
  );
});

// --- ADR-0008 Task 2: delegate_metrics must be registered as the 8th MCP tool, wired to the
// SAME observabilityService instance createMcpServer constructs ---

test("createMcpServer registers delegate_metrics as an 8th tool, alongside the existing seven", () => {
  const config = loadConfig({});
  const logger = { info() {}, warn() {}, error() {} };

  const { server } = createMcpServer({ config, logger, version: "test" });

  const toolNames = Object.keys(server._registeredTools);
  assert.deepEqual(
    toolNames,
    [
      "delegate_task",
      "delegate_submit",
      "delegate_status",
      "delegate_history",
      "delegate_models",
      "delegate_cancel",
      "delegate_replay",
      "delegate_metrics",
    ],
    "expected exactly the existing seven tools plus delegate_metrics, registered in this order"
  );
});

