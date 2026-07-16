import { EVENT_TYPES } from "../models/runtimeEvent.js";

/**
 * Subscribes durable event-history persistence to the RuntimeEventBus (ADR-0006) -- a fourth,
 * independent `bus.subscribeAll()` consumer alongside `workspaceEventBridge`,
 * `mcpProgressAdapter`, and `ObservabilityService`. `OutputChunk` is deliberately excluded:
 * its content (raw stdout/stderr) is already durably owned by
 * `workspaceManager.js`'s `stdout.log`/`stderr.log` (`ADR-0001`) -- logging it again here would
 * duplicate that ownership, which `ADR-0003`'s Data Ownership rule forbids.
 * @param {{bus: object, eventHistoryStore: {append: Function}, logger?: object}} deps
 * @returns {() => void} unsubscribe, for symmetry with the other bus-wiring functions
 */
export function wireEventHistoryToEventBus({ bus, eventHistoryStore }) {
  return bus.subscribeAll((event) => {
    if (event.type === EVENT_TYPES.OUTPUT_CHUNK) return; // already durable via stdout.log/stderr.log
    eventHistoryStore.append(event);
  });
}
