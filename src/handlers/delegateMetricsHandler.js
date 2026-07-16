/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateMetricsHandler({ observabilityService }) {
  return async function delegateMetricsHandler() {
    const metrics = observabilityService.getMetrics();
    return { content: [{ type: "text", text: JSON.stringify(metrics) }], structuredContent: metrics };
  };
}
