import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRestServer } from "../src/rest/restServer.js";
import { loadConfig } from "../src/config/index.js";

// WP2 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §2/§8): createRestServer({backend, config, logger,
// token, routes}) owns the raw http.Server, an inline route table (empty by default -- zero real
// routes exist until WP3/WP4), and the request pipeline: body-size Content-Length gate -> auth
// check -> route match -> handler -> error mapping -> response. Every server started here binds
// an ephemeral port (0) to avoid colliding with config.restPort's real default (8787) or other
// test runs.

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "test-token-" + "a".repeat(32);

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

function baseConfig(overrides = {}) {
  return { ...loadConfig({}), restHost: "127.0.0.1", restPort: 0, restMaxBodyBytes: 1024, ...overrides };
}

async function start({ config = baseConfig(), routes = [], token = TOKEN } = {}) {
  const restServer = createRestServer({ backend: {}, config, logger, token, routes });
  started.push(restServer);
  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  const { port } = restServer.server.address();
  return { restServer, baseUrl: `http://127.0.0.1:${port}` };
}

test("loadConfig defaults restHost to 127.0.0.1 (never 0.0.0.0) and restPort to 8787", () => {
  const config = loadConfig({});
  assert.equal(config.restHost, "127.0.0.1");
  assert.notEqual(config.restHost, "0.0.0.0");
  assert.equal(config.restPort, 8787);
});

test("the server actually binds the host passed in config, not some other default", async () => {
  const { restServer } = await start();
  assert.equal(restServer.server.address().address, "127.0.0.1");
});

test("returns 401 UNAUTHORIZED when the Authorization header is missing", async () => {
  const { baseUrl } = await start();
  const res = await fetch(`${baseUrl}/v1/anything`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("returns 401 UNAUTHORIZED when the token is wrong", async () => {
  const { baseUrl } = await start();
  const res = await fetch(`${baseUrl}/v1/anything`, { headers: { Authorization: "Bearer wrong-token" } });
  assert.equal(res.status, 401);
});

test("returns 413 PAYLOAD_TOO_LARGE for an oversized Content-Length body, before any route logic runs -- even for a path that doesn't exist and without a valid token", async () => {
  const { baseUrl } = await start({ config: baseConfig({ restMaxBodyBytes: 10 }) });
  const res = await fetch(`${baseUrl}/v1/does-not-exist`, {
    method: "POST",
    headers: { "Content-Length": "2048" },
    body: "x".repeat(2048),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
});

test("returns 404 for an unmatched route once auth and body-size both pass", async () => {
  const { baseUrl } = await start();
  const res = await fetch(`${baseUrl}/v1/nope`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
});

test("a registered stub route is reached end-to-end: auth passes, route matches, handler's response is sent verbatim", async () => {
  const routes = [
    {
      method: "GET",
      path: "/v1/stub",
      handler: () => ({ status: 200, body: { ok: true } }),
    },
  ];
  const { baseUrl } = await start({ routes });

  const res = await fetch(`${baseUrl}/v1/stub`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("a route handler's result.headers are sent verbatim alongside the JSON response -- WP4 needs this for Location/Retry-After", async () => {
  const routes = [
    {
      method: "POST",
      path: "/v1/stub-with-headers",
      handler: () => ({ status: 202, headers: { Location: "/v1/jobs/abc-123" }, body: { job_id: "abc-123" } }),
    },
  ];
  const { baseUrl } = await start({ routes });

  const res = await fetch(`${baseUrl}/v1/stub-with-headers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("location"), "/v1/jobs/abc-123");
  assert.deepEqual(await res.json(), { job_id: "abc-123" });
});

test("a route handler that throws is mapped to a safe 500 via toHttpError -- never leaks the error message over the wire", async () => {
  const routes = [
    {
      method: "GET",
      path: "/v1/boom",
      handler: () => {
        throw new Error("secret internal detail");
      },
    },
  ];
  const { baseUrl } = await start({ routes });

  const res = await fetch(`${baseUrl}/v1/boom`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(body).includes("secret internal detail"));
});

test("a handler result that fails JSON.stringify (e.g. a circular reference) is still mapped to a clean 500 -- not a headers-already-sent crash", async () => {
  const circular = {};
  circular.self = circular;
  const routes = [
    {
      method: "GET",
      path: "/v1/circular",
      handler: () => ({ status: 200, body: circular }),
    },
  ];
  const { baseUrl } = await start({ routes });

  const res = await fetch(`${baseUrl}/v1/circular`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
});

test("close() stops the server from accepting new connections", async () => {
  const { restServer, baseUrl } = await start();
  await restServer.close();

  await assert.rejects(fetch(baseUrl, { headers: { Authorization: `Bearer ${TOKEN}` } }));
});
