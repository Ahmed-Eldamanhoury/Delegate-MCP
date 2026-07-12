import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { getWorkspaceRoot } from "../src/services/workspaceManager.js";
import { wireWorkspaceToEventBus } from "../src/services/workspaceEventBridge.js";
import { createDelegateTaskHandler } from "../src/handlers/delegateTaskHandler.js";
import { createDelegateSubmitHandler } from "../src/handlers/delegateSubmitHandler.js";
import { createDelegateStatusHandler } from "../src/handlers/delegateStatusHandler.js";
import { createDelegateHistoryHandler } from "../src/handlers/delegateHistoryHandler.js";
import { createDelegateCancelHandler } from "../src/handlers/delegateCancelHandler.js";
import { waitUntil } from "./testUtils.js";

// Handlers go through the real delegationService -> RuntimeEventBus -> workspaceManager (not
// stubbed) so these tests also exercise real disk I/O — but isolated to a temp dir, never the
// project's own workspace/ directory.
const tempWorkspaceRoot = mkdtempSync(join(tmpdir(), "claude-delegate-test-"));
after(() => rmSync(tempWorkspaceRoot, { recursive: true, force: true }));

const config = { ...loadConfig({}), workspaceRoot: tempWorkspaceRoot };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Stand-in for claudeCliService — same (prompt, context, config, {signal, onSpawn}) contract. */
function makeStubService({ delayMs = 20, shouldFail = false } = {}) {
  return {
    invoke(prompt, context, cfg, { signal, onSpawn } = {}) {
      return new Promise((resolve, reject) => {
        onSpawn?.();
        const timer = setTimeout(() => {
          if (shouldFail) return reject(new Error("stub cli failure"));
          resolve({
            raw: "{}",
            parsed: { type: "result", is_error: false, total_cost_usd: 0.02, num_turns: 1, result: "stub ok" },
            exitCode: 0,
          });
        }, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  };
}

function baseInput(overrides = {}) {
  return {
    prompt: "say hi",
    model: "sonnet",
    effort: "low",
    allowed_tools: "Read Grep",
    trust_all: false,
    max_budget_usd: 1,
    ...overrides,
  };
}

function buildHandlers(jobManager, service) {
  // Workspace persistence is a bus subscriber now (ADR-0002 Phase 4) — mcpServer.js wires
  // this in production; tests must wire it explicitly for each JobManager they construct.
  wireWorkspaceToEventBus({ bus: jobManager.bus, jobManager, config, logger });
  return {
    task: createDelegateTaskHandler({ config, logger, jobManager, service }),
    submit: createDelegateSubmitHandler({ config, logger, jobManager, service }),
    status: createDelegateStatusHandler({ jobManager }),
    history: createDelegateHistoryHandler({ jobManager }),
    cancel: createDelegateCancelHandler({ jobManager }),
  };
}

test("delegate_submit returns immediately regardless of task duration", async () => {
  const jobManager = new JobManager({ maxConcurrent: 2 });
  const { submit } = buildHandlers(jobManager, makeStubService({ delayMs: 300 }));

  const start = Date.now();
  const response = await submit(baseInput());
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs < 100, `delegate_submit blocked for ${elapsedMs}ms`);
  assert.equal(response.structuredContent.success, true);
  assert.ok(response.structuredContent.job_id);
  assert.match(response.structuredContent.status, /^(queued|starting|running)$/);

  // content text is the same JSON shape as structuredContent (per the spec's example response)
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
});

test("delegate_task still blocks until completion, with an unchanged response shape", async () => {
  const jobManager = new JobManager({ maxConcurrent: 2 });
  const { task } = buildHandlers(jobManager, makeStubService({ delayMs: 30 }));

  const start = Date.now();
  const response = await task(baseInput());
  const elapsedMs = Date.now() - start;

  assert.ok(elapsedMs >= 25, "delegate_task returned before the task actually finished");
  assert.equal(response.isError, false);
  assert.equal(response.content[0].text, "[model=sonnet cost=$0.02 turns=1]\nstub ok");
  assert.equal(response.structuredContent.result, "stub ok");
});

test("delegate_task forwards progress notifications when the caller supplies a progressToken", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const { task } = buildHandlers(jobManager, makeStubService({ delayMs: 15 }));

  const notifications = [];
  const extra = {
    _meta: { progressToken: "tok-abc" },
    sendNotification: async (n) => notifications.push(n),
  };

  const response = await task(baseInput(), extra);

  assert.equal(response.isError, false);
  // Note: submit() can drive a job synchronously through starting->running before this
  // subscription (set up just after, since it needs the jobId submit() returns) exists to
  // catch it — same characteristic Sprint 2 documented for delegate_submit's status. The
  // terminal event always fires later (the stub's setTimeout), so it's always caught.
  assert.ok(notifications.length >= 1, "expected at least the terminal notification");
  assert.ok(notifications.every((n) => n.params.progressToken === "tok-abc"));
  assert.ok(notifications.every((n) => n.method === "notifications/progress"));
  assert.equal(notifications.at(-1).params.message, "Job completed");
});

test("delegate_task without a progressToken sends no notifications and behaves identically", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const { task } = buildHandlers(jobManager, makeStubService({ delayMs: 10 }));

  const response = await task(baseInput()); // no `extra` at all — matches real callers that don't request progress
  assert.equal(response.isError, false);
  assert.equal(response.content[0].text, "[model=sonnet cost=$0.02 turns=1]\nstub ok");
});

test("delegate_task falls back to raw text when the CLI output isn't JSON", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const nonJsonService = {
    async invoke(prompt, context, cfg, { onSpawn } = {}) {
      onSpawn?.();
      return { raw: "not json output", parsed: null, exitCode: 0 };
    },
  };
  const { task } = buildHandlers(jobManager, nonJsonService);

  const response = await task(baseInput());
  assert.equal(response.isError, undefined);
  assert.equal(response.content[0].text, "not json output");
  assert.equal(response.structuredContent, undefined);
});

