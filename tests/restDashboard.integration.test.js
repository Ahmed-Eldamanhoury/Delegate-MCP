import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDelegationBackend } from "../src/services/delegationBackend.js";
import { createRestServer } from "../src/rest/restServer.js";
import { buildRouteTable } from "../src/cli/restEntry.js";
import { loadConfig } from "../src/config/index.js";

// ADR-0012 WP0: dashboard static-file hosting, pre-auth routing, config stub generation.
// All GET /dashboard/* requests must be served BEFORE the auth gate (intentionally unauthenticated).
// GET /dashboard/config.js is generated dynamically; all other paths are served from dashboardDir.

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const TOKEN = "dashboard-integration-test-token-" + "a".repeat(16);

const root = mkdtempSync(join(tmpdir(), "claude-delegate-dashboard-"));
after(() => rmSync(root, { recursive: true, force: true }));

const started = [];
after(async () => {
  await Promise.all(started.map((s) => s.close()));
});

function startServer({ dashboardDir, configOverrides = {} } = {}) {
  const dir = dashboardDir ?? join(root, "dist");
  const config = {
    ...loadConfig({}),
    restHost: "127.0.0.1",
    restPort: 0,
    workspaceRoot: join(root, "workspace"),
    dashboardDir: dir,
    ...configOverrides,
  };
  const backend = createDelegationBackend({ config, logger, service: { invoke: () => new Promise(() => {}) } });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token: TOKEN, routes });
  started.push(restServer);
  return new Promise((resolve) => {
    restServer.server.listen(config.restPort, config.restHost, () => {
      const { port } = restServer.server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, config, restServer });
    });
  });
}

// --- config.js generation ---

test("GET /dashboard/config.js returns 200 and Content-Type: application/javascript", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/dashboard/config.js`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/javascript"), "must be JavaScript");
});

test("GET /dashboard/config.js contains window.__DELEGATE_REST__ pointing at the configured host and port", async () => {
  const { baseUrl, config } = await startServer();
  const text = await fetch(`${baseUrl}/dashboard/config.js`).then((r) => r.text());
  assert.ok(text.includes("window.__DELEGATE_REST__"), "must export the sentinel variable");
  assert.ok(text.includes(config.restHost), "must embed restHost");
  assert.ok(text.includes(String(config.restPort)), "must embed restPort");
});

test("GET /dashboard/config.js has Cache-Control: no-cache so the SPA always gets fresh config on reload", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/dashboard/config.js`);
  assert.ok(res.headers.get("cache-control")?.includes("no-cache"), "config.js must not be cached");
});

// --- pre-auth: dashboard routes bypass bearer token gate ---

test("GET /dashboard/config.js is served WITHOUT an Authorization header -- intentionally pre-auth", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/dashboard/config.js`); // no Authorization header
  assert.equal(res.status, 200, "config.js must be accessible without a token");
});

test("GET /dashboard/config.js is served even with a WRONG Authorization header -- pre-auth means auth is irrelevant", async () => {
  const { baseUrl } = await startServer();
  const res = await fetch(`${baseUrl}/dashboard/config.js`, {
    headers: { Authorization: "Bearer completely-wrong-token" },
  });
  assert.equal(res.status, 200, "wrong token must not block pre-auth dashboard routes");
});

test("auth gate remains intact for REST API routes -- GET /v1/metrics still requires a valid token", async () => {
  const { baseUrl } = await startServer();
  const noAuth = await fetch(`${baseUrl}/v1/metrics`);
  assert.equal(noAuth.status, 401, "REST API routes must still require auth");
  const wrongAuth = await fetch(`${baseUrl}/v1/metrics`, {
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(wrongAuth.status, 401, "wrong token must still be rejected on REST API routes");
});

// --- static file serving ---

test("GET /dashboard/index.html serves the file with text/html when dashboardDir contains one", async () => {
  const distDir = join(root, "dist-with-files");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<!doctype html><html></html>");

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/index.html`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));
  assert.ok((await res.text()).includes("<!doctype html>"));
});

test("GET /dashboard (no slash) serves index.html from dashboardDir", async () => {
  const distDir = join(root, "dist-root");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>Dashboard</title>");

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" });
  // Either 200 (directly served) or 3xx redirect to /dashboard/ -- either is acceptable
  assert.ok(res.status === 200 || (res.status >= 300 && res.status < 400), "must serve index.html or redirect");
});

test("GET /dashboard/ (trailing slash) serves index.html from dashboardDir", async () => {
  const distDir = join(root, "dist-slash");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<title>ok</title>");

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("<title>ok</title>"));
});

test("GET /dashboard/assets/main.js serves a JS file with correct MIME type", async () => {
  const distDir = join(root, "dist-assets");
  mkdirSync(join(distDir, "assets"), { recursive: true });
  writeFileSync(join(distDir, "assets", "main.js"), 'console.log("hi")');

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/assets/main.js`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("application/javascript"));
});

test("GET /dashboard/styles.css serves with text/css", async () => {
  const distDir = join(root, "dist-css");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "styles.css"), "body { margin: 0 }");

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/styles.css`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/css"));
});

// --- 404 cases ---

test("GET /dashboard/nonexistent.js returns 404 when file is missing from dashboardDir", async () => {
  const distDir = join(root, "dist-empty");
  mkdirSync(distDir, { recursive: true });

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/nonexistent.js`);
  assert.equal(res.status, 404);
});

test("GET /dashboard/ returns 404 when dashboardDir has no index.html (dashboard not built yet -- graceful)", async () => {
  const distDir = join(root, "dist-no-index");
  mkdirSync(distDir, { recursive: true }); // exists but empty

  const { baseUrl } = await startServer({ dashboardDir: distDir });
  const res = await fetch(`${baseUrl}/dashboard/`);
  assert.equal(res.status, 404, "missing index.html must produce 404, not a crash");
});

test("GET /dashboard/index.html returns 404 when dashboardDir does not exist at all", async () => {
  const { baseUrl } = await startServer({ dashboardDir: join(root, "nonexistent-dist") });
  const res = await fetch(`${baseUrl}/dashboard/index.html`);
  assert.equal(res.status, 404, "missing dashboardDir must produce 404, not a crash");
});

// --- path traversal ---

test("path traversal attempt via URL-encoded segments is blocked -- returns 404, never leaks filesystem content", async () => {
  const { baseUrl } = await startServer();
  // URL normalization converts these to paths outside /dashboard/* before routing;
  // the server must never serve them regardless.
  const attempts = [
    // After URL normalization these become paths outside /dashboard:
    `${baseUrl}/dashboard/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    `${baseUrl}/dashboard/%2e%2e%5c%2e%2e%5cwindows%5csystem32`,
  ];
  for (const url of attempts) {
    const res = await fetch(url);
    // Either routed away from the dashboard handler (not-found on REST routes) or
    // caught inside serveDashboard with a 404 -- never a 200 with file content.
    assert.notEqual(res.status, 200, `traversal attempt ${url} must not return 200`);
    const ct = res.headers.get("content-type") ?? "";
    assert.ok(ct.includes("application/json"), "traversal response must be JSON, never raw file bytes");
  }
});
