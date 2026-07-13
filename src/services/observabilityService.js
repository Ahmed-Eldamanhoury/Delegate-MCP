import { createMetricsCollector } from "./metricsCollector.js";
import { createTimelineStore } from "./timelineStore.js";

/**
 * The single gateway for *observation* consumers (Dashboard, plugins, future HTTP/MCP APIs) —
 * distinct from the execution-pipeline bus subscribers (workspaceEventBridge,
 * mcpProgressAdapter), which stay exactly as they are (ADR-0003).
 *
 * Passive Observation Rule: this service holds no reference to JobManager, claudeCliService,
 * or any bus.publish/mutator — its only interaction with RuntimeEventBus is one
 * bus.subscribeAll() call below, so there is nothing here that could cancel a job, execute a
 * command, or write to Workspace, even by accident.
 *
 * Phase 1 (this file): ObservabilityService + MetricsCollector + TimelineStore only.
 * ReplayEngine/SnapshotBuilder/ConsumerRegistry are ADR-0003 design, not yet implemented —
 * deliberately out of scope for this wave.
 *
 * @param {{bus: import("./runtimeEventBus.js").RuntimeEventBus, config?: import("../config/index.js").DelegateConfig, logger?: object, maxTimelineHistory?: number}} opts
 */
export function createObservabilityService({ bus, config, logger, maxTimelineHistory } = {}) {
  const metrics = createMetricsCollector({ config, logger });
  const timeline = createTimelineStore({ maxTimelineHistory });

  const unsubscribe = bus.subscribeAll((event) => {
    metrics.record(event);
    timeline.record(event);
  });

  /** @returns {ReturnType<typeof createMetricsCollector>["getMetrics"] extends () => infer R ? R : never} */
  function getMetrics() {
    return metrics.getMetrics();
  }

  /** @param {string} jobId @param {{type?: string, since?: string}} [filter] */
  function getTimeline(jobId, filter) {
    return timeline.getTimeline(jobId, filter);
  }

  /** Unsubscribes from RuntimeEventBus — called during the same graceful-shutdown path cli/entry.js already uses. */
  function close() {
    unsubscribe();
  }

  return Object.freeze({ getMetrics, getTimeline, close });
}
