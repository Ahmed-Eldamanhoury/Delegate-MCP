import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createJobRoutes } from "../src/rest/routes/jobs.js";
import { MalformedBodyError } from "../src/rest/errors.js";

// WP4 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2, ADR-0011 Cancellation/Async jobs):
// createJobRoutes({delegationService}) -> {handleSubmit, handleGetJob, handleListJobs,
// handleCancelJob}. Each calls exactly one DelegationService method (handleCancelJob calls
// getJob twice + cancelJob once, per the ADR's own before/cancel/after pseudocode).

function fakeReqWithBody(bodyString) {
  const req = new PassThrough();
  req.socket = { destroyed: false, destroy() { this.destroyed = true; } };
  process.nextTick(() => req.end(bodyString));
  return req;
}

function fakeDelegationService(overrides = {}) {
  const calls = { submit: [], getJob: [], listJobs: [], cancelJob: [] };
  return {
    calls,
    submit: (input, tool) => {
      calls.submit.push({ input, tool });
      if (overrides.submitThrows) throw overrides.submitThrows;
      return overrides.jobId ?? "new-job-id";
    },
    getJob: (id) => {
      calls.getJob.push(id);
      const sequence = overrides.getJobSequence ?? [overrides.getJob];
      return sequence[calls.getJob.length - 1] ?? sequence[sequence.length - 1];
    },
    listJobs: (opts) => {
      calls.listJobs.push(opts);
      return overrides.listJobs ?? [];
    },
    cancelJob: (id) => {
      calls.cancelJob.push(id);
      return overrides.cancelJob ?? false;
    },
  };
}

// --- handleSubmit ---

test("handleSubmit parses the JSON body, calls submit(body, 'rest'), then getJob(jobId), and returns 202 + Location + {job_id, status}", async () => {
  const delegationService = fakeDelegationService({
    jobId: "job-42",
    getJob: { id: "job-42", status: "queued" },
  });
  const { handleSubmit } = createJobRoutes({ delegationService });
  const req = fakeReqWithBody(JSON.stringify({ prompt: "say hi" }));

  const result = await handleSubmit({ req, config: { restMaxBodyBytes: 1024 } });

  assert.deepEqual(delegationService.calls.submit, [{ input: { prompt: "say hi" }, tool: "rest" }]);
  assert.deepEqual(delegationService.calls.getJob, ["job-42"]);
  assert.equal(result.status, 202);
  assert.deepEqual(result.headers, { Location: "/v1/jobs/job-42" });
  assert.deepEqual(result.body, { job_id: "job-42", status: "queued" });
});

test("handleSubmit throws MalformedBodyError for a body that isn't valid JSON -- restServer.js's error mapping decides the status code", async () => {
  const delegationService = fakeDelegationService();
  const { handleSubmit } = createJobRoutes({ delegationService });
  const req = fakeReqWithBody("not json");

  await assert.rejects(
    handleSubmit({ req, config: { restMaxBodyBytes: 1024 } }),
    MalformedBodyError
  );
  assert.deepEqual(delegationService.calls.submit, [], "must not call submit() with an unparseable body");
});

test("handleSubmit lets a ZodError from submit() propagate uncaught -- delegationService.submit()'s own DelegateTaskInputSchema.parse() is the only validation layer", async () => {
  const zodError = new z.ZodError([]);
  const delegationService = fakeDelegationService({ submitThrows: zodError });
  const { handleSubmit } = createJobRoutes({ delegationService });
  const req = fakeReqWithBody(JSON.stringify({}));

  await assert.rejects(handleSubmit({ req, config: { restMaxBodyBytes: 1024 } }), (err) => err === zodError);
});

// --- handleGetJob ---

test("handleGetJob calls getJob(id) and returns 200 with the JobView verbatim when found, no Retry-After for a terminal status", () => {
  const job = { id: "job-1", status: "completed" };
  const delegationService = fakeDelegationService({ getJob: job });
  const { handleGetJob } = createJobRoutes({ delegationService });

  const result = handleGetJob({ params: { id: "job-1" } });

  assert.deepEqual(delegationService.calls.getJob, ["job-1"]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, job);
  assert.equal(result.headers, undefined);
});

test("handleGetJob attaches Retry-After: 2 when the job's status is non-terminal", () => {
  const job = { id: "job-1", status: "running" };
  const delegationService = fakeDelegationService({ getJob: job });
  const { handleGetJob } = createJobRoutes({ delegationService });

  const result = handleGetJob({ params: { id: "job-1" } });

  assert.deepEqual(result.headers, { "Retry-After": "2" });
});

