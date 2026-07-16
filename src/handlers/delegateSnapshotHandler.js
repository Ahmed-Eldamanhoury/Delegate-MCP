/** @param {{observabilityService: import("../services/observabilityService.js").ObservabilityService}} deps */
export function createDelegateSnapshotHandler({ observabilityService }) {
  return async function delegateSnapshotHandler() {
    const snapshot = observabilityService.getSnapshot();
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }], structuredContent: snapshot };
  };
}
