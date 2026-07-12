import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { EVENT_SCHEMA_VERSION } from "../models/runtimeEvent.js";

const WILDCARD = "*";

/**
 * The RuntimeEventBus contract: `{publish, subscribe, subscribeAll}`. This is the only shape
 * any other module may depend on — this file is the *only* place in the codebase allowed to
 * `import "node:events"`. A future implementation (MessageChannel, RxJS, Redis, NATS,
 * RabbitMQ, ...) only needs to satisfy this same three-function shape; nothing that calls
 * publish()/subscribe() would need to change.
 *
 * @param {{logger?: object}} [opts]
 * @returns {{
 *   publish: (partial: {type: string, jobId: string, payload?: object}) => import("../models/runtimeEvent.js").RuntimeEvent,
 *   subscribe: (type: string, handler: (event: import("../models/runtimeEvent.js").RuntimeEvent) => void) => () => void,
 *   subscribeAll: (handler: (event: import("../models/runtimeEvent.js").RuntimeEvent) => void) => () => void,
 * }}
 */
export function createRuntimeEventBus({ logger } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50); // headroom for workspace + MCP adapter + future dashboard/plugins

  function publish(partial) {
    const event = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      version: EVENT_SCHEMA_VERSION,
      payload: {},
      ...partial,
    };
    emitter.emit(event.type, event);
    emitter.emit(WILDCARD, event);
    return event;
  }

  /** @returns {() => void} unsubscribe */
  function subscribe(type, handler) {
    // Wrapped here, not at each publish() call site, so isolation holds regardless of which
    // backing implementation is in use — one throwing subscriber never affects siblings or
    // the publisher (matches ADR-0001's fail-safe I/O precedent, generalized to all events).
    const wrapped = (event) => {
      try {
        handler(event);
      } catch (err) {
        logger?.warn?.("runtimeEventBus: subscriber threw", {
          type,
          jobId: event.jobId,
          message: err.message,
        });
      }
    };
    emitter.on(type, wrapped);
    return () => emitter.off(type, wrapped);
  }

  function subscribeAll(handler) {
    return subscribe(WILDCARD, handler);
  }

  return Object.freeze({ publish, subscribe, subscribeAll });
}
