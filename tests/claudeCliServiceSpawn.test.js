import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnAndCollect, invoke } from "../src/services/claudeCliService.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

// Real spawn() mechanics, exercised against `node -e "..."` instead of claude.exe — no
// buildArgs() in the loop here (Node's own CLI rejects `--model`-shaped args passed after
// `-p`/`-e`, so buildArgs' fixed argv can't be replayed through `node` directly; that's
// exactly why spawnAndCollect is decoupled from arg-building in the first place).
const NODE = process.execPath;
const DEFAULT_OPTS = { maxBufferBytes: 10 * 1024 * 1024 };

test("resolves {raw, exitCode: 0, stderr} on a normal successful exit", async () => {
  const result = await spawnAndCollect(NODE, ["-e", "console.log('hello')"], {}, DEFAULT_OPTS);
  assert.equal(result.raw, "hello\n");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
});

test("captures stderr separately from stdout", async () => {
  const result = await spawnAndCollect(
    NODE,
    ["-e", "console.error('a warning'); console.log('the output')"],
    {},
    DEFAULT_OPTS
  );
  assert.equal(result.raw, "the output\n");
  assert.equal(result.stderr, "a warning\n");
});

test("resolves with output even on a non-zero exit (claude prints JSON on task failure too)", async () => {
  const result = await spawnAndCollect(
    NODE,
    ["-e", "console.log('partial output'); process.exit(1)"],
    {},
    DEFAULT_OPTS
  );
  assert.equal(result.raw, "partial output\n");
  assert.equal(result.exitCode, 1);
});

test("rejects on a non-zero exit with no stdout at all", async () => {
  await assert.rejects(
    () => spawnAndCollect(NODE, ["-e", "process.exit(3)"], {}, DEFAULT_OPTS),
    /exited with code 3/
  );
});

test("rejects with an AbortError when the signal fires mid-execution", async () => {
  const controller = new AbortController();
  const promise = spawnAndCollect(
    NODE,
    ["-e", "setTimeout(() => {}, 5000)"],
    { signal: controller.signal },
    DEFAULT_OPTS
  );
  setTimeout(() => controller.abort(), 100);

  await assert.rejects(() => promise, (err) => err.name === "AbortError");
});

test("rejects when the buffer limit is exceeded, and the process is killed", async () => {
  await assert.rejects(
    () =>
      spawnAndCollect(
        NODE,
        ["-e", "setInterval(() => process.stdout.write('x'.repeat(1000)), 5)"],
        {},
        { maxBufferBytes: 500 }
      ),
    /maxBufferBytes/
  );
});

test("rejects with ENOENT for a binary that doesn't exist", async () => {
  await assert.rejects(
    () => spawnAndCollect("this-binary-does-not-exist-xyz", [], {}, DEFAULT_OPTS),
    (err) => err.code === "ENOENT"
  );
});

test("onSpawn fires once the process has actually started", async () => {
  let spawned = false;
  await spawnAndCollect(NODE, ["-e", "console.log('ok')"], {}, { ...DEFAULT_OPTS, onSpawn: () => (spawned = true) });
  assert.equal(spawned, true);
});

test("publishes OutputChunk events for stdout and stderr as they arrive, tagged with jobId", async () => {
  const bus = createRuntimeEventBus();
  const chunks = [];
  bus.subscribe(EVENT_TYPES.OUTPUT_CHUNK, (e) => chunks.push(e));

  await spawnAndCollect(
    NODE,
    ["-e", "console.error('stderr line'); console.log('stdout line')"],
    {},
    { ...DEFAULT_OPTS, bus, jobId: "job-123" }
  );

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((e) => e.jobId === "job-123"));
  assert.ok(chunks.some((e) => e.payload.stream === "stdout" && e.payload.chunk.includes("stdout line")));
  assert.ok(chunks.some((e) => e.payload.stream === "stderr" && e.payload.chunk.includes("stderr line")));
  assert.ok(chunks.every((e) => e.payload.timestamp));
});

test("no bus given: spawnAndCollect still works, just publishes nothing", async () => {
  await assert.doesNotReject(() => spawnAndCollect(NODE, ["-e", "console.log('ok')"], {}, DEFAULT_OPTS));
});

test("invoke() composes buildArgs + spawnAndCollect + parseResult without swallowing errors", async () => {
  // A real claude-shaped argv (-p, --model, ...) can't be replayed against plain `node` (its
  // CLI parser rejects unrecognized `--model`-style flags) — spawnAndCollect's tests above
  // already cover the spawn mechanics directly. This confirms invoke()'s own composition
  // propagates an error end to end instead of hanging or swallowing it.
  const config = { claudeBin: "nonexistent-xyz", maxBufferBytes: 10 * 1024 * 1024 };
  const context = {
    model: "sonnet",
    effort: "low",
    timeoutMs: 5000,
    workingDirectory: process.cwd(),
    allowedTools: "Read",
    trustAll: false,
    maxBudgetUsd: 1,
    metadata: {},
    environment: process.env,
  };
  await assert.rejects(() => invoke("hi", context, config, {}), (err) => err.code === "ENOENT");
});
