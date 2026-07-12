/** A taskFn for JobManager.submit(): resolves with `value` after `ms`, honors cancellation. */
export function delayTask(ms, value) {
  return (signal, markRunning) =>
    new Promise((resolve, reject) => {
      markRunning?.();
      const timer = setTimeout(() => resolve(value), ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

/** A taskFn that always throws. */
export function failTask(message) {
  return async () => {
    throw new Error(message);
  };
}

/** Polls `predicate` until it's true, or rejects after timeoutMs. */
export function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
