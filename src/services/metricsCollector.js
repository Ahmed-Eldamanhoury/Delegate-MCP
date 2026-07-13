import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPES } from "../models/runtimeEvent.js";
import { getWorkspaceRoot } from "./workspaceManager.js";

/** Recursively sums file bytes/count under dir. Never throws — missing/unreadable dirs read as empty. */
function walkDirStats(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDirStats(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += statSync(full).size;
        files += 1;
      } catch {
        // file removed between readdir and stat (e.g. concurrent workspace prune) — skip it
      }
    }
  }
  return { bytes, files };
}

/**
 * Reuses workspaceManager's own path logic (getWorkspaceRoot) rather than re-deriving it —
 * no new path-construction logic, per ADR-0003's Data Ownership/Workspace isolation notes.
 * Read-only: readdirSync/statSync only, never a write.
 */
function getWorkspaceUsage(config) {
  const jobsRoot = getWorkspaceRoot(config);
  const { bytes: workspaceSizeBytes } = walkDirStats(jobsRoot);

  let jobDirs;
  try {
    jobDirs = readdirSync(jobsRoot, { withFileTypes: true });
  } catch {
    jobDirs = [];
  }
  let artifactCount = 0;
  for (const entry of jobDirs) {
    if (!entry.isDirectory()) continue;
    artifactCount += walkDirStats(join(jobsRoot, entry.name, "artifacts")).files;
  }
  return { workspaceSizeBytes, artifactCount };
}

/**
 * O(1) incremental aggregates derived from RuntimeEvents — no stored history arrays, per
 * ADR-0003. Workspace Size / Artifact Count are the one exception: not event-derived (the bus
 * carries no byte sizes), computed on demand from disk when getMetrics() is called and a
 * `config` was supplied.
 *
 * Adding a future metric means adding one `case` in record() plus one field in getMetrics() —
 * the dispatch mechanism itself never changes.
 *
 * @param {{config?: import("../config/index.js").DelegateConfig, logger?: object}} [opts]
 */
export function createMetricsCollector({ config, logger } = {}) {
  const startedAt = Date.now();

  let queuedJobs = 0;
  let runningJobs = 0;
  let completedJobs = 0;
  let failedJobs = 0;
  let cancelledJobs = 0;

  let runtimeSumMs = 0;
  let runtimeCount = 0;
  let maximumRuntimeMs = null;

  let queueWaitSumMs = 0;
  let queueWaitCount = 0;

  let streamingEvents = 0;
  let outputChunks = 0;
  let eventCount = 0;

  // Bounded by concurrency + queue depth (never by job history): entries are removed the
  // instant a job leaves the queued/starting/running window, so these never grow unbounded.
  /** @type {Map<string, "queued"|"starting"|"running">} */
  const jobBucket = new Map();
  /**
   * jobId -> {queuedAt, startedAt}, kept alive for the job's whole non-terminal lifetime (not
   * just until "starting") so getActiveJobs() can report both timestamps for SnapshotBuilder.
   * @type {Map<string, {queuedAt: string, startedAt: string|null}>}
   */
  const jobMeta = new Map();

  function recordRuntime(runtimeMs) {
    if (typeof runtimeMs !== "number") return;
    runtimeSumMs += runtimeMs;
    runtimeCount += 1;
    maximumRuntimeMs = maximumRuntimeMs === null ? runtimeMs : Math.max(maximumRuntimeMs, runtimeMs);
  }

  function onTerminal(jobId, counterBump) {
    const bucket = jobBucket.get(jobId);
    if (bucket === "queued") queuedJobs -= 1;
    else if (bucket === "running") runningJobs -= 1;
    jobBucket.delete(jobId);
    jobMeta.delete(jobId);
    counterBump();
  }

  function record(event) {
    eventCount += 1;
    const { type, jobId, payload = {}, timestamp } = event;

    switch (type) {
      case EVENT_TYPES.JOB_QUEUED:
        queuedJobs += 1;
        jobBucket.set(jobId, "queued");
        jobMeta.set(jobId, { queuedAt: timestamp, startedAt: null });
        return;

      case EVENT_TYPES.JOB_STATE_CHANGED:
        if (payload.to === "starting") {
          if (jobBucket.get(jobId) === "queued") {
            queuedJobs -= 1;
            const queuedTimestamp = jobMeta.get(jobId)?.queuedAt;
            if (queuedTimestamp) {
              queueWaitSumMs += new Date(timestamp).getTime() - new Date(queuedTimestamp).getTime();
              queueWaitCount += 1;
            }
          }
          jobBucket.set(jobId, "starting");
        } else if (payload.to === "running") {
          runningJobs += 1;
          jobBucket.set(jobId, "running");
          const meta = jobMeta.get(jobId);
          if (meta) meta.startedAt = timestamp;
        }
        return;

      case EVENT_TYPES.JOB_COMPLETED:
        onTerminal(jobId, () => {
          completedJobs += 1;
          recordRuntime(payload.runtimeMs);
        });
        return;

      case EVENT_TYPES.JOB_FAILED:
        onTerminal(jobId, () => {
          failedJobs += 1;
          recordRuntime(payload.runtimeMs);
        });
        return;

      case EVENT_TYPES.JOB_CANCELLED:
        onTerminal(jobId, () => {
          cancelledJobs += 1;
          recordRuntime(payload.runtimeMs);
        });
        return;

      case EVENT_TYPES.JOB_PROGRESS:
        streamingEvents += 1;
        return;

      case EVENT_TYPES.OUTPUT_CHUNK:
        outputChunks += 1;
        return;

      default:
        return; // ArtifactCreated/WorkspaceCreated/WorkspaceDeleted: counted in eventCount only, no dedicated metric yet
    }
  }

  function getMetrics() {
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 1);
    let workspaceSizeBytes = null;
    let artifactCount = null;
    if (config) {
      try {
        ({ workspaceSizeBytes, artifactCount } = getWorkspaceUsage(config));
      } catch (err) {
        logger?.warn?.("metricsCollector: workspace usage query failed", { message: err.message });
      }
    }

    return {
      queuedJobs,
      runningJobs,
      completedJobs,
      failedJobs,
      cancelledJobs,
      averageRuntimeMs: runtimeCount > 0 ? runtimeSumMs / runtimeCount : null,
      maximumRuntimeMs,
      averageQueueWaitMs: queueWaitCount > 0 ? queueWaitSumMs / queueWaitCount : null,
      progressRate: streamingEvents / elapsedSeconds,
      streamingEvents,
      outputChunks,
      eventCount,
      workspaceSizeBytes,
      artifactCount,
    };
  }

  /**
   * Lean, event-derived summaries of currently non-terminal jobs — sourced entirely from
   * jobBucket/jobMeta (built from RuntimeEvents), never from a JobManager query. This is
   * Observability's own derived view, distinct from models/job.js's JobSummary (which needs a
   * full Job record Observability deliberately never holds a reference to). Used by
   * SnapshotBuilder for Snapshot.activeJobs.
   * @returns {{jobId: string, status: "queued"|"starting"|"running", queuedAt: string, startedAt: string|null}[]}
   */
  function getActiveJobs() {
    return Array.from(jobBucket.entries()).map(([jobId, status]) => {
      const meta = jobMeta.get(jobId);
      return { jobId, status, queuedAt: meta?.queuedAt ?? null, startedAt: meta?.startedAt ?? null };
    });
  }

  return Object.freeze({ record, getMetrics, getActiveJobs });
}
