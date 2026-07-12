import { summarizeJob } from "../models/job.js";

/** @param {{jobManager: import("../services/jobManager.js").JobManager}} deps */
export function createDelegateHistoryHandler({ jobManager }) {
  return async function delegateHistoryHandler({ limit, status }) {
    let jobs = jobManager.listJobs();
    if (status) jobs = jobs.filter((job) => job.status === status);

    // store preserves insertion (chronological) order; take the most recent `limit`.
    const summaries = jobs.slice(-limit).reverse().map(summarizeJob);

    const text = summaries.length
      ? summaries
          .map((j) => `${j.id}  [${j.status}]  model=${j.model ?? "?"}  cost=$${j.costUsd ?? "?"}`)
          .join("\n")
      : "No jobs recorded yet.";

    return { content: [{ type: "text", text }], structuredContent: { jobs: summaries } };
  };
}
