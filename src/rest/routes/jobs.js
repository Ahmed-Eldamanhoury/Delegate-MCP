import { streamBoundedBody } from "../bodyLimit.js";
import { MalformedBodyError } from "../errors.js";
import { parseListQuery } from "../parsing.js";
import { TERMINAL_STATUSES } from "../../models/job.js";

/**
 * DelegationService-backed job routes (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2, WP4;
 * ADR-0011 Cancellation/Async jobs). Each handler calls exactly one `DelegationService` method
 * (`handleCancelJob` calls `getJob` twice + `cancelJob` once, following the ADR's own
 * before/cancel/after pseudocode verbatim -- this is a routing decision over an existing boolean,
 * not new business logic).
 * @param {{delegationService: ReturnType<import("../../services/delegationService.js").createDelegationService>}} deps
 */
export function createJobRoutes({ delegationService }) {
  return {
    /**
     * POST /v1/jobs -- 202 Accepted, Location: /v1/jobs/{job_id}, body {job_id, status}.
     * The ONE route that reads a request body: streamBoundedBody() is called here, scoped to
     * exactly the route that needs it -- every other route never attaches to the body stream at
     * all, so there is nothing to protect or tear down for them (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md
     * §8, refined during WP4 implementation from an earlier "universal guard" framing once a real
     * body-consuming route existed to reason about).
     */
    async handleSubmit({ req, config }) {
      const raw = await streamBoundedBody(req, config.restMaxBodyBytes);
      let input;
      try {
        input = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new MalformedBodyError("Request body is not valid JSON");
      }

      const jobId = delegationService.submit(input, "rest");
      const job = delegationService.getJob(jobId);

      return { status: 202, headers: { Location: `/v1/jobs/${jobId}` }, body: { job_id: jobId, status: job.status } };
    },

    /** GET /v1/jobs/:id -- 200 = JobView verbatim; 404 if undefined; Retry-After:2 while non-terminal. */
    handleGetJob({ params }) {
      const job = delegationService.getJob(params.id);
      if (!job) {
        return { status: 404, body: { error: { code: "JOB_NOT_FOUND", message: `No job found with id ${params.id}` } } };
      }
      const headers = TERMINAL_STATUSES.has(job.status) ? undefined : { "Retry-After": "2" };
      return { status: 200, headers, body: job };
    },

    /** GET /v1/jobs?status=&limit= -- 200 {jobs, count, limit}; no cursor in v1. */
    handleListJobs({ url }) {
      const { status, limit } = parseListQuery(url.searchParams);
      const jobs = delegationService.listJobs({ status, limit });
      return { status: 200, body: { jobs, count: jobs.length, limit: limit ?? 20 } };
    },

    /**
     * DELETE /v1/jobs/:id -- the exact before/cancel/after routing from ADR-0011's Cancellation
     * pseudocode. cancelJob() returns false for BOTH "unknown id" and "known-but-already-terminal";
     * before/after disambiguate. 200 for a genuinely idempotent repeat DELETE on an
     * already-cancelled job is REST's disclosed divergence from MCP's non-idempotent delegate_cancel.
     */
    handleCancelJob({ params }) {
      const before = delegationService.getJob(params.id);
      if (!before) {
        return { status: 404, body: { error: { code: "JOB_NOT_FOUND", message: `No job found with id ${params.id}` } } };
      }

      const cancelled = delegationService.cancelJob(params.id);
      const after = delegationService.getJob(params.id);

      if (cancelled) {
        return { status: 200, body: { job_id: params.id, status: after.status } };
      }
      if (after.status === "cancelled") {
        return { status: 200, body: { job_id: params.id, status: "cancelled" } };
      }
      return {
        status: 409,
        body: { error: { code: "JOB_NOT_CANCELLABLE", message: `Job ${params.id} could not be cancelled (status: ${after.status}).` } },
      };
    },
  };
}
