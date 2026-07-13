import { EVENT_TYPES } from "../models/runtimeEvent.js";

const TERMINAL_EVENT_TYPES = new Set([EVENT_TYPES.JOB_COMPLETED, EVENT_TYPES.JOB_FAILED, EVENT_TYPES.JOB_CANCELLED]);

/**
 * Per-job, append-only event history. Ordering is deterministic by construction:
 * RuntimeEventBus.publish() dispatches synchronously and Node is single-threaded, so events
 * land in exactly the order they were published — record() never reorders.
 *
 * Bounded via the same shape JobManager._trimHistory()/workspaceManager.pruneWorkspaces()
 * already use: oldest *terminal* job's timeline evicted first, an in-flight job's timeline is
 * never evicted (ADR-0003).
 *
 * @param {{maxTimelineHistory?: number}} [opts]
 */
export function createTimelineStore({ maxTimelineHistory = 500 } = {}) {
  /** @type {Map<string, {eventId: string, timestamp: string, type: string, payload: object}[]>} */
  const timelines = new Map();
  /** @type {string[]} jobId insertion order, for oldest-terminal-first eviction */
  const order = [];
  const terminalJobs = new Set();

  function evictIfNeeded() {
    while (timelines.size > maxTimelineHistory) {
      const oldestTerminalIndex = order.findIndex((id) => terminalJobs.has(id));
      if (oldestTerminalIndex === -1) return; // nothing terminal left to evict; never evict in-flight jobs
      const [evictedId] = order.splice(oldestTerminalIndex, 1);
      timelines.delete(evictedId);
      terminalJobs.delete(evictedId);
    }
  }

  function record(event) {
    const { jobId, eventId, timestamp, type, payload } = event;
    if (!jobId) return;

    let list = timelines.get(jobId);
    if (!list) {
      list = [];
      timelines.set(jobId, list);
      order.push(jobId);
    }
    list.push({ eventId, timestamp, type, payload });

    if (TERMINAL_EVENT_TYPES.has(type)) {
      terminalJobs.add(jobId);
      evictIfNeeded();
    }
  }

  /**
   * @param {string} jobId
   * @param {{type?: string, since?: string}} [filter]
   * @returns {{eventId: string, timestamp: string, type: string, payload: object}[]} chronological order
   */
  function getTimeline(jobId, { type, since } = {}) {
    const list = timelines.get(jobId) ?? [];
    return list.filter((entry) => (!type || entry.type === type) && (!since || entry.timestamp >= since));
  }

  /** Whether jobId's timeline is still retained (vs. evicted or never seen) — used by a future ReplayEngine. */
  function has(jobId) {
    return timelines.has(jobId);
  }

  return Object.freeze({ record, getTimeline, has });
}
