import { createMetricsCollector } from "./metricsCollector.js";
import { createTimelineStore } from "./timelineStore.js";
import { createReplayEngine } from "./replayEngine.js";
import { createSnapshotBuilder } from "./snapshotBuilder.js";
import { createConsumerRegistry } from "./consumerRegistry.js";

/**
 * The single gateway for *observation* consumers (Dashboard, plugins, future HTTP/MCP APIs) —
 * distinct from the execution-pipeline bus subscribers (workspaceEventBridge,
 * mcpProgressAdapter), which stay exactly as they are (ADR-0003).
 *
 * Passive Observation Rule: this service holds no reference to JobManager, claudeCliService,
 * or any bus.publish/mutator — its only interaction with RuntimeEventBus is one
 * bus.subscribeAll() call below, so there is nothing here that could cancel a job, execute a
 * command, or write to Workspace, even by accident. ReplayEngine/SnapshotBuilder read from
 * MetricsCollector/TimelineStore/disk only; ConsumerRegistry is pure in-memory bookkeeping —
 * none of the Phase 2 additions touch JobManager/RuntimeEventBus/Workspace/ExecutionContext.
 *
 * Phase 1: ObservabilityService + MetricsCollector + TimelineStore.
 * Phase 2 (this file, ADR-0003 Migration plan step 2/3): ReplayEngine, SnapshotBuilder,
 * ConsumerRegistry. No Dashboard/REST API/plugin/new-MCP-tool consumes this yet.
 *
 * @param {{bus: import("./runtimeEventBus.js").RuntimeEventBus, config?: import("../config/index.js").DelegateConfig, logger?: object, maxTimelineHistory?: number}} opts
 */
export function createObservabilityService({ bus, config, logger, maxTimelineHistory } = {}) {
  const metrics = createMetricsCollector({ config, logger });
  const timeline = createTimelineStore({ maxTimelineHistory });
  const replayEngine = createReplayEngine({ timelineStore: timeline, config, logger });
  const snapshotBuilder = createSnapshotBuilder({ metricsCollector: metrics });
  const consumers = createConsumerRegistry();

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

  /** @param {string} jobId @returns {{source: "runtime"|"workspace"|"unavailable", timeline: object[]}} */
  function replay(jobId) {
    return replayEngine.replay(jobId);
  }

  /** @returns {{takenAt: string, metrics: object, activeJobs: object[]}} immutable */
  function getSnapshot() {
    return snapshotBuilder.build();
  }

  /** @param {string} name @param {object} [metadata] */
  function registerConsumer(name, metadata) {
    return consumers.register(name, metadata);
  }

  function unregisterConsumer(id) {
    return consumers.unregister(id);
  }

  function touchConsumer(id) {
    return consumers.touch(id);
  }

  function listConsumers() {
    return consumers.list();
  }

  function getConsumerHealth(id) {
    return consumers.getHealth(id);
  }

  function getConsumerStatistics() {
    return consumers.getStatistics();
  }

  /** Unsubscribes from RuntimeEventBus — called during the same graceful-shutdown path cli/entry.js already uses. */
  function close() {
    unsubscribe();
  }

  return Object.freeze({
    getMetrics,
    getTimeline,
    replay,
    getSnapshot,
    registerConsumer,
    unregisterConsumer,
    touchConsumer,
    listConsumers,
    getConsumerHealth,
    getConsumerStatistics,
    close,
  });
}
