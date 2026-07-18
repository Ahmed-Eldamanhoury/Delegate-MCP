import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { createDelegateStatusHandler } from "../src/handlers/delegateStatusHandler.js";
import { createDelegateCancelHandler } from "../src/handlers/delegateCancelHandler.js";
import { loadConfig } from "../src/config/index.js";

// WP5 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §13, Review Package §7): full lifecycles via real
// fetch() against a real, ephemeral-port REST listener wired to real DelegationService/
// ObservabilityService (never a mocked service). Contains the shared-instance-parity
// non-negotiable test (item 2) as a distinctly named test.

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "integration-test-token-" + "a".repeat(24);
const root = mkdtempSync(join(tmpdir(), "claude-delegate-rest-integration-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Stand-in for claudeCliService, same contract asyncExecution.integration.test.js's own stub uses. */
function makeStubService({ delayMs = 20, shouldFail = false } = {}) {
  return {
    invoke(prompt, context, cfg, { signal, onSpawn } = {}) {
      return new Promise((resolve, reject) => {
        onSpawn?.();
        const timer = setTimeout(() => {
          if (shouldFail) return reject(new Error("stub cli failure"));
          resolve({ raw: "{}", parsed: { result: "stub ok", total_cost_usd: 0.01 }, exitCode: 0 });
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

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

async function startServer({ service = makeStubService(), dirTag, configOverrides = {} } = {}) {
  const config = {
    ...loadConfig({}),
    restHost: "127.0.0.1",
    restPort: 0,
    workspaceRoot: join(root, dirTag ?? Math.random().toString(36).slice(2)),
    ...configOverrides,
  };
  const backend = createDelegationBackend({ config, logger, service });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  return { backend, restServer, baseUrl: `http://127.0.0.1:${port}` };
}

const AUTH = { Authorization: `Bearer ${TOKEN}` };

test("submit -> poll -> complete: a full async job lifecycle over real HTTP", async () => {
  const { baseUrl } = await startServer();

  const submitRes = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "say hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  assert.equal(submitRes.status, 202);
  assert.ok(submitRes.headers.get("location").startsWith("/v1/jobs/"));
  const { job_id } = await submitRes.json();

  let final;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pollRes = await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH });
    const job = await pollRes.json();
    if (job.status === "completed") {
      final = job;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(final, "job never reached completed within the polling window");
  assert.equal(final.result.parsed.result, "stub ok");
});

test("cancel(queued): DELETE on a job that never got to run", async () => {
  const { baseUrl } = await startServer({
    service: makeStubService({ delayMs: 5000 }),
    configOverrides: { maxConcurrentJobs: 1 }, // default is 2 -- force genuine queueing with just 1
  });

  // Fill the only concurrency slot so the second submit stays genuinely queued.
  await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "occupant", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  const secondRes = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "queued-victim", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  const { job_id } = await secondRes.json();

  const beforeCancel = await (await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH })).json();
  assert.equal(beforeCancel.status, "queued");

  const cancelRes = await fetch(`${baseUrl}/v1/jobs/${job_id}`, { method: "DELETE", headers: AUTH });
  assert.equal(cancelRes.status, 200);
  const cancelled = await cancelRes.json();
  assert.equal(cancelled.status, "cancelled");
});

test("cancel(running): DELETE on a job already executing", async () => {
  const { baseUrl } = await startServer({ service: makeStubService({ delayMs: 5000 }) });

  const submitRes = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "long task", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  const { job_id } = await submitRes.json();

  let running = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await (await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH })).json();
    if (job.status === "running") {
      running = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(running, "job never reached running within the polling window");

  const cancelRes = await fetch(`${baseUrl}/v1/jobs/${job_id}`, { method: "DELETE", headers: AUTH });
  assert.equal(cancelRes.status, 200); // accepted -- may still be settling (fire-and-forget abort)
});

test("404-unknown-id: GET and DELETE on a job id that was never submitted", async () => {
  const { baseUrl } = await startServer();
  const unknownId = "00000000-0000-0000-0000-000000000000";

  const getRes = await fetch(`${baseUrl}/v1/jobs/${unknownId}`, { headers: AUTH });
  assert.equal(getRes.status, 404);
  assert.equal((await getRes.json()).error.code, "JOB_NOT_FOUND");

  const deleteRes = await fetch(`${baseUrl}/v1/jobs/${unknownId}`, { method: "DELETE", headers: AUTH });
  assert.equal(deleteRes.status, 404);
});

test("concurrent submissions: N simultaneous POSTs each get their own distinct job id and complete independently", async () => {
  const { baseUrl } = await startServer({ service: makeStubService({ delayMs: 15 }) });
  const CONCURRENCY = 10;

  const submissions = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      fetch(`${baseUrl}/v1/jobs`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `job-${i}`, model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
      }).then((r) => r.json())
    )
  );

  const jobIds = submissions.map((s) => s.job_id);
  assert.equal(new Set(jobIds).size, CONCURRENCY, "every concurrent submission must get its own distinct job id");

  const listRes = await fetch(`${baseUrl}/v1/jobs?limit=${CONCURRENCY}`, { headers: AUTH });
  const { jobs, count } = await listRes.json();
  assert.equal(count, CONCURRENCY);
  for (const id of jobIds) assert.ok(jobs.some((j) => j.id === id), `job ${id} missing from listJobs()`);
});

test("REST and MCP observe identical job state via one shared DelegationService instance -- non-negotiable proof (Review Package §7 item 2)", async () => {
  const config = { ...loadConfig({}), restHost: "127.0.0.1", restPort: 0, workspaceRoot: join(root, "shared-instance") };
  const backend = createDelegationBackend({ config, logger, service: makeStubService({ delayMs: 5000 }) });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Submitted via the REST HTTP transport...
  const submitRes = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "shared instance proof", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });
  const { job_id } = await submitRes.json();

  // ...observed via a real MCP handler, wired to the exact same backend.delegationService.
  const mcpStatus = createDelegateStatusHandler({ delegationService: backend.delegationService });
  const mcpResponse = await mcpStatus({ job_id });
  assert.equal(mcpResponse.isError, undefined, "MCP must see the job REST just submitted -- same backend, two transports");
  assert.equal(mcpResponse.structuredContent.id, job_id);

  // And observed via REST's own GET, for a three-way cross-check.
  const restJob = await (await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH })).json();
  assert.equal(restJob.id, mcpResponse.structuredContent.id);
  assert.equal(restJob.status, mcpResponse.structuredContent.status);

  // Cancel via MCP, observe via REST -- proving the shared instance both ways, not just read-only.
  const mcpCancel = createDelegateCancelHandler({ delegationService: backend.delegationService });
  await mcpCancel({ job_id });
  const afterMcpCancel = await (await fetch(`${baseUrl}/v1/jobs/${job_id}`, { headers: AUTH })).json();
  assert.equal(afterMcpCancel.status, "cancelled", "REST must observe a cancellation issued through MCP on the same shared instance");
});
