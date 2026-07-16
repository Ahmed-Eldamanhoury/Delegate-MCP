import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidJobId } from "./workspaceManager.js";

/**
 * Append-only, per-job durable event log -- one JSON line per RuntimeEvent under `dir`.
 * No in-memory cache (unlike FileJobStore): reads go straight to disk, since this is a
 * cold/rare read path (replay fallback), not a hot one -- ObservabilityService's live
 * read path (getTimeline/getMetrics) never touches this file.
 * @param {{dir: string, logger?: {warn: Function}}} opts
 */
export function createEventHistoryStore({ dir, logger }) {
  function pathFor(jobId) {
    if (!isValidJobId(jobId)) {
      throw new Error(`Refusing to build an event-history path from an invalid job id: ${jobId}`);
    }
    return join(dir, `${jobId}.jsonl`);
  }

  function append(event) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(pathFor(event.jobId), JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      logger?.warn?.("eventHistoryStore: append failed", { jobId: event.jobId, message: err.message });
    }
  }

  function readAll(jobId) {
    const filePath = pathFor(jobId);
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (err) {
        logger?.warn?.("eventHistoryStore: skipping corrupted/unparseable event line", { jobId, message: err.message });
      }
    }
    return events;
  }

  function has(jobId) {
    return existsSync(pathFor(jobId));
  }

  return Object.freeze({ append, readAll, has });
}
