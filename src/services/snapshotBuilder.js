/** Recursively freezes an already-detached (structuredClone'd) object graph. */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Immutable, point-in-time runtime snapshots — pull-only, built on demand, no background
 * timer (supports future Dashboard *polling*, per ADR-0003). `structuredClone()` detaches the
 * result from MetricsCollector's live internal state before `deepFreeze()` locks every level
 * of it, so a consumer can never mutate a snapshot back into Observability's own state, nor
 * mutate nested fields of the snapshot itself.
 *
 * @param {{metricsCollector: import("./metricsCollector.js").MetricsCollector}} opts
 */
export function createSnapshotBuilder({ metricsCollector }) {
  /** @returns {{takenAt: string, metrics: object, activeJobs: object[]}} */
  function build() {
    const raw = {
      takenAt: new Date().toISOString(),
      metrics: metricsCollector.getMetrics(),
      activeJobs: metricsCollector.getActiveJobs(),
    };
    return deepFreeze(structuredClone(raw));
  }

  return Object.freeze({ build });
}
