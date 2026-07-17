/** @param {{delegationService: ReturnType<import("../services/delegationService.js").createDelegationService>}} deps */
export function createDelegateCancelHandler({ delegationService }) {
  return async function delegateCancelHandler({ job_id }) {
    const before = delegationService.getJob(job_id);
    if (!before) {
      return { isError: true, content: [{ type: "text", text: `No job found with id ${job_id}` }] };
    }

    const cancelled = delegationService.cancelJob(job_id);
    const after = delegationService.getJob(job_id);

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
