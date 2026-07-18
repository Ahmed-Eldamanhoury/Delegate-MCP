import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { loadConfig } from "../src/config/index.js";

// WP5 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §8, ADR-0011 Security): request body-size limit
// enforcement over real HTTP -- both the immediate Content-Length gate (any route) and
// handleSubmit's own streamBoundedBody (POST /v1/jobs specifically), plus "applies regardless of
// authentication state."

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "bodysize-test-token-" + "a".repeat(24);
const MAX_BYTES = 256;
const root = mkdtempSync(join(tmpdir(), "claude-delegate-rest-bodysize-"));
after(() => rmSync(root, { recursive: true, force: true }));

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

async function startServer() {
  const config = {
    ...loadConfig({}),
    restHost: "127.0.0.1",
    restPort: 0,
    restMaxBodyBytes: MAX_BYTES,
    workspaceRoot: join(root, "workspace"),
  };
  const backend = createDelegationBackend({ config, logger, service: { invoke: () => new Promise(() => {}) } });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  return `http://127.0.0.1:${port}`;
}

const AUTH = { Authorization: `Bearer ${TOKEN}` };

test("POST /v1/jobs with a Content-Length declaring more than the limit -> 413, before route logic runs", async () => {
  const baseUrl = await startServer();
  const oversized = "x".repeat(MAX_BYTES * 4);

  const res = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers: AUTH, body: oversized });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("a request under the Content-Length limit is accepted (not 413) -- the limit is real, not a blanket rejection", async () => {
  const baseUrl = await startServer();
  const small = JSON.stringify({ prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 });
  assert.ok(small.length < MAX_BYTES, "test setup: the small body must actually be under the configured limit");

  const res = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: small,
  });
  assert.notEqual(res.status, 413);
  assert.equal(res.status, 202);
});

test("the Content-Length gate applies to ANY route, not just POST /v1/jobs -- even an unroutable path", async () => {
  const baseUrl = await startServer();
  const res = await fetch(`${baseUrl}/v1/does-not-exist`, {
    method: "POST",
    headers: { ...AUTH, "Content-Length": String(MAX_BYTES * 10) },
    body: "x".repeat(MAX_BYTES * 10),
  });
  assert.equal(res.status, 413);
});

test("body-size limit applies regardless of authentication state -- an oversized body from an unauthenticated caller ALSO gets 413, not 401", async () => {
  const baseUrl = await startServer();
  const res = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Length": String(MAX_BYTES * 10) }, // no Authorization header at all
    body: "x".repeat(MAX_BYTES * 10),
  });
  assert.equal(res.status, 413, "the body-size gate runs before the auth check (§8 step 1 before step 2), so this must be 413, not 401");
});

test("body-size limit applies regardless of authentication state -- a WRONG token still gets 413 for an oversized body, not 401", async () => {
  const baseUrl = await startServer();
  const res = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token", "Content-Length": String(MAX_BYTES * 10) },
    body: "x".repeat(MAX_BYTES * 10),
  });
  assert.equal(res.status, 413);
});
