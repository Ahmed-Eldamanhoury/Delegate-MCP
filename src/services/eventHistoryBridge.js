import { EVENT_TYPES } from "../models/runtimeEvent.js";

const TERMINAL_EVENT_TYPES = new Set([
  EVENT_TYPES.JOB_COMPLETED,
  EVENT_TYPES.JOB_FAILED,
  EVENT_TYPES.JOB_CANCELLED,
]);

/**
 * Subscribes durable event-history persistence to the RuntimeEventBus (ADR-0006) -- a fourth,
 * independent `bus.subscribeAll()` consumer alongside `workspaceEventBridge`,
 * `mcpProgressAdapter`, and `ObservabilityService`. `OutputChunk` is deliberately excluded:
 * its content (raw stdout/stderr) is already durably owned by
 * `workspaceManager.js`'s `stdout.log`/`stderr.log` (`ADR-0001`) -- logging it again here would
 * duplicate that ownership, which `ADR-0003`'s Data Ownership rule forbids.
 *
 * Retention (Task 3): this bridge is the only place in the process that observes every
 * RuntimeEvent, including the terminal ones (JobCompleted/JobFailed/JobCancelled) -- so it's
 * the natural place to track which job ids are confirmed terminal. `terminalJobIds` is small,
 * bounded, lifecycle-tracking bookkeeping (job ids only, never event content), directly
 * analogous to `MetricsCollector`'s own `jobBucket`/`jobMeta` maps
 * (`src/services/metricsCollector.js:90-97`) -- not a violation of `EventHistoryStore`'s "no
 * cache" design (Task 1), which is about not caching event *content*. On every terminal event,
 * after appending it, this calls `eventHistoryStore.prune({maxFiles, terminalJobIds})`, which
 * can ONLY consider job ids in that set -- an in-flight job id is never even inspected, let
 * alone evicted, which is what makes "never evict an in-flight job's file" a structural
 * guarantee rather than an mtime-based heuristic. `prune()` reports back which job ids were
 * actually evicted, and those are removed from `terminalJobIds` here -- without this, the set
 * would grow by one entry per completed job for the lifetime of the process, an unbounded (if
 * slow) memory leak; with it, the set stays roughly the size of the retained file count once
 * the cap is reached. Pruning is skipped entirely when `maxFiles` isn't supplied, so existing
 * callers that don't pass it see byte-identical behavior to before this retention logic existed.
 * @param {{bus: object, eventHistoryStore: {append: Function, prune?: Function}, maxFiles?: number, logger?: object}} deps
 * @returns {() => void} unsubscribe, for symmetry with the other bus-wiring functions
 */
export function wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles }) {
  const terminalJobIds = new Set();

  return bus.subscribeAll((event) => {
    if (event.type === EVENT_TYPES.OUTPUT_CHUNK) return; // already durable via stdout.log/stderr.log
    eventHistoryStore.append(event);

    if (!TERMINAL_EVENT_TYPES.has(event.type)) return;
    terminalJobIds.add(event.jobId);

    if (typeof maxFiles !== "number" || typeof eventHistoryStore.prune !== "function") return;
    const evicted = eventHistoryStore.prune({ maxFiles, terminalJobIds });
    for (const jobId of evicted) terminalJobIds.delete(jobId);
  });
}