test("delegate_task behaves identically whether or not delegate_submit/jobManager machinery is also in use", async () => {
  const jobManager = new JobManager({ maxConcurrent: 2 });
  const { task, submit } = buildHandlers(jobManager, makeStubService({ delayMs: 10 }));

  // Fire a background submit first — delegate_task's own response must not be affected by it.
  submit(baseInput({ prompt: "background noise" }));
  const response = await task(baseInput({ prompt: "say hi" }));

  assert.equal(response.isError, false);
  assert.equal(response.content[0].text, "[model=sonnet cost=$0.02 turns=1]\nstub ok");
});

test("full lifecycle: submit -> status -> history -> cancel(queued) -> cancel(running) -> completed", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 }); // forces the second submission to queue
  const slow = buildHandlers(jobManager, makeStubService({ delayMs: 10_000 }));

  // Job A occupies the only execution slot.
  const a = await slow.submit(baseInput({ prompt: "job a" }));
  const jobIdA = a.structuredContent.job_id;

  // Job B is submitted next — with maxConcurrent 1, it must still be queued.
  const b = await slow.submit(baseInput({ prompt: "job b" }));
  const jobIdB = b.structuredContent.job_id;
  assert.equal(jobManager.getJob(jobIdB).status, "queued");

  // status: inspect job A while it's in flight.
  await waitUntil(() => ["starting", "running"].includes(jobManager.getJob(jobIdA).status));
  const statusA = await slow.status({ job_id: jobIdA });
  assert.match(statusA.content[0].text, /model=sonnet/);
  assert.ok(statusA.structuredContent.runtimeMs >= 0);

  // history: both jobs show up, JobManager being the one place both delegate_submit calls wrote to.
  const hist = await slow.history({ limit: 10 });
  const historyIds = hist.structuredContent.jobs.map((j) => j.id);
  assert.ok(historyIds.includes(jobIdA));
  assert.ok(historyIds.includes(jobIdB));

  // cancel(queued): job B never runs, stays immutable at cancelled.
  const cancelB = await slow.cancel({ job_id: jobIdB });
  assert.ok(!cancelB.isError);
  assert.equal(jobManager.getJob(jobIdB).status, "cancelled");
  assert.equal(jobManager.getJob(jobIdB).startedAt, null);

  // cancel(running): job A's subprocess (stub) is aborted mid-flight.
  const cancelA = await slow.cancel({ job_id: jobIdA });
  assert.ok(!cancelA.isError);
  await waitUntil(() => jobManager.getJob(jobIdA).status === "cancelled");

  // completed: a third job, submitted through the same JobManager, runs to completion.
  const fast = buildHandlers(jobManager, makeStubService({ delayMs: 5 }));
  const c = await fast.submit(baseInput({ prompt: "job c" }));
  const jobIdC = c.structuredContent.job_id;
  await waitUntil(() => jobManager.getJob(jobIdC).status === "completed");

  const statusC = await fast.status({ job_id: jobIdC });
  assert.match(statusC.content[0].text, /^\[completed\]/);

  // Completed jobs are immutable — cancelling one fails.
  const cancelC = await fast.cancel({ job_id: jobIdC });
  assert.equal(cancelC.isError, true);

  // JobManager remains the single source of truth: all three jobs — regardless of which
  // handler instance created them — are visible from one shared history.
  const finalHistory = await fast.history({ limit: 10 });
  const finalIds = finalHistory.structuredContent.jobs.map((j) => j.id);
  assert.ok([jobIdA, jobIdB, jobIdC].every((id) => finalIds.includes(id)));
});

