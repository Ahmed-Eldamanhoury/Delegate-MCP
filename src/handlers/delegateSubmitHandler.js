import { submitDelegation } from "../services/delegationService.js";

/**
 * Creates a background job and returns immediately — never awaits completion. Poll with
 * delegate_status or delegate_history, cancel with delegate_cancel.
 * @param {{config: object, logger: object, jobManager: import("../services/jobManager.js").JobManager, service?: object}} deps
 */
export function createDelegateSubmitHandler({ config, logger, jobManager, service }) {
  return async function delegateSubmitHandler(input) {
    const jobId = submitDelegation({ input, config, jobManager, service, toolName: "delegate_submit" });
    const job = jobManager.getJob(jobId);

    logger.info("delegate_submit accepted", { jobId, model: input.model, status: job.status });

    const payload = { success: true, job_id: jobId, status: job.status };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  };
}
