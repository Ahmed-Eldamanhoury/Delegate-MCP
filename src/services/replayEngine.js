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
 * Projects a raw `RuntimeEvent` (as read back from `EventHistoryStore.readAll()`, which
 * includes `jobId`/`version`) down to the same `TimelineEntry` shape `TimelineStore.getTimeline()`
 * already returns — a narrowing projection, not a pass-through, so `jobId`/`version` never leak
 * into a replay result.
 * @param {import("../models/runtimeEvent.js").RuntimeEvent} event
 */
function projectToTimelineEntry(event) {
  return { eventId: event.eventId, timestamp: event.timestamp, type: event.type, payload: event.payload };
}

/**
 * Reads a job's durable event log and projects it to `TimelineEntry` shape, in append order
 * (no re-sort — `readAll()` already returns file lines top-to-bottom). `OutputChunk` is
 * excluded here too, not just at `eventHistoryBridge.js`'s write side (ADR-0006) — this keeps
 * the exclusion true end-to-end even if a log somehow contained one (e.g. older data written
 * before that write-side rule existed).
 * @param {string} jobId
 * @param {{readAll: (jobId: string) => object[]}} eventHistoryStore
 */
function replayFromDurable(jobId, eventHistoryStore) {
  return eventHistoryStore
    .readAll(jobId)
    .filter((event) => event.type !== EVENT_TYPES.OUTPUT_CHUNK)
    .map(projectToTimelineEntry);
}

/**
 * Reconstructs a job's event history for viewing — read-only, zero side effects, never
 * re-executes anything (ADR-0003). Deterministic: same stored input always yields the same
 * output, since all sources (TimelineStore's retained buffer, EventHistoryStore's durable log,
 * workspace's metadata.json) are read verbatim, never re-derived from anything time-dependent.
 *
 * Source priority: runtime (full fidelity, volatile) > durable (full fidelity, survives
 * restart, minus OutputChunk) > workspace (coarse, synthesized) > unavailable. `durable` is a
 * fallback for when `runtime` is unavailable, never a replacement for it when both exist
 * (ADR-0006).
 * Never duplicates stored data — this only *reads* TimelineStore/EventHistoryStore/disk, holds
 * no copy of its own.
 *
 * @param {{timelineStore: import("./timelineStore.js").TimelineStore, eventHistoryStore?: import("./eventHistoryStore.js").EventHistoryStore, config?: import("../config/index.js").DelegateConfig, logger?: object}} opts
 */
export function createReplayEngine({ timelineStore, eventHistoryStore, config, logger }) {
  /** @param {string} jobId @returns {{source: "runtime"|"durable"|"workspace"|"unavailable", timeline: object[]}} */
  function replay(jobId) {
    if (timelineStore.has(jobId)) {
      return { source: "runtime", timeline: timelineStore.getTimeline(jobId) };
    }

    if (eventHistoryStore) {
      try {
        if (eventHistoryStore.has(jobId)) {
          return { source: "durable", timeline: replayFromDurable(jobId, eventHistoryStore) };
        }
      } catch (err) {
        logger?.warn?.("replayEngine: durable replay failed", { jobId, message: err.message });
      }
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
