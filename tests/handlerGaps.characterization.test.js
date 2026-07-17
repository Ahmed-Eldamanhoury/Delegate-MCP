import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { wireWorkspaceToEventBus } from "../src/services/workspaceEventBridge.js";
import { createDelegateModelsHandler } from "../src/handlers/delegateModelsHandler.js";
import { createDelegateStatusHandler } from "../src/handlers/delegateStatusHandler.js";
import { createDelegateHistoryHandler } from "../src/handlers/delegateHistoryHandler.js";
import { createDelegateCancelHandler } from "../src/handlers/delegateCancelHandler.js";
import { waitUntil, delayTask } from "./testUtils.js";

// Stage 1a characterization (ADR-0010): closes specific gaps not covered by
// tests/asyncExecution.integration.test.js -- delegate_models had no test at all;
// delegate_status/delegate_cancel's unknown-job-id error path was untested; delegate_history's
// status filter and limit/ordering semantics (the exact logic ADR-0010 §4.1/§4.2 assigns to
// DelegationService.listJobs() in Stage 1b) were untested. These pin the pre-refactor baseline
// Stage 1b must reproduce byte-identically.

const tempWorkspaceRoot = mkdtempSync(join(tmpdir(), "claude-delegate-gaps-test-"));
after(() => rmSync(tempWorkspaceRoot, { recursive: true, force: true }));
const config = { ...loadConfig({}), workspaceRoot: tempWorkspaceRoot };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function newJobManager() {
  const jobManager = new JobManager({ maxConcurrent: 3 });
  wireWorkspaceToEventBus({ bus: jobManager.bus, jobManager, config, logger });
  return jobManager;
}

test("delegate_models: full response shape, model list, fallbacks, efforts, and defaults", async () => {
  const models = createDelegateModelsHandler({ config });
  const response = await models();

  assert.ok(Array.isArray(response.content));
  assert.equal(response.content[0].type, "text");
  assert.ok(response.structuredContent);
  assert.equal(response.isError, undefined);

  assert.deepEqual(
    response.structuredContent.models.map((m) => m.model),
    ["haiku", "sonnet", "opus", "fable"]
  );
  assert.deepEqual(response.structuredContent.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(response.structuredContent.defaults, {
    model: "sonnet",
    effort: "low",
    maxBudgetUsd: config.defaultMaxBudgetUsd,
  });
  // Text is a human-readable line per model, fallback shown in parens when present.
  const haiku = response.structuredContent.models.find((m) => m.model === "haiku");
  assert.equal(haiku.fallback, null, "haiku has no configured fallback");
  assert.ok(!response.content[0].text.includes("haiku ("), "no fallback suffix when fallback is null");
});

test("delegate_status: unknown job id returns isError:true with a descriptive message, not a thrown exception", async () => {
  const jobManager = newJobManager();
  const status = createDelegateStatusHandler({ jobManager });

  const response = await status({ job_id: "does-not-exist" });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, "No job found with id does-not-exist");
  assert.equal(response.structuredContent, undefined);
});

test("delegate_cancel: unknown job id returns isError:true with a descriptive message", async () => {
  const jobManager = newJobManager();
  const cancel = createDelegateCancelHandler({ jobManager });

  const response = await cancel({ job_id: "does-not-exist" });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, "No job found with id does-not-exist");
});

test("delegate_cancel: an already-terminal job's error message names its actual status", async () => {
  const jobManager = newJobManager();
  const cancel = createDelegateCancelHandler({ jobManager });
  const jobId = jobManager.submit(delayTask(5, "done"));
  await waitUntil(() => jobManager.getJob(jobId).status === "completed");

  const response = await cancel({ job_id: jobId });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, `Job ${jobId} could not be cancelled (status: completed).`);
});

test("delegate_history: status filter returns only jobs matching that exact status", async () => {
  const jobManager = newJobManager();
  const history = createDelegateHistoryHandler({ jobManager });
  const cancel = createDelegateCancelHandler({ jobManager });

  const completedId = jobManager.submit(delayTask(5, "ok"));
  const toCancelId = jobManager.submit(delayTask(5000, "slow"));
  await waitUntil(() => jobManager.getJob(completedId).status === "completed");
  await cancel({ job_id: toCancelId });
  await waitUntil(() => jobManager.getJob(toCancelId).status === "cancelled");

  const completedOnly = await history({ status: "completed" });
  const completedIds = completedOnly.structuredContent.jobs.map((j) => j.id);
  assert.ok(completedIds.includes(completedId));
  assert.ok(!completedIds.includes(toCancelId));

  const cancelledOnly = await history({ status: "cancelled" });
  const cancelledIds = cancelledOnly.structuredContent.jobs.map((j) => j.id);
  assert.ok(cancelledIds.includes(toCancelId));
  assert.ok(!cancelledIds.includes(completedId));
});

test("delegate_history: limit returns exactly N jobs, most-recently-submitted first", async () => {
  const jobManager = newJobManager();
  const history = createDelegateHistoryHandler({ jobManager });

  // Short delay, but still long enough that all 5 submits land (synchronously) before any
  // completes -- and explicitly drained below so no job outlives this test (matching the
  // established convention in asyncExecution.integration.test.js's delegate_submit test: an
  // undrained background job races arbitrarily against whichever test runs next, and against
  // this file's own `after()` hook removing the shared temp workspace root).
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(jobManager.submit(delayTask(20, `job-${i}`)));
  }

  const limited = await history({ limit: 2 });
  assert.equal(limited.structuredContent.jobs.length, 2);
  // slice(-limit).reverse(): the 2 most recently submitted, newest first.
  assert.deepEqual(
    limited.structuredContent.jobs.map((j) => j.id),
    [ids[4], ids[3]]
  );

  await Promise.all(ids.map((id) => jobManager.waitForCompletion(id)));
});

test("delegate_history: default limit is 20 when the handler is called with no arguments at all", async () => {
  const jobManager = newJobManager();
  const history = createDelegateHistoryHandler({ jobManager });
  const ids = [0, 1, 2].map((i) => jobManager.submit(delayTask(20, `job-${i}`)));

  // The handler itself takes whatever it's given; the 20-default lives in the MCP schema
  // (pinned separately in tests/toolRegistry.characterization.test.js), not in this function --
  // calling it with {} exercises delegateHistoryHandler.js's own destructuring of `limit`.
  const response = await history({ limit: undefined, status: undefined });
  assert.equal(response.structuredContent.jobs.length, 3, "fewer jobs than any limit still returns all of them");

  await Promise.all(ids.map((id) => jobManager.waitForCompletion(id)));
});

test("delegate_history: no jobs recorded yet returns an empty list with a human-readable placeholder", async () => {
  const jobManager = newJobManager();
  const history = createDelegateHistoryHandler({ jobManager });

  const response = await history({ limit: 20 });

  assert.deepEqual(response.structuredContent.jobs, []);
  assert.equal(response.content[0].text, "No jobs recorded yet.");
});
