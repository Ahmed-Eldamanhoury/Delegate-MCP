import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { wireWorkspaceToEventBus } from "../src/services/workspaceEventBridge.js";
import { createDelegationService } from "../src/services/delegationService.js";
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

function newDelegationService(jobManager) {
  return createDelegationService({ jobManager, config, logger });
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
  const delegationService = newDelegationService(jobManager);
  const status = createDelegateStatusHandler({ delegationService });

  const response = await status({ job_id: "does-not-exist" });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, "No job found with id does-not-exist");
  assert.equal(response.structuredContent, undefined);
});

test("delegate_cancel: unknown job id returns isError:true with a descriptive message", async () => {
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const cancel = createDelegateCancelHandler({ delegationService });

  const response = await cancel({ job_id: "does-not-exist" });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, "No job found with id does-not-exist");
});

test("delegate_cancel: an already-terminal job's error message names its actual status", async () => {
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const cancel = createDelegateCancelHandler({ delegationService });
  const jobId = jobManager.submit(delayTask(5, "done"));
  await waitUntil(() => jobManager.getJob(jobId).status === "completed");

  const response = await cancel({ job_id: jobId });

  assert.equal(response.isError, true);
  assert.equal(response.content[0].text, `Job ${jobId} could not be cancelled (status: completed).`);
});

test("delegate_cancel: a repeat cancel on an already-cancelled job names 'cancelled' as its status", async () => {
  // maxConcurrent: 0 keeps the job "queued" forever so the first cancelJob() takes the
  // synchronous queued->cancelled path (jobManager.js's other path -- aborting a running
  // job -- settles asynchronously later and is not what this pins). This is the exact
  // "before" baseline ADR-0011's disclosed REST/MCP idempotency divergence (REST's DELETE
  // is idempotent; today's MCP delegate_cancel is not) must diverge FROM, not accidentally
  // change to match.
  const jobManager = new JobManager({ maxConcurrent: 0 });
  wireWorkspaceToEventBus({ bus: jobManager.bus, jobManager, config, logger });
  const delegationService = newDelegationService(jobManager);
  const cancel = createDelegateCancelHandler({ delegationService });
  const jobId = jobManager.submit(delayTask(5, "done"));

  const first = await cancel({ job_id: jobId });
  assert.equal(first.isError, undefined);
  assert.equal(jobManager.getJob(jobId).status, "cancelled");

  const second = await cancel({ job_id: jobId });
  assert.equal(second.isError, true);
  assert.equal(second.content[0].text, `Job ${jobId} could not be cancelled (status: cancelled).`);
});

test("JobManager.cancelJob: a second call on the same still-unsettled running job also returns true, not false", async () => {
  // Distinct code path from the queued-job test above: a RUNNING job's cancelJob() (jobManager.js
  // lines 100-103) is fire-and-forget -- it only calls the AbortController's abort() and returns
  // true immediately; the actual running->cancelled transition happens later, asynchronously,
  // inside _run()'s catch block. Nothing removes the controller from `this.running` or checks
  // "have I already been asked to cancel" before that transition settles, so today a second
  // cancelJob() call in that window calls abort() again (a no-op on an already-aborted
  // controller) and ALSO returns true -- not false, and the job is NOT yet "cancelled". Both
  // calls here are synchronous with no await between them, so there is no microtask-ordering
  // ambiguity about which state is observed. A future change chasing REST's idempotent-DELETE
  // semantics (ADR-0011) that adds an in-flight-cancel guard must not silently flip this MCP
  // behavior without a test catching it.
  const jobManager = newJobManager();
  const jobId = jobManager.submit(delayTask(50, "done"));
  assert.equal(jobManager.getJob(jobId).status, "running", "delayTask's markRunning() fires synchronously inside submit()");

  const first = jobManager.cancelJob(jobId);
  const second = jobManager.cancelJob(jobId);

  assert.equal(first, true);
  assert.equal(second, true, "today, cancelJob() has no guard against a second abort() before the async settle");
  assert.equal(jobManager.getJob(jobId).status, "running", "status hasn't transitioned yet -- both calls raced ahead of _run()'s async settle");

  await jobManager.waitForCompletion(jobId); // let the aborted job actually settle so the process can exit cleanly
  assert.equal(jobManager.getJob(jobId).status, "cancelled");
});

