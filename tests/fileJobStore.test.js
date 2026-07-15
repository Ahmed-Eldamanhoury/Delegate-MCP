import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createJob } from "../src/models/job.js";
import { JOB_STATUS } from "../src/models/job.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function freshDir() {
  return join(root, `store-${Math.random().toString(36).slice(2)}`);
}

const ID_A = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";
const ID_B = "7a1c9e2d-4b3f-4a5e-9c1d-2f6b8a0e5d4c";

test("create() writes a JSON file and returns the job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  const job = createJob(ID_A, { tool: "delegate_task" });

  const result = store.create(job);

  assert.deepEqual(result, job);
  const filePath = join(dir, `${ID_A}.json`);
  assert.ok(existsSync(filePath));
  const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(onDisk.storeVersion, 1);
  assert.deepEqual(onDisk.job, job);
  // no leftover temp file after a successful write
  assert.equal(existsSync(`${filePath}.tmp`), false);
});

test("get() returns a created job by id, undefined for an unknown id", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  const job = createJob(ID_A);
  store.create(job);

  assert.deepEqual(store.get(ID_A), job);
  assert.equal(store.get(ID_B), undefined);
});

test("update() merges a patch, rewrites the file, and returns the updated job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));

  const updated = store.update(ID_A, { status: "completed", exitCode: 0 });

  assert.equal(updated.status, "completed");
  assert.equal(updated.exitCode, 0);
  assert.equal(store.get(ID_A).status, "completed");
  const onDisk = JSON.parse(readFileSync(join(dir, `${ID_A}.json`), "utf8"));
  assert.equal(onDisk.job.status, "completed");
});

test("update() on an unknown id returns undefined and writes nothing", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });

  assert.equal(store.update(ID_A, { status: "completed" }), undefined);
  assert.equal(existsSync(join(dir, `${ID_A}.json`)), false);
});

test("list() returns every created job", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));
  store.create(createJob(ID_B));

  const ids = store.list().map((j) => j.id).sort();
  assert.deepEqual(ids, [ID_A, ID_B].sort());
});

test("delete() removes both the file and the cache entry, returns true; false for unknown id", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });
  store.create(createJob(ID_A));

  assert.equal(store.delete(ID_A), true);
  assert.equal(store.get(ID_A), undefined);
  assert.equal(existsSync(join(dir, `${ID_A}.json`)), false);
  assert.equal(store.delete(ID_A), false);
});

test("constructor creates dir if it doesn't exist yet, hydrates empty cache", () => {
  const dir = freshDir();
  assert.equal(existsSync(dir), false);

  const store = new FileJobStore({ dir });

  assert.ok(existsSync(dir));
  assert.deepEqual(store.list(), []);
});

test("constructor hydrates its cache from an existing directory of well-formed job files", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  first.create(createJob(ID_A));
  first.create(createJob(ID_B));

  const second = new FileJobStore({ dir });

  const ids = second.list().map((j) => j.id).sort();
  assert.deepEqual(ids, [ID_A, ID_B].sort());
});

test("create() with an invalid id throws and leaves no trace in the cache", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });

  assert.throws(() => store.create({ ...createJob(ID_A), id: "../../etc/passwd" }));
  assert.equal(store.get("../../etc/passwd"), undefined);
  assert.deepEqual(store.list(), []);
});

test("update() on an id that was never created returns undefined safely, without touching the filesystem", () => {
  const dir = freshDir();
  const store = new FileJobStore({ dir });

  assert.equal(store.update("../../etc/passwd", { status: "completed" }), undefined);
  assert.deepEqual(store.list(), []);
});

test("a write failure is caught, logged via logger.warn, and does not throw", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  // Force the exact .tmp path _write() targets to already exist as a directory, so
  // writeFileSync(tmpPath, ...) fails with EISDIR -- a deterministic, portable way to
  // trigger a real fs write failure without relying on permission bits (unreliable on
  // Windows, this project's primary dev platform).
  mkdirSync(join(dir, `${ID_A}.json.tmp`));
  const warnings = [];
  const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };
  const store = new FileJobStore({ dir, logger });

  assert.doesNotThrow(() => store.create(createJob(ID_A)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /write failed/i);
  assert.equal(warnings[0].meta.jobId, ID_A);
});

test("a corrupted (unparseable) job file is skipped during hydration, logged, and never crashes the constructor", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json`), "{ not valid json");
  const warnings = [];
  const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };

  const store = new FileJobStore({ dir, logger });

  assert.deepEqual(store.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /corrupted|unparseable/i);
});

test("a job file with a missing or unrecognized storeVersion is skipped during hydration", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json`), JSON.stringify({ storeVersion: 99, job: createJob(ID_A) }));
  const store = new FileJobStore({ dir });

  assert.deepEqual(store.list(), []);
});

test("a non-terminal job (running) recovered at hydration is rewritten to failed, deterministically, and the rewrite is persisted", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  const job = createJob(ID_A);
  first.create(job);
  first.update(ID_A, { status: JOB_STATUS.RUNNING, startedAt: new Date().toISOString() });

  const second = new FileJobStore({ dir });

  const recovered = second.get(ID_A);
  assert.equal(recovered.status, JOB_STATUS.FAILED);
  assert.equal(recovered.error, "process restarted before job completed");
  assert.ok(recovered.finishedAt);
  // the rewrite itself is durable -- a third instance sees the same recovered state,
  // not "running" again
  const third = new FileJobStore({ dir });
  assert.equal(third.get(ID_A).status, JOB_STATUS.FAILED);
});

test("a terminal job (completed) is loaded unchanged at hydration", () => {
  const dir = freshDir();
  const first = new FileJobStore({ dir });
  first.create(createJob(ID_A));
  first.update(ID_A, { status: JOB_STATUS.COMPLETED, result: { ok: true } });

  const second = new FileJobStore({ dir });

  assert.equal(second.get(ID_A).status, JOB_STATUS.COMPLETED);
  assert.deepEqual(second.get(ID_A).result, { ok: true });
});

test("a leftover .tmp file from a crash mid-write is ignored during hydration, not mistaken for a job file", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ID_A}.json.tmp`), JSON.stringify({ storeVersion: 1, job: createJob(ID_A) }));

  const store = new FileJobStore({ dir });

  assert.deepEqual(store.list(), []);
});
