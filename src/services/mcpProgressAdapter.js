import { EVENT_TYPES } from "../models/runtimeEvent.js";

// OutputChunk is deliberately excluded — too high-frequency for a protocol notification
// channel (ADR-0002 Risk assessment: "High-frequency OutputChunk floods subscribers").
// A consumer that wants raw output should subscribe to the bus directly instead.
const FORWARDED_TYPES = [
  EVENT_TYPES.JOB_STATE_CHANGED,
  EVENT_TYPES.JOB_PROGRESS,
  EVENT_TYPES.JOB_COMPLETED,
  EVENT_TYPES.JOB_FAILED,
  EVENT_TYPES.JOB_CANCELLED,
];

function describeEvent(event) {
  switch (event.type) {
    case EVENT_TYPES.JOB_STATE_CHANGED:
      return `Job ${event.payload.to}`;
    case EVENT_TYPES.JOB_PROGRESS:
      return event.payload.progressMessage ?? "Progress update";
    case EVENT_TYPES.JOB_COMPLETED:
      return "Job completed";
    case EVENT_TYPES.JOB_FAILED:
      return `Job failed: ${event.payload.error ?? "unknown error"}`;
    case EVENT_TYPES.JOB_CANCELLED:
      return "Job cancelled";
    default:
      return event.type;
  }
}

/**
 * Forwards a job's lifecycle events as MCP `notifications/progress` for as long as the
 * request that submitted it is still open (ADR-0002 Phase 5) — only meaningful for
 * `delegate_task`, which blocks. `delegate_submit` has already returned its tool result by
 * the time anything interesting happens, so there is no open connection to push into; that's
 * a protocol constraint (`notifications/progress` is scoped to one request's
 * `progressToken`), not a design choice — see ADR-0002's Streaming strategy comparison.
 * @param {{bus: object, jobId: string, progressToken: string|number, sendNotification: (n: object) => Promise<void>, logger?: object}} args
 * @returns {() => void} unsubscribe-all
 */
export function forwardJobProgressToMcp({ bus, jobId, progressToken, sendNotification, logger }) {
  let progress = 0;
  const unsubscribers = FORWARDED_TYPES.map((type) =>
    bus.subscribe(type, (event) => {
      if (event.jobId !== jobId) return;
      progress += 1;
      sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message: describeEvent(event) },
      }).catch((err) => {
        // A client disconnect or transport error here must never affect the job itself.
        logger?.warn?.("mcpProgressAdapter: sendNotification failed", { jobId, message: err.message });
      });
    })
  );
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
