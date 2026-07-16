import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
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
const ID_C = "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const ID_D = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const INVALID_ID = "not-a-uuid";

/** Backdates a file's mtime by `offsetSeconds` so prune()'s oldest-first sort is deterministic in tests. */
function setMtime(filePath, offsetSeconds) {
  const t = new Date(Date.now() - offsetSeconds * 1000);
  utimesSync(filePath, t, t);
}

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

test("prune() evicts the oldest-by-mtime files beyond maxFiles, considering only known-terminal job ids", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  // Four jobs, all confirmed terminal, oldest to newest: A, B, C, D.
  for (const id of [ID_A, ID_B, ID_C, ID_D]) {
    store.append({ jobId: id, type: "completed" });
  }
  setMtime(join(dir, `${ID_A}.jsonl`), 40);
  setMtime(join(dir, `${ID_B}.jsonl`), 30);
  setMtime(join(dir, `${ID_C}.jsonl`), 20);
  setMtime(join(dir, `${ID_D}.jsonl`), 10);

  const terminalJobIds = new Set([ID_A, ID_B, ID_C, ID_D]);
  const evicted = store.prune({ maxFiles: 2, terminalJobIds });

  assert.deepEqual(evicted.sort(), [ID_A, ID_B].sort());
  assert.equal(existsSync(join(dir, `${ID_A}.jsonl`)), false);
  assert.equal(existsSync(join(dir, `${ID_B}.jsonl`)), false);
  assert.ok(existsSync(join(dir, `${ID_C}.jsonl`)));
  assert.ok(existsSync(join(dir, `${ID_D}.jsonl`)));
});

test("prune() never evicts a file whose job id is not in terminalJobIds, even if it is the oldest by mtime", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  // ID_A is in-flight (its terminal event has never been observed) and objectively the
  // oldest file on disk -- it must never be a candidate, structurally, regardless of cap.
  for (const id of [ID_A, ID_B, ID_C, ID_D]) {
    store.append({ jobId: id, type: "progress" });
  }
  setMtime(join(dir, `${ID_A}.jsonl`), 100); // oldest of all, but NOT terminal
  setMtime(join(dir, `${ID_B}.jsonl`), 30);
  setMtime(join(dir, `${ID_C}.jsonl`), 20);
  setMtime(join(dir, `${ID_D}.jsonl`), 10);

  const terminalJobIds = new Set([ID_B, ID_C, ID_D]); // ID_A deliberately excluded
  const evicted = store.prune({ maxFiles: 1, terminalJobIds });

  assert.ok(!evicted.includes(ID_A));
  assert.ok(existsSync(join(dir, `${ID_A}.jsonl`)), "in-flight job's file must survive prune");
  assert.deepEqual(evicted.sort(), [ID_B, ID_C].sort());
  assert.ok(existsSync(join(dir, `${ID_D}.jsonl`)));
});

test("prune() is a no-op when the number of terminal files is within maxFiles", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  store.append({ jobId: ID_A, type: "completed" });
  store.append({ jobId: ID_B, type: "completed" });

  const evicted = store.prune({ maxFiles: 5, terminalJobIds: new Set([ID_A, ID_B]) });

  assert.deepEqual(evicted, []);
  assert.ok(existsSync(join(dir, `${ID_A}.jsonl`)));
  assert.ok(existsSync(join(dir, `${ID_B}.jsonl`)));
});

test("prune() is a safe no-op when the event-history dir doesn't exist yet", () => {
  const dir = freshDir();
  const store = createEventHistoryStore({ dir });

  const evicted = store.prune({ maxFiles: 1, terminalJobIds: new Set([ID_A]) });

  assert.deepEqual(evicted, []);
});
