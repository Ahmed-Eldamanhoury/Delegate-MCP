import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-eventhistorystore-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function freshDir() {
  return join(root, `store-${Math.random().toString(36).slice(2)}`);
}

const ID_A = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";
const ID_B = "7a1c9e2d-4b3f-4a5e-9c1d-2f6b8a0e5d4c";
const INVALID_ID = "not-a-uuid";

test("append() creates <dir>/<jobId>.jsonl and writes one JSON line per call", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });
  const event1 = { jobId: ID_A, type: "started", timestamp: "2024-01-01T00:00:00Z" };
  const event2 = { jobId: ID_A, type: "completed", timestamp: "2024-01-01T00:01:00Z" };

  store.append(event1);
  store.append(event2);

  const filePath = join(dir, `${ID_A}.jsonl`);
  assert.ok(existsSync(filePath));
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), event1);
  assert.deepEqual(JSON.parse(lines[1]), event2);
});

test("append() accumulates lines in call order for the same job", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });
  const events = [
    { jobId: ID_A, type: "started", seq: 1 },
    { jobId: ID_A, type: "log", seq: 2 },
    { jobId: ID_A, type: "completed", seq: 3 },
  ];

  for (const event of events) {
    store.append(event);
  }

  const filePath = join(dir, `${ID_A}.jsonl`);
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  for (let i = 0; i < events.length; i++) {
    assert.deepEqual(JSON.parse(lines[i]), events[i]);
  }
});

test("readAll() returns an array of events in order for a job with writes", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });
  const event1 = { jobId: ID_A, type: "started", seq: 1 };
  const event2 = { jobId: ID_A, type: "completed", seq: 2 };

  store.append(event1);
  store.append(event2);

  const events = store.readAll(ID_A);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], event1);
  assert.deepEqual(events[1], event2);
});

test("readAll() returns empty array for a job with no file", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  const events = store.readAll(ID_A);

  assert.deepEqual(events, []);
});

test("readAll() skips a corrupted/unparseable trailing line and still returns valid lines", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });

  const validEvent = { jobId: ID_A, type: "started", seq: 1 };
  const filePath = join(dir, `${ID_A}.jsonl`);
  const content = JSON.stringify(validEvent) + "\n" + "invalid json {][\n";
  writeFileSync(filePath, content, "utf8");

  const logs = [];
  const logger = {
    warn: (msg, meta) => logs.push({ msg, meta }),
  };
  const store = createEventHistoryStore({ dir, logger });

  const events = store.readAll(ID_A);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], validEvent);
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /corrupted/i);
  assert.equal(logs[0].meta.jobId, ID_A);
});

test("readAll() skips a corrupted line in the middle and still returns all valid lines", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });

  const validEvent1 = { jobId: ID_A, type: "started", seq: 1 };
  const validEvent2 = { jobId: ID_A, type: "completed", seq: 2 };
  const filePath = join(dir, `${ID_A}.jsonl`);
  const content =
    JSON.stringify(validEvent1) + "\n" + "invalid json\n" + JSON.stringify(validEvent2) + "\n";
  writeFileSync(filePath, content, "utf8");

  const logs = [];
  const logger = {
    warn: (msg, meta) => logs.push({ msg, meta }),
  };
  const store = createEventHistoryStore({ dir, logger });

  const events = store.readAll(ID_A);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], validEvent1);
  assert.deepEqual(events[1], validEvent2);
  assert.equal(logs.length, 1);
});

test("has() returns true after an append()", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  assert.equal(store.has(ID_A), false);
  store.append({ jobId: ID_A, type: "started" });
  assert.equal(store.has(ID_A), true);
});

test("has() returns false for an unknown job id", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  assert.equal(store.has(ID_A), false);
  assert.equal(store.has(ID_B), false);
});

test("append() rejects a non-UUID job id before constructing any path", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });
  const event = { jobId: INVALID_ID, type: "started" };

  const logs = [];
  const logger = {
    warn: (msg, meta) => logs.push({ msg, meta }),
  };
  const store2 = createEventHistoryStore({ dir, logger });

  store2.append(event);

  // Should log but not crash
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /failed/i);
  // No file should be created for invalid id
  assert.equal(existsSync(join(dir, `${INVALID_ID}.jsonl`)), false);
});

test("readAll() rejects a non-UUID job id before constructing any path", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  assert.throws(
    () => store.readAll(INVALID_ID),
    /invalid job id/i
  );
});

test("has() rejects a non-UUID job id before constructing any path", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  assert.throws(
    () => store.has(INVALID_ID),
    /invalid job id/i
  );
});

test("directory is created lazily on first append() if it doesn't exist", () => {
  const dir = freshDir();
  assert.equal(existsSync(dir), false);

  const store = createEventHistoryStore({ dir });
  assert.equal(existsSync(dir), false); // not created at construction time

  store.append({ jobId: ID_A, type: "started" });

  assert.ok(existsSync(dir)); // created on first append
  assert.ok(existsSync(join(dir, `${ID_A}.jsonl`)));
});

test("store is stateless: readAll() reads from disk every time", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  store.append({ jobId: ID_A, type: "started", seq: 1 });
  let events = store.readAll(ID_A);
  assert.equal(events.length, 1);

  // Manually append another event directly to file (using appendFileSync to add to existing file)
  const filePath = join(dir, `${ID_A}.jsonl`);
  const manualEvent = { jobId: ID_A, type: "log", seq: 2 };
  appendFileSync(filePath, JSON.stringify(manualEvent) + "\n", "utf8");

  // readAll should see the new event without any cache
  events = store.readAll(ID_A);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], manualEvent);
});

test("append() with null/undefined jobId in event throws or logs gracefully", () => {
  const dir = freshDir();
  const logs = [];
  const logger = {
    warn: (msg, meta) => logs.push({ msg, meta }),
  };
  const store = createEventHistoryStore({ dir, logger });

  const event = { type: "started" }; // no jobId

  store.append(event);

  // Should log the error
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /failed/i);
});
