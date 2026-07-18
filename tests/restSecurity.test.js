import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { loadConfig } from "../src/config/index.js";

// WP5 (ADR-0011 Testing Strategy > Security, REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §7): auth
// required/rejected on every route; path-traversal on :id; CORS preflight default-deny;
// credential/secret non-leakage in error bodies and logs; default-bind-address; body-size-limit
// regardless of auth state (dedicated deep coverage lives in restBodySize.integration.test.js --
// one cross-reference assertion here for Security-suite traceability, not full duplication).

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "security-test-token-" + "a".repeat(24);
const root = mkdtempSync(join(tmpdir(), "claude-delegate-rest-security-"));
after(() => rmSync(root, { recursive: true, force: true }));

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

async function startServer({ configOverrides = {} } = {}) {
  const config = { ...loadConfig({}), restHost: "127.0.0.1", restPort: 0, workspaceRoot: join(root, "workspace"), ...configOverrides };
  const backend = createDelegationBackend({ config, logger, service: { invoke: () => new Promise(() => {}) } });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  return { routes, baseUrl: `http://127.0.0.1:${port}` };
}

test("every registered route requires auth -- a request with no Authorization header gets 401, never reaches the handler", async () => {
  const { routes, baseUrl } = await startServer();

  for (const route of routes) {
    const path = route.path.replace(":id", "00000000-0000-0000-0000-000000000000");
    const res = await fetch(`${baseUrl}${path}`, { method: route.method });
    assert.equal(res.status, 401, `${route.method} ${route.path} must require auth`);
  }
});

test("every registered route rejects a wrong token with 401", async () => {
  const { routes, baseUrl } = await startServer();

  for (const route of routes) {
    const path = route.path.replace(":id", "00000000-0000-0000-0000-000000000000");
    const res = await fetch(`${baseUrl}${path}`, { method: route.method, headers: { Authorization: "Bearer completely-wrong" } });
    assert.equal(res.status, 401, `${route.method} ${route.path} must reject a wrong token`);
  }
});

test("a path-traversal attempt on :id is treated as an ordinary unknown/malformed id -- 404, never a filesystem read or 500", async () => {
  const { baseUrl } = await startServer();
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  for (const traversal of ["..%2F..%2F..%2Fetc%2Fpasswd", "..%5C..%5Cwindows%5Csystem32", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
    const res = await fetch(`${baseUrl}/v1/jobs/${traversal}`, { headers: AUTH });
    assert.equal(res.status, 404, `traversal-shaped id ${traversal} must 404, not crash or leak filesystem content`);
    const body = await res.json();
    assert.equal(body.error.code, "JOB_NOT_FOUND");
  }
});

test("no CORS headers are ever set, on any response, regardless of status or Origin header -- default-deny costs zero code", async () => {
  const { baseUrl } = await startServer();

  const responses = await Promise.all([
    fetch(`${baseUrl}/v1/metrics`, { headers: { Origin: "https://evil.example" } }), // 401, no token
    fetch(`${baseUrl}/v1/metrics`, { headers: { Origin: "https://evil.example", Authorization: `Bearer ${TOKEN}` } }), // 200
    fetch(`${baseUrl}/v1/nope`, { headers: { Origin: "https://evil.example", Authorization: `Bearer ${TOKEN}` } }), // 404
    fetch(`${baseUrl}/v1/metrics`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), // preflight-shaped, unauthenticated
  ]);

  for (const res of responses) {
    assert.equal(res.headers.get("access-control-allow-origin"), null, `${res.url} must never set Access-Control-Allow-Origin`);
    assert.equal(res.headers.get("access-control-allow-methods"), null);
    assert.equal(res.headers.get("access-control-allow-headers"), null);
  }
});

test("neither the real token nor a wrong attempted token ever appears in a log call across a full request cycle", async () => {
  const wrongToken = "attempted-wrong-token-value";
  const logCalls = [];
  const spyLogger = {
    info: (...a) => logCalls.push(a),
    warn: (...a) => logCalls.push(a),
    error: (...a) => logCalls.push(a),
    debug: (...a) => logCalls.push(a),
  };
  const config = { ...loadConfig({}), restHost: "127.0.0.1", restPort: 0, workspaceRoot: join(root, "log-leak") };
  const backend = createDelegationBackend({ config, logger: spyLogger, service: { invoke: () => new Promise(() => {}) } });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger: spyLogger, token: TOKEN, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const baseUrl = `http://127.0.0.1:${restServer.server.address().port}`;

  await fetch(`${baseUrl}/v1/metrics`, { headers: { Authorization: `Bearer ${wrongToken}` } });
  await fetch(`${baseUrl}/v1/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  const serialized = JSON.stringify(logCalls);
  assert.ok(!serialized.includes(TOKEN), "the real configured token must never appear in any log call");
  assert.ok(!serialized.includes(wrongToken), "an attempted wrong token must never appear in any log call either");
});

test("default bind address is 127.0.0.1, never 0.0.0.0 -- a network listener with no explicit opt-in must not be reachable beyond localhost", () => {
  const config = loadConfig({});
  assert.equal(config.restHost, "127.0.0.1");
  assert.notEqual(config.restHost, "0.0.0.0");
});

test("body-size limit applies regardless of authentication state -- cross-reference (full coverage in restBodySize.integration.test.js)", async () => {
  // A small configured limit + a small oversized body (not a multi-MB one) -- avoids a genuine
  // upload-in-progress vs. immediate-Connection:-close race on a large body over a real loopback
  // socket, which is a client-side artifact of the test, not a server defect (the dedicated
  // restBodySize.integration.test.js file already established this same pattern).
  const { baseUrl } = await startServer({ configOverrides: { restMaxBodyBytes: 256 } });
  const res = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Length": "2560" }, // no Authorization at all, 10x the 256-byte limit
    body: "x".repeat(2560),
  });
  assert.equal(res.status, 413, "an unauthenticated, oversized request must still be rejected on size, not on auth");
});
