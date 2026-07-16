import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectJobStore, wireEventHistoryIfEnabled } from "../src/server/mcpServer.js";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
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

test("wireEventHistoryIfEnabled does nothing for the default config (eventHistory unset -> 'memory')", () => {
  const bus = createRuntimeEventBus();
  const config = loadConfig({});
  const unsubscribe = wireEventHistoryIfEnabled({ bus, config });
  assert.equal(unsubscribe, undefined);
});

test("wireEventHistoryIfEnabled does nothing when eventHistory is explicitly 'memory'", () => {
  const bus = createRuntimeEventBus();
  const config = { ...loadConfig({}), eventHistory: "memory" };
  const unsubscribe = wireEventHistoryIfEnabled({ bus, config });
  assert.equal(unsubscribe, undefined);
});

test("wireEventHistoryIfEnabled wires a durable EventHistoryStore backed by config.eventHistoryDir when eventHistory is 'file'", () => {
  const dir = join(root, "event-history-a");
  const bus = createRuntimeEventBus();
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: dir };

  const unsubscribe = wireEventHistoryIfEnabled({ bus, config });
  assert.equal(typeof unsubscribe, "function");

  const jobId = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";
  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId, payload: {} });

  assert.ok(existsSync(join(dir, `${jobId}.jsonl`)));
  unsubscribe();
});
