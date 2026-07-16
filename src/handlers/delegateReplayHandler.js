/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateReplayHandler({ observabilityService }) {
  return async function delegateReplayHandler({ job_id }) {
    const { source, timeline } = observabilityService.replay(job_id);
    const text =
      timeline.length === 0
        ? `No replay data available for job ${job_id} (source: ${source}).`
        : `Replay for ${job_id} (source: ${source}, ${timeline.length} event${timeline.length === 1 ? "" : "s"}):\n` +
          timeline.map((e) => `  [${e.timestamp}] ${e.type}${e.synthetic ? " (synthetic)" : ""}`).join("\n");
    return { content: [{ type: "text", text }], structuredContent: { source, timeline } };
  };
}
