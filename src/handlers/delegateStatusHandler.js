/** @param {{delegationService: import("../services/delegationService.js").createDelegationService}} deps */
export function createDelegateStatusHandler({ delegationService }) {
  return async function delegateStatusHandler({ job_id }) {
    const view = delegationService.getJob(job_id);
    if (!view) {
      return { isError: true, content: [{ type: "text", text: `No job found with id ${job_id}` }] };
    }

    const cost = view.result?.parsed?.total_cost_usd;
    const summary =
      `[${view.status}] model=${view.metadata?.model ?? "?"} ` +
      `phase=${view.phase} runtime=${view.runtimeMs ?? "?"}ms cost=$${cost ?? "?"}` +
      (view.error ? `\nerror: ${view.error}` : "");

    return { content: [{ type: "text", text: summary }], structuredContent: view };
  };
}
