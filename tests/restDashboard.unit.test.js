import { test } from "node:test";
import assert from "node:assert/strict";
import { isDashboardRequest } from "../src/rest/dashboard.js";

// ADR-0012 WP0: isDashboardRequest() pure routing predicate — must catch every sub-path
// under /dashboard while never matching /v1/* or any other route.

test("isDashboardRequest: /dashboard (no trailing slash) is a dashboard request", () => {
  assert.equal(isDashboardRequest("/dashboard"), true);
});

test("isDashboardRequest: /dashboard/ (trailing slash) is a dashboard request", () => {
  assert.equal(isDashboardRequest("/dashboard/"), true);
});

test("isDashboardRequest: /dashboard/config.js is a dashboard request", () => {
  assert.equal(isDashboardRequest("/dashboard/config.js"), true);
});

test("isDashboardRequest: nested sub-path is a dashboard request", () => {
  assert.equal(isDashboardRequest("/dashboard/assets/main-abc123.js"), true);
});

test("isDashboardRequest: /v1/metrics is NOT a dashboard request", () => {
  assert.equal(isDashboardRequest("/v1/metrics"), false);
});

test("isDashboardRequest: / is NOT a dashboard request", () => {
  assert.equal(isDashboardRequest("/"), false);
});

test("isDashboardRequest: /dashboardx prefix match is NOT a dashboard request -- requires exact segment boundary", () => {
  assert.equal(isDashboardRequest("/dashboardx"), false);
  assert.equal(isDashboardRequest("/dashboards/foo"), false);
});

test("isDashboardRequest: /v1/jobs is NOT a dashboard request", () => {
  assert.equal(isDashboardRequest("/v1/jobs"), false);
});