test("handleGetJob returns 404 JOB_NOT_FOUND when getJob() returns undefined (unknown or malformed id, indistinguishable)", () => {
  const delegationService = fakeDelegationService({ getJob: undefined });
  const { handleGetJob } = createJobRoutes({ delegationService });

  const result = handleGetJob({ params: { id: "does-not-exist" } });

  assert.deepEqual(result, { status: 404, body: { error: { code: "JOB_NOT_FOUND", message: "No job found with id does-not-exist" } } });
});

// --- handleListJobs ---

test("handleListJobs calls listJobs({status, limit}) and wraps the result as {jobs, count, limit}", () => {
  const jobs = [{ id: "a" }, { id: "b" }];
  const delegationService = fakeDelegationService({ listJobs: jobs });
  const { handleListJobs } = createJobRoutes({ delegationService });
  const url = new URL("http://localhost/v1/jobs?status=completed&limit=5");

  const result = handleListJobs({ url });

  assert.deepEqual(delegationService.calls.listJobs, [{ status: "completed", limit: 5 }]);
  assert.deepEqual(result, { status: 200, body: { jobs, count: 2, limit: 5 } });
});

test("handleListJobs with no query params defaults the reported limit to 20, matching listJobs()'s own default", () => {
  const delegationService = fakeDelegationService({ listJobs: [] });
  const { handleListJobs } = createJobRoutes({ delegationService });
  const url = new URL("http://localhost/v1/jobs");

  const result = handleListJobs({ url });

  assert.deepEqual(delegationService.calls.listJobs, [{ status: undefined, limit: undefined }]);
  assert.deepEqual(result.body, { jobs: [], count: 0, limit: 20 });
});

// --- handleCancelJob: the exact before/cancel/after branching from ADR-0011's Cancellation pseudocode ---

test("handleCancelJob returns 404 JOB_NOT_FOUND when the job doesn't exist at all (before check)", () => {
  const delegationService = fakeDelegationService({ getJobSequence: [undefined] });
  const { handleCancelJob } = createJobRoutes({ delegationService });

  const result = handleCancelJob({ params: { id: "unknown" } });

  assert.deepEqual(result, { status: 404, body: { error: { code: "JOB_NOT_FOUND", message: "No job found with id unknown" } } });
  assert.deepEqual(delegationService.calls.cancelJob, [], "must not call cancelJob() when the job doesn't exist");
});

test("handleCancelJob returns 200 with the job's new status when cancelJob() succeeds", () => {
  const delegationService = fakeDelegationService({
    getJobSequence: [{ id: "job-1", status: "queued" }, { id: "job-1", status: "cancelled" }],
    cancelJob: true,
  });
  const { handleCancelJob } = createJobRoutes({ delegationService });

  const result = handleCancelJob({ params: { id: "job-1" } });

  assert.deepEqual(delegationService.calls.getJob, ["job-1", "job-1"]);
  assert.deepEqual(delegationService.calls.cancelJob, ["job-1"]);
  assert.deepEqual(result, { status: 200, body: { job_id: "job-1", status: "cancelled" } });
});

test("handleCancelJob returns 200 (idempotent) for a repeat DELETE on an already-cancelled job -- REST's disclosed divergence from MCP", () => {
  const delegationService = fakeDelegationService({
    getJobSequence: [{ id: "job-1", status: "cancelled" }, { id: "job-1", status: "cancelled" }],
    cancelJob: false,
  });
  const { handleCancelJob } = createJobRoutes({ delegationService });

  const result = handleCancelJob({ params: { id: "job-1" } });

  assert.deepEqual(result, { status: 200, body: { job_id: "job-1", status: "cancelled" } });
});

test("handleCancelJob returns 409 JOB_NOT_CANCELLABLE for a genuinely terminal job (completed/failed)", () => {
  const delegationService = fakeDelegationService({
    getJobSequence: [{ id: "job-1", status: "completed" }, { id: "job-1", status: "completed" }],
    cancelJob: false,
  });
  const { handleCancelJob } = createJobRoutes({ delegationService });

  const result = handleCancelJob({ params: { id: "job-1" } });

  assert.deepEqual(result, { status: 409, body: { error: { code: "JOB_NOT_CANCELLABLE", message: "Job job-1 could not be cancelled (status: completed)." } } });
});
