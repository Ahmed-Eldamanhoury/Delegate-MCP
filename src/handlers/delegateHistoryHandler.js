/** @param {{delegationService: ReturnType<import("../services/delegationService.js").createDelegationService>}} deps */
export function createDelegateHistoryHandler({ delegationService }) {
  return async function delegateHistoryHandler({ limit, status }) {
    const summaries = delegationService.listJobs({ status, limit });

    const text = summaries.length
      ? summaries
          .map((j) => `${j.id}  [${j.status}]  model=${j.model ?? "?"}  cost=$${j.costUsd ?? "?"}`)
          .join("\n")
      : "No jobs recorded yet.";

    return { content: [{ type: "text", text }], structuredContent: { jobs: summaries } };
  };
}
