import { test } from "node:test";
import assert from "node:assert/strict";
import { createObservabilityRoutes } from "../src/rest/routes/observability.js";

// WP3 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2): createObservabilityRoutes({observabilityService})
// -> {handleReplay, handleTimeline, handleMetrics, handleSnapshot}. Each handler calls exactly one
// ObservabilityService method, no additional logic -- proven here with a fake/spy service, mirroring
// tests/handlerGaps.characterization.test.js's own handler-testing idiom.

function fakeObservabilityService(overrides = {}) {
  const calls = { replay: [], getTimeline: [], getMetrics: 0, getSnapshot: 0 };
  return {
    calls,
    replay: (jobId) => {
      calls.replay.push(jobId);
      return overrides.replay ?? { source: "runtime", timeline: [] };
    },
    getTimeline: (jobId, filter) => {
      calls.getTimeline.push({ jobId, filter });
      return overrides.getTimeline ?? [];
    },
    getMetrics: () => {
      calls.getMetrics += 1;
      return overrides.getMetrics ?? { queuedJobs: 0 };
    },
    getSnapshot: () => {
      calls.getSnapshot += 1;
      return overrides.getSnapshot ?? { takenAt: "2026-07-18T00:00:00.000Z", metrics: {}, activeJobs: [] };
    },
  };
}

test("handleReplay calls observabilityService.replay(id) verbatim and returns 200 with its result as the body, even when the timeline is empty (never 404 -- matches ADR-0007)", () => {
  const observabilityService = fakeObservabilityService({ replay: { source: "unavailable", timeline: [] } });
  const { handleReplay } = createObservabilityRoutes({ observabilityService });

  const result = handleReplay({ params: { id: "job-1" } });

  assert.deepEqual(observabilityService.calls.replay, ["job-1"]);
  assert.deepEqual(result, { status: 200, body: { source: "unavailable", timeline: [] } });
});

test("handleTimeline calls observabilityService.getTimeline(id, {type, since}) and returns 200 with the raw array as the body -- no source field, unlike replay", () => {
  const observabilityService = fakeObservabilityService({ getTimeline: [{ type: "JobCompleted" }] });
  const { handleTimeline } = createObservabilityRoutes({ observabilityService });
  const url = new URL("http://localhost/v1/jobs/job-1/timeline?type=JobCompleted&since=2026-01-01T00:00:00.000Z");

  const result = handleTimeline({ params: { id: "job-1" }, url });

  assert.deepEqual(observabilityService.calls.getTimeline, [
    { jobId: "job-1", filter: { type: "JobCompleted", since: "2026-01-01T00:00:00.000Z" } },
  ]);
  assert.deepEqual(result, { status: 200, body: [{ type: "JobCompleted" }] });
});

test("handleTimeline with no query params passes {type: undefined, since: undefined} through", () => {
  const observabilityService = fakeObservabilityService();
  const { handleTimeline } = createObservabilityRoutes({ observabilityService });
  const url = new URL("http://localhost/v1/jobs/job-1/timeline");

  handleTimeline({ params: { id: "job-1" }, url });

  assert.deepEqual(observabilityService.calls.getTimeline, [{ jobId: "job-1", filter: { type: undefined, since: undefined } }]);
});

test("handleTimeline propagates InvalidQueryParamError for an unrecognized type -- restServer.js's own error mapping decides the status code, not this handler", () => {
  const observabilityService = fakeObservabilityService();
  const { handleTimeline } = createObservabilityRoutes({ observabilityService });
  const url = new URL("http://localhost/v1/jobs/job-1/timeline?type=NotReal");

  assert.throws(() => handleTimeline({ params: { id: "job-1" }, url }));
  assert.deepEqual(observabilityService.calls.getTimeline, [], "must not call the service with an invalid filter");
});

test("handleMetrics calls observabilityService.getMetrics() with no arguments and returns it verbatim as the body", () => {
  const metrics = { queuedJobs: 3, runningJobs: 1 };
  const observabilityService = fakeObservabilityService({ getMetrics: metrics });
  const { handleMetrics } = createObservabilityRoutes({ observabilityService });

  const result = handleMetrics({});

  assert.equal(observabilityService.calls.getMetrics, 1);
  assert.deepEqual(result, { status: 200, body: metrics });
});

test("handleSnapshot calls observabilityService.getSnapshot() with no arguments and returns it verbatim as the body", () => {
  const snapshot = { takenAt: "2026-07-18T00:00:00.000Z", metrics: {}, activeJobs: [] };
  const observabilityService = fakeObservabilityService({ getSnapshot: snapshot });
  const { handleSnapshot } = createObservabilityRoutes({ observabilityService });

  const result = handleSnapshot({});

  assert.equal(observabilityService.calls.getSnapshot, 1);
  assert.deepEqual(result, { status: 200, body: snapshot });
});
