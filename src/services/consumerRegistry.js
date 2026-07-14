/**
 * Tracks who has registered as an ObservabilityService consumer — bookkeeping/introspection
 * only, per ADR-0003: no transport layer, no push delivery, no second event bus. A future
 * concrete consumer (Dashboard, REST adapter, etc.) calls register() once at startup and
 * unregister()/touch() as it disconnects/stays alive; nothing here calls out to it.
 */
export function createConsumerRegistry() {
  let nextId = 1;
  let totalRegistered = 0;
  /** @type {Map<string, {id: string, name: string, metadata: object, registeredAt: string, lastSeenAt: string}>} */
  const consumers = new Map();

  /** @param {string} name @param {object} [metadata] @returns {{id: string, unregister: () => boolean, touch: () => boolean}} */
  function register(name, metadata = {}) {
    const id = String(nextId++);
    const registeredAt = new Date().toISOString();
    // Shallow-clone metadata on the way in (defensive copy of caller input) — see list()'s
    // matching clone on the way out. Without both, a caller mutating either their original
    // object or a list() result's .metadata would silently corrupt the registry's own state.
    consumers.set(id, { id, name, metadata: { ...metadata }, registeredAt, lastSeenAt: registeredAt });
    totalRegistered += 1;
    return { id, unregister: () => unregister(id), touch: () => touch(id) };
  }

  /** @param {string} id @returns {boolean} whether a consumer was actually removed */
  function unregister(id) {
    return consumers.delete(id);
  }

  /** Heartbeat: updates lastSeenAt for a still-registered consumer. @returns {boolean} */
  function touch(id) {
    const consumer = consumers.get(id);
    if (!consumer) return false;
    consumer.lastSeenAt = new Date().toISOString();
    return true;
  }

  /** @returns {{id: string, name: string, metadata: object, registeredAt: string, lastSeenAt: string}[]} */
  function list() {
    return Array.from(consumers.values(), (c) => ({ ...c, metadata: { ...c.metadata } }));
  }

  /** @param {string} id @returns {{id: string, active: boolean, registeredAt: string|null, lastSeenAt: string|null}} */
  function getHealth(id) {
    const consumer = consumers.get(id);
    if (!consumer) return { id, active: false, registeredAt: null, lastSeenAt: null };
    return { id, active: true, registeredAt: consumer.registeredAt, lastSeenAt: consumer.lastSeenAt };
  }

  /** @returns {{activeCount: number, totalRegistered: number}} totalRegistered is all-time, never decremented */
  function getStatistics() {
    return { activeCount: consumers.size, totalRegistered };
  }

  /** Removes every consumer last seen more than maxAgeMs ago. @param {number} maxAgeMs @returns {number} count removed */
  function pruneStale(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const consumer of consumers.values()) {
      if (Date.parse(consumer.lastSeenAt) < cutoff) {
        consumers.delete(consumer.id);
        removed += 1;
      }
    }
    return removed;
  }

  return Object.freeze({ register, unregister, touch, list, getHealth, getStatistics, pruneStale });
}