test("workspace: a completed job's artifacts are persisted to disk (metadata, stdout, result)", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const { task } = buildHandlers(jobManager, makeStubService({ delayMs: 5 }));

  const response = await task(baseInput({ prompt: "workspace check" }));
  assert.equal(response.isError, false);

  const jobs = jobManager.listJobs();
  const jobId = jobs[jobs.length - 1].id;
  const dir = join(getWorkspaceRoot(config), jobId);

  await waitUntil(() => existsSync(join(dir, "metadata.json")));
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "completed");
  assert.equal(readFileSync(join(dir, "stdout.log"), "utf8"), "{}");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).result, "stub ok");
  assert.ok(existsSync(join(dir, "context.json")));
  assert.ok(existsSync(join(dir, "artifacts")));
});

test("workspace: a failed job's workspace records the error", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const { task } = buildHandlers(jobManager, makeStubService({ delayMs: 5, shouldFail: true }));

  await task(baseInput({ prompt: "will fail" }));
  const jobId = jobManager.listJobs()[0].id;
  const dir = join(getWorkspaceRoot(config), jobId);

  await waitUntil(() => existsSync(join(dir, "metadata.json")));
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "stub cli failure");
});

test("workspace: a cancelled job's workspace still gets persisted (as cancelled, not left dangling)", async () => {
  const jobManager = new JobManager({ maxConcurrent: 1 });
  const { submit, cancel } = buildHandlers(jobManager, makeStubService({ delayMs: 5000 }));

  const submitted = await submit(baseInput({ prompt: "will be cancelled" }));
  const jobId = submitted.structuredContent.job_id;
  await waitUntil(() => ["starting", "running"].includes(jobManager.getJob(jobId).status));

  await cancel({ job_id: jobId });
  await waitUntil(() => jobManager.getJob(jobId).status === "cancelled");

  const dir = join(getWorkspaceRoot(config), jobId);
  await waitUntil(() => existsSync(join(dir, "metadata.json")));
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "cancelled");
});

test("workspace: concurrent jobs each get their own isolated workspace directory", async () => {
  const jobManager = new JobManager({ maxConcurrent: 3 });
  const { submit } = buildHandlers(jobManager, makeStubService({ delayMs: 15 }));

  const submitted = await Promise.all([
    submit(baseInput({ prompt: "concurrent a" })),
    submit(baseInput({ prompt: "concurrent b" })),
    submit(baseInput({ prompt: "concurrent c" })),
  ]);
  const jobIds = submitted.map((r) => r.structuredContent.job_id);
  assert.equal(new Set(jobIds).size, 3, "each job must have a distinct id");

  await Promise.all(jobIds.map((id) => waitUntil(() => jobManager.getJob(id).status === "completed")));

  const dirs = jobIds.map((id) => join(getWorkspaceRoot(config), id));
  await Promise.all(dirs.map((dir) => waitUntil(() => existsSync(join(dir, "metadata.json")))));
  // Each workspace only contains its own job's data — no cross-writes between concurrent jobs.
  dirs.forEach((dir, i) => {
    const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    assert.equal(metadata.id, jobIds[i]);
  });
});

test("workspace: pruneWorkspaces keeps disk usage bounded across many completed jobs", async () => {
  const jobManager = new JobManager({ maxConcurrent: 2 });
  const boundedConfig = { ...config, maxWorkspaceHistory: 3 };
  wireWorkspaceToEventBus({ bus: jobManager.bus, jobManager, config: boundedConfig, logger });
  const task = createDelegateTaskHandler({
    config: boundedConfig,
    logger,
    jobManager,
    service: makeStubService({ delayMs: 5 }),
  });

  for (let i = 0; i < 6; i++) {
    await task(baseInput({ prompt: `bounded ${i}` }));
  }

  // Workspace persistence reacts to the job's terminal bus event (workspaceEventBridge.js),
  // a separate subscriber from delegate_task's own await — poll rather than assume ordering.
  const jobsDir = getWorkspaceRoot(boundedConfig);
  const { readdirSync } = await import("node:fs");
  await waitUntil(() => existsSync(jobsDir) && readdirSync(jobsDir).length <= 3);

  const remaining = readdirSync(jobsDir);
  assert.ok(remaining.length <= 3, `expected at most 3 workspaces retained, found ${remaining.length}`);
});
