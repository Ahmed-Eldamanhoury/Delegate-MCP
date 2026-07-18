import { parseTimelineQuery } from "../parsing.js";

/**
 * Read-only ObservabilityService routes (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2, WP3).
 * Each handler calls exactly one ObservabilityService method, no additional logic.
 * @param {{observabilityService: import("../../services/observabilityService.js").ObservabilityService}} deps
 */
export function createObservabilityRoutes({ observabilityService }) {
  return {
    /** GET /v1/jobs/:id/replay -- 200 always, even source:"unavailable" (never 404, ADR-0007). */
    handleReplay({ params }) {
      return { status: 200, body: observabilityService.replay(params.id) };
    },

    /** GET /v1/jobs/:id/timeline?type=&since= -- raw array body, no source field, unlike replay. */
    handleTimeline({ params, url }) {
      const { type, since } = parseTimelineQuery(url.searchParams);
      return { status: 200, body: observabilityService.getTimeline(params.id, { type, since }) };
    },

    /** GET /v1/metrics */
    handleMetrics() {
      return { status: 200, body: observabilityService.getMetrics() };
    },

    /** GET /v1/snapshot */
    handleSnapshot() {
      return { status: 200, body: observabilityService.getSnapshot() };
    },
  };
}
