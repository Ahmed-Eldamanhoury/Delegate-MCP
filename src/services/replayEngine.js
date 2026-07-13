import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPES } from "../models/runtimeEvent.js";
import { getWorkspaceRoot, isValidJobId } from "./workspaceManager.js";

const TERMINAL_EVENT_BY_STATUS = {
  completed: EVENT_TYPES.JOB_COMPLETED,
  failed: EVENT_TYPES.JOB_FAILED,
  cancelled: EVENT_TYPES.JOB_CANCELLED,
};

/** Reconstructs a coarse timeline from a settled job's metadata.json — lifecycle transitions with timestamps only, no fine-grained progress ticks (see ADR-0003's Known limitation). Every entry is marked `synthetic: true` so a consumer can tell it apart from a real recorded TimelineEntry. */
function replayFromWorkspace(jobId, config) {
  if (!isValidJobId(jobId)) return null;
  const metadataPath = join(getWorkspaceRoot(config), jobId, "metadata.json");
  if (!existsSync(metadataPath)) return null;

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return null;
  }

  const timeline = [];
  if (metadata.queuedAt) {
    timeline.push({ eventId: null, timestamp: metadata.queuedAt, type: EVENT_TYPES.JOB_QUEUED, payload: {}, synthetic: true });
  }
  if (metadata.startedAt) {
    timeline.push({
      eventId: null,
      timestamp: metadata.startedAt,
      type: EVENT_TYPES.JOB_STATE_CHANGED,
      payload: { to: "running" },
      synthetic: true,
    });
  }
  const terminalType = TERMINAL_EVENT_BY_STATUS[metadata.status];
  if (metadata.finishedAt && terminalType) {
    timeline.push({
      eventId: null,
      timestamp: metadata.finishedAt,
      type: terminalType,
      payload: { runtimeMs: metadata.runtimeMs ?? null, exitCode: metadata.exitCode ?? null, error: metadata.error ?? null },
      synthetic: true,
    });
  }
  return timeline;
}

/**
 * Reconstructs a job's event history for viewing — read-only, zero side effects, never
 * re-executes anything (ADR-0003). Deterministic: same stored input always yields the same
 * output, since both sources (TimelineStore's retained buffer, workspace's metadata.json) are
 * read verbatim, never re-derived from anything time-dependent.
 *
 * Source priority: runtime (full fidelity) > workspace (coarse, synthesized) > unavailable.
 * Never duplicates stored data — this only *reads* TimelineStore/disk, holds no copy of its own.
 *
 * @param {{timelineStore: import("./timelineStore.js").TimelineStore, config?: import("../config/index.js").DelegateConfig, logger?: object}} opts
 */
export function createReplayEngine({ timelineStore, config, logger }) {
  /** @param {string} jobId @returns {{source: "runtime"|"workspace"|"unavailable", timeline: object[]}} */
  function replay(jobId) {
    if (timelineStore.has(jobId)) {
      return { source: "runtime", timeline: timelineStore.getTimeline(jobId) };
    }

    if (config) {
      try {
        const timeline = replayFromWorkspace(jobId, config);
        if (timeline && timeline.length > 0) return { source: "workspace", timeline };
      } catch (err) {
        logger?.warn?.("replayEngine: workspace replay failed", { jobId, message: err.message });
      }
    }

    return { source: "unavailable", timeline: [] };
  }

  return Object.freeze({ replay });
}
