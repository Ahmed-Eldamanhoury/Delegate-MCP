import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectJobStore } from "../src/server/mcpServer.js";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
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
