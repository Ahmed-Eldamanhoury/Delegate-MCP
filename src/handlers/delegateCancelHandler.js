import { toJobView } from "../models/job.js";

/** @param {{jobManager: import("../services/jobManager.js").JobManager}} deps */
export function createDelegateCancelHandler({ jobManager }) {
  return async function delegateCancelHandler({ job_id }) {
    const before = jobManager.getJob(job_id);
    if (!before) {
      return { isError: true, content: [{ type: "text", text: `No job found with id ${job_id}` }] };
    }

    const cancelled = jobManager.cancelJob(job_id);
    const after = toJobView(jobManager.getJob(job_id));

    if (!cancelled) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Job ${job_id} could not be cancelled (status: ${after.status}).` },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: `Job ${job_id} cancellation requested (status: ${after.status}).` },
      ],
      structuredContent: after,
    };
  };
}
