export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  STARTING: "starting",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const TERMINAL_STATUSES = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED]);

/** Static per-status progress metadata. No streaming — these are fixed descriptions, not live updates. */
export const PHASE_INFO = Object.freeze({
  [JOB_STATUS.QUEUED]: { phase: "queued", progressMessage: "Waiting in queue" },
  [JOB_STATUS.STARTING]: { phase: "starting", progressMessage: "Spawning claude CLI subprocess" },
  [JOB_STATUS.RUNNING]: { phase: "executing", progressMessage: "Executing claude CLI" },
  [JOB_STATUS.COMPLETED]: { phase: "completed", progressMessage: "Finished successfully" },
  [JOB_STATUS.FAILED]: { phase: "failed", progressMessage: "Failed" },
  [JOB_STATUS.CANCELLED]: { phase: "cancelled", progressMessage: "Cancelled" },
});

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {"queued"|"starting"|"running"|"completed"|"failed"|"cancelled"} status
 * @property {string} phase            same information as status, named for forward-compat with future finer-grained phases
 * @property {string|null} progressMessage static per-phase description (see PHASE_INFO) — not live streaming
 * @property {string} queuedAt        ISO timestamp
 * @property {string|null} startedAt  ISO timestamp, set once at the starting transition and never reset
 * @property {string|null} finishedAt ISO timestamp
 * @property {number|null} runtimeMs  finishedAt - startedAt (final, immutable once terminal)
 * @property {number|null} exitCode   process exit code, if applicable
 * @property {Record<string, unknown>} metadata caller-supplied context (e.g. tool name, input)
 * @property {unknown} result
 * @property {string|null} error
 */

/** @param {Record<string, unknown>} [metadata] @returns {Job} */
export function createJob(id, metadata = {}) {
  return {
    id,
    status: JOB_STATUS.QUEUED,
    ...PHASE_INFO[JOB_STATUS.QUEUED],
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    runtimeMs: null,
    exitCode: null,
    metadata,
    result: null,
    error: null,
  };
}

/**
 * Runtime "tracked continuously": for a still-in-flight job this computes elapsed time live
 * from startedAt rather than relying on a stored value that would otherwise be stale between
 * store writes. Terminal jobs keep their final, immutable stored runtimeMs.
 */
export function deriveRuntimeMs(job) {
  if (!TERMINAL_STATUSES.has(job.status) && job.startedAt) {
    return Date.now() - new Date(job.startedAt).getTime();
  }
  return job.runtimeMs;
}

/** The Job as external tools should see it: live runtimeMs while in flight. */
export function toJobView(job) {
  return { ...job, runtimeMs: deriveRuntimeMs(job) };
}

/** Lean projection of a Job for list views (drops the potentially large raw CLI output). */
export function summarizeJob(job) {
  const view = toJobView(job);
  return {
    id: view.id,
    status: view.status,
    phase: view.phase,
    progressMessage: view.progressMessage,
    model: view.metadata?.model ?? null,
    queuedAt: view.queuedAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    runtimeMs: view.runtimeMs,
    exitCode: view.exitCode,
    costUsd: view.result?.parsed?.total_cost_usd ?? null,
    error: view.error,
  };
}
