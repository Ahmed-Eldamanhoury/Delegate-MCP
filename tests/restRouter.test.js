import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute } from "../src/rest/router.js";

// WP2 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §2): pure pattern match, no I/O.
// {status: "not-found"} or {handler, params}.

const TABLE = [
  { method: "GET", path: "/v1/jobs/:id", handler: "handleGetJob" },
  { method: "GET", path: "/v1/jobs", handler: "handleListJobs" },
  { method: "DELETE", path: "/v1/jobs/:id", handler: "handleCancelJob" },
];

test("matches an exact static path + method", () => {
  assert.deepEqual(matchRoute("GET", "/v1/jobs", TABLE), { handler: "handleListJobs", params: {} });
});

test("matches a :id-param path and extracts the param", () => {
  assert.deepEqual(matchRoute("GET", "/v1/jobs/abc-123", TABLE), {
    handler: "handleGetJob",
    params: { id: "abc-123" },
  });
});

test("distinguishes by HTTP method on the same path shape", () => {
  assert.deepEqual(matchRoute("DELETE", "/v1/jobs/abc-123", TABLE), {
    handler: "handleCancelJob",
    params: { id: "abc-123" },
  });
});

test("returns {status: 'not-found'} for an unregistered path", () => {
  assert.deepEqual(matchRoute("GET", "/v1/nope", TABLE), { status: "not-found" });
});

test("returns {status: 'not-found'} for a registered path with the wrong method", () => {
  assert.deepEqual(matchRoute("POST", "/v1/jobs", TABLE), { status: "not-found" });
});

test("returns {status: 'not-found'} for an empty route table", () => {
  assert.deepEqual(matchRoute("GET", "/v1/jobs", []), { status: "not-found" });
});

test("a :id segment never matches an extra trailing path segment", () => {
  assert.deepEqual(matchRoute("GET", "/v1/jobs/abc-123/extra", TABLE), { status: "not-found" });
});
