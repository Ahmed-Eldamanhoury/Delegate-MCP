import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJobIdParam,
  parseListQuery,
  parseTimelineQuery,
  MAX_LIST_LIMIT,
  InvalidQueryParamError,
} from "../src/rest/parsing.js";

// WP1 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §2/§8): pure parsing of path + query params.
// parseJobIdParam performs NO validation -- job-id-shape validation lives entirely in
// DelegationService's isValidJobId() guard (§5), so a malformed :id reaches the service layer
// exactly like an unknown one and gets 404 JOB_NOT_FOUND, never a 400 here.

test("parseJobIdParam returns the raw path segment unchanged, no validation of any kind", () => {
  for (const raw of ["", "not-a-uuid", "../../etc/passwd", "00000000-0000-0000-0000-000000000000"]) {
    assert.equal(parseJobIdParam(raw), raw);
  }
});

test("MAX_LIST_LIMIT is 500, tied to the store's own existing DEFAULT_MAX_JOB_HISTORY cap", () => {
  assert.equal(MAX_LIST_LIMIT, 500);
});

test("parseListQuery with no params returns {status: undefined, limit: undefined} -- lets listJobs()'s own default (20) apply", () => {
  assert.deepEqual(parseListQuery(new URLSearchParams("")), { status: undefined, limit: undefined });
});

test("parseListQuery accepts a valid status and a valid positive-integer limit", () => {
  assert.deepEqual(parseListQuery(new URLSearchParams("status=completed&limit=5")), {
    status: "completed",
    limit: 5,
  });
});

test("parseListQuery rejects an unrecognized status value", () => {
  assert.throws(() => parseListQuery(new URLSearchParams("status=bogus")), InvalidQueryParamError);
});

test("parseListQuery rejects a non-numeric limit", () => {
  assert.throws(() => parseListQuery(new URLSearchParams("limit=abc")), InvalidQueryParamError);
});

test("parseListQuery rejects a zero or negative limit", () => {
  assert.throws(() => parseListQuery(new URLSearchParams("limit=0")), InvalidQueryParamError);
  assert.throws(() => parseListQuery(new URLSearchParams("limit=-5")), InvalidQueryParamError);
});

test("parseListQuery clamps a limit above MAX_LIST_LIMIT down to MAX_LIST_LIMIT, rather than rejecting it -- listJobs() can never usefully return more anyway", () => {
  assert.deepEqual(parseListQuery(new URLSearchParams("limit=999999")), { status: undefined, limit: 500 });
});

test("parseTimelineQuery with no params returns {type: undefined, since: undefined}", () => {
  assert.deepEqual(parseTimelineQuery(new URLSearchParams("")), { type: undefined, since: undefined });
});

test("parseTimelineQuery accepts a recognized EVENT_TYPES value and passes since through unchanged", () => {
  assert.deepEqual(parseTimelineQuery(new URLSearchParams("type=JobCompleted&since=2026-07-18T00:00:00.000Z")), {
    type: "JobCompleted",
    since: "2026-07-18T00:00:00.000Z",
  });
});

test("parseTimelineQuery rejects an unrecognized type value", () => {
  assert.throws(() => parseTimelineQuery(new URLSearchParams("type=NotARealEventType")), InvalidQueryParamError);
});