test("delegate_status / delegate_cancel: an unknown job id -- whether malformed-shaped or a well-formed-but-nonexistent UUID -- is treated identically", async () => {
  // No isValidJobId() guard exists in DelegationService today (that's an ADR-0011 Stage 2
  // addition) -- this pins that, pre-guard, delegate_status/delegate_cancel never throw and
  // never special-case a malformed shape; every unknown id, regardless of shape, falls through
  // to the same "No job found" path. Stage 2's guard must reproduce this, not introduce a new
  // failure mode. "00000000-..." below is deliberately UUID-shaped (matches isValidJobId's
  // own regex) -- it's the well-formed-but-unknown case, kept distinct from the genuinely
  // malformed shapes so this test doesn't overclaim what each input actually exercises.
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const status = createDelegateStatusHandler({ delegationService });
  const cancel = createDelegateCancelHandler({ delegationService });

  for (const malformed of ["", "../../etc/passwd", "not a uuid at all!!", "00000000-0000-0000-0000-000000000000"]) {
    const statusResponse = await status({ job_id: malformed });
    assert.equal(statusResponse.isError, true);
    assert.equal(statusResponse.content[0].text, `No job found with id ${malformed}`);

    const cancelResponse = await cancel({ job_id: malformed });
    assert.equal(cancelResponse.isError, true);
    assert.equal(cancelResponse.content[0].text, `No job found with id ${malformed}`);
  }
});

test("delegate_history: status filter returns only jobs matching that exact status", async () => {
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const history = createDelegateHistoryHandler({ delegationService });
  const cancel = createDelegateCancelHandler({ delegationService });

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
  const delegationService = newDelegationService(jobManager);
  const history = createDelegateHistoryHandler({ delegationService });

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
  const delegationService = newDelegationService(jobManager);
  const history = createDelegateHistoryHandler({ delegationService });
  const ids = [0, 1, 2].map((i) => jobManager.submit(delayTask(20, `job-${i}`)));

  // The handler itself takes whatever it's given; the 20-default lives in the MCP schema
  // (pinned separately in tests/toolRegistry.characterization.test.js), not in this function --
  // calling it with {} exercises delegateHistoryHandler.js's own destructuring of `limit`.
  const response = await history({ limit: undefined, status: undefined });
  assert.equal(response.structuredContent.jobs.length, 3, "fewer jobs than any limit still returns all of them");

  await Promise.all(ids.map((id) => jobManager.waitForCompletion(id)));
});

test("delegate_history: default limit is 20 when the handler is called with no explicit limit, capping more than 20 jobs end-to-end", async () => {
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const history = createDelegateHistoryHandler({ delegationService });
  const ids = [];
  for (let i = 0; i < 25; i++) {
    ids.push(jobManager.submit(delayTask(5, `job-${i}`)));
  }

  // STAGE_1B_DESIGN_PACKAGE.md acceptance criterion 5: delegationService.listJobs() defaults
  // limit to 20 when not supplied. Proven at the unit level for the service itself in WP1's
  // tests; this proves the same default flows all the way through the handler now that it's
  // rerouted through delegationService instead of calling jobManager directly.
  const response = await history({ limit: undefined, status: undefined });
  assert.equal(response.structuredContent.jobs.length, 20);

  await Promise.all(ids.map((id) => jobManager.waitForCompletion(id)));
});

test("delegate_history: no jobs recorded yet returns an empty list with a human-readable placeholder", async () => {
  const jobManager = newJobManager();
  const delegationService = newDelegationService(jobManager);
  const history = createDelegateHistoryHandler({ delegationService });

  const response = await history({ limit: 20 });

  assert.deepEqual(response.structuredContent.jobs, []);
  assert.equal(response.content[0].text, "No jobs recorded yet.");
});
