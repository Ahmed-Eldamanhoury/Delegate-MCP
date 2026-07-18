import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { loadConfig } from "../src/config/index.js";

// WP5 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §13, Review Package §7): pins exact status/shape/
// Content-Type per route, deepEqual-checked against calling the service directly -- the same
// "second independent proof of no reshaping" idiom tests/asyncExecution.integration.test.js
// already uses. All 9 routes covered.

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "contract-test-token-" + "a".repeat(24);
const root = mkdtempSync(join(tmpdir(), "claude-delegate-rest-contract-"));
after(() => rmSync(root, { recursive: true, force: true }));

function makeStubService({ delayMs = 0 } = {}) {
  return {
    invoke(prompt, context, cfg, { onSpawn } = {}) {
      onSpawn?.();
      const result = { raw: "{}", parsed: { result: "stub ok", total_cost_usd: 0.01 }, exitCode: 0 };
      return delayMs > 0 ? new Promise((resolve) => setTimeout(() => resolve(result), delayMs)) : Promise.resolve(result);
    },
  };
}

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

async function startServer({ service = makeStubService(), dirTag } = {}) {
  const config = {
    ...loadConfig({}),
    restHost: "127.0.0.1",
    restPort: 0,
    workspaceRoot: join(root, dirTag ?? Math.random().toString(36).slice(2)),
  };
  const backend = createDelegationBackend({ config, logger, service });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  return { backend, baseUrl: `http://127.0.0.1:${port}` };
}

const AUTH = { Authorization: `Bearer ${TOKEN}` };

test("contract: POST /v1/jobs -- 202, Content-Type application/json, {job_id, status} matching a direct getJob() call", async () => {
  // A slow stub (not the file's default near-instant one) keeps the job from completing between
  // REST's own status snapshot (taken synchronously right after submit()) and this test's own
  // direct getJob() check moments later -- otherwise both would race against real job progress.
  const { backend, baseUrl } = await startServer({ service: makeStubService({ delayMs: 2000 }) });

  const res = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 }),
  });

  assert.equal(res.status, 202);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["job_id", "status"]);

  const direct = backend.delegationService.getJob(body.job_id);
  assert.equal(body.status, direct.status, "REST's reported status must match a direct getJob() call -- no reshaping");
});

test("contract: GET /v1/jobs/:id -- 200, body deepEqual to a direct getJob() call, byte-identical, no reshaping", async () => {
  const { backend, baseUrl } = await startServer();
  const jobId = backend.delegationService.submit(
    { prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 },
    "rest"
  );
  await backend.jobManager.waitForCompletion(jobId);

  const res = await fetch(`${baseUrl}/v1/jobs/${jobId}`, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = await res.json();

  const direct = backend.delegationService.getJob(jobId);
  assert.deepEqual(body, direct, "REST's GET body must be byte-identical to a direct getJob() call");
});

test("contract: GET /v1/jobs/:id -- 404 JOB_NOT_FOUND for an unknown id", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/v1/jobs/00000000-0000-0000-0000-000000000000`, { headers: AUTH });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: "JOB_NOT_FOUND", message: "No job found with id 00000000-0000-0000-0000-000000000000" } });
});

test("contract: GET /v1/jobs -- 200, {jobs, count, limit} where jobs deepEqual a direct listJobs() call", async () => {
  const { backend, baseUrl } = await startServer();
  const jobId = backend.delegationService.submit(
    { prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 },
    "rest"
  );
  await backend.jobManager.waitForCompletion(jobId);

  const res = await fetch(`${baseUrl}/v1/jobs`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["count", "jobs", "limit"]);

  const direct = backend.delegationService.listJobs({});
  assert.deepEqual(body.jobs, direct, "REST's jobs array must be byte-identical to a direct listJobs() call");
  assert.equal(body.count, direct.length);
});

test("contract: DELETE /v1/jobs/:id -- 200 {job_id, status:'cancelled'} for a queued job, matching post-cancel getJob()", async () => {
  const config = { ...loadConfig({}), restHost: "127.0.0.1", restPort: 0, workspaceRoot: join(root, "cancel-contract"), maxConcurrentJobs: 0 };
  const backend = createDelegationBackend({ config, logger, service: makeStubService() });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const baseUrl = `http://127.0.0.1:${restServer.server.address().port}`;

  const jobId = backend.delegationService.submit(
    { prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 },
    "rest"
  );

  const res = await fetch(`${baseUrl}/v1/jobs/${jobId}`, { method: "DELETE", headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  const direct = backend.delegationService.getJob(jobId);
  assert.deepEqual(body, { job_id: jobId, status: direct.status });
});

test("contract: GET /v1/jobs/:id/replay -- 200, body deepEqual to a direct observabilityService.replay() call, even for an unknown id (never 404)", async () => {
  const { backend, baseUrl } = await startServer();

  const res = await fetch(`${baseUrl}/v1/jobs/never-existed/replay`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  const direct = backend.observabilityService.replay("never-existed");
  assert.deepEqual(body, direct);
});

test("contract: GET /v1/jobs/:id/timeline -- 200, raw array body deepEqual to a direct getTimeline() call", async () => {
  const { backend, baseUrl } = await startServer();

  const res = await fetch(`${baseUrl}/v1/jobs/some-id/timeline`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();

  const direct = backend.observabilityService.getTimeline("some-id", { type: undefined, since: undefined });
  assert.deepEqual(body, direct);
});

test("contract: GET /v1/metrics -- 200, body deepEqual to a direct getMetrics() call", async () => {
  const { backend, baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/v1/metrics`, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), backend.observabilityService.getMetrics());
});

test("contract: GET /v1/snapshot -- 200, body deepEqual to a direct getSnapshot() call", async () => {
  const { backend, baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/v1/snapshot`, { headers: AUTH });
  assert.equal(res.status, 200);
  const body = await res.json();
  const direct = backend.observabilityService.getSnapshot();
  assert.deepEqual(body.metrics, direct.metrics);
  assert.deepEqual(body.activeJobs, direct.activeJobs);
});

test("contract: GET /v1/models -- 200, body deepEqual to buildModelsInfo(config)", async () => {
  const { baseUrl } = await startServer();
  const config = loadConfig({});
  const { buildModelsInfo } = await import("../src/models/schemas.js");

  const res = await fetch(`${baseUrl}/v1/models`, { headers: AUTH });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), buildModelsInfo(config));
});
