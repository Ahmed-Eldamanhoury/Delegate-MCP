import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isValidJobId } from "./workspaceManager.js";

const JSONL_SUFFIX = ".jsonl";

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

  /**
   * Best-effort, synchronous: evicts the oldest-by-mtime `.jsonl` files beyond `maxFiles`,
   * mirroring `workspaceManager.pruneWorkspaces()`'s shape (best-effort, force-remove,
   * oldest-first). Unlike a job workspace directory -- whose `metadata.json` only exists once
   * settled, so its mere presence signals "done" -- a `.jsonl` file exists from a job's very
   * first event and is appended to throughout its life, so file existence alone can't tell you
   * whether a job is still running. `terminalJobIds` (a Set the caller maintains from events
   * it has personally observed) is therefore the ONLY source of eviction eligibility: a job id
   * absent from that set is never even inspected, let alone deleted -- this makes "never evict
   * an in-flight job's file" a structural guarantee, not a heuristic based on how recently the
   * file happened to be touched.
   * @param {{maxFiles: number, terminalJobIds: Set<string>}} opts
   * @returns {string[]} job ids whose files were actually evicted -- the caller (the event-
   *   history bridge) uses this to shrink its own terminal-tracking Set after the fact, so that
   *   set stays bounded to roughly the retained file count instead of growing unboundedly over
   *   a long-running process.
   */
  function prune({ maxFiles, terminalJobIds }) {
    try {
      if (!existsSync(dir)) return [];

      const candidates = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(JSONL_SUFFIX))
        .map((entry) => {
          const jobId = entry.name.slice(0, -JSONL_SUFFIX.length);
          if (!terminalJobIds.has(jobId)) return null; // not confirmed terminal -- never a candidate
          const filePath = join(dir, entry.name);
          try {
            return { jobId, filePath, mtimeMs: statSync(filePath).mtimeMs };
          } catch {
            return null; // removed between readdir and stat (e.g. concurrent prune)
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

      const excess = candidates.length - maxFiles;
      const evicted = [];
      for (let i = 0; i < excess; i++) {
        rmSync(candidates[i].filePath, { force: true });
        evicted.push(candidates[i].jobId);
      }
      return evicted;
    } catch (err) {
      logger?.warn?.("eventHistoryStore: prune failed", { message: err.message });
      return [];
    }
  }

  return Object.freeze({ append, readAll, has, prune });
}
