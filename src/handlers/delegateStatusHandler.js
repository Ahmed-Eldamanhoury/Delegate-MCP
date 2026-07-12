import { toJobView } from "../models/job.js";

/** @param {{jobManager: import("../services/jobManager.js").JobManager}} deps */
export function createDelegateStatusHandler({ jobManager }) {
  return async function delegateStatusHandler({ job_id }) {
    const job = jobManager.getJob(job_id);
    if (!job) {
      return { isError: true, content: [{ type: "text", text: `No job found with id ${job_id}` }] };
    }

    const view = toJobView(job);
    const cost = view.result?.parsed?.total_cost_usd;
    const summary =
      `[${view.status}] model=${view.metadata?.model ?? "?"} ` +
      `phase=${view.phase} runtime=${view.runtimeMs ?? "?"}ms cost=$${cost ?? "?"}` +
      (view.error ? `\nerror: ${view.error}` : "");

    return { content: [{ type: "text", text: summary }], structuredContent: view };
  };
}
