/**
 * Creates a background job and returns immediately — never awaits completion. Poll with
 * delegate_status or delegate_history, cancel with delegate_cancel.
 * @param {{logger: object, delegationService: ReturnType<import("../services/delegationService.js").createDelegationService>}} deps
 */
export function createDelegateSubmitHandler({ logger, delegationService }) {
  return async function delegateSubmitHandler(input) {
    const jobId = delegationService.submit(input, "delegate_submit");
    const job = delegationService.getJob(jobId);

    logger.info("delegate_submit accepted", { jobId, model: input.model, status: job.status });

    const payload = { success: true, job_id: jobId, status: job.status };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  };
}
