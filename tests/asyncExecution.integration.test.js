import { test } from "node:test";
import assert from "node:assert/strict";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { createDelegateTaskHandler } from "../src/handlers/delegateTaskHandler.js";
import { createDelegateSubmitHandler } from "../src/handlers/delegateSubmitHandler.js";
import { createDelegateStatusHandler } from "../src/handlers/delegateStatusHandler.js";
import { createDelegateHistoryHandler } from "../src/handlers/delegateHistoryHandler.js";
import { createDelegateCancelHandler } from "../src/handlers/delegateCancelHandler.js";
import { waitUntil } from "./testUtils.js";

const config = loadConfig({});
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
