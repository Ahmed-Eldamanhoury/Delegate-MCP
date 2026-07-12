/**
 * Minimal storage interface for Job records. In-memory today; a future persistent store
 * (e.g. SQLite) can implement the same four methods and be swapped in via JobManager's
 * `store` dependency — no changes needed elsewhere.
 */
export class InMemoryJobStore {
  constructor() {
    /** @type {Map<string, import("../models/job.js").Job>} */
    this.jobs = new Map();
  }

  /** @param {import("../models/job.js").Job} job */
  create(job) {
    this.jobs.set(job.id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  /** @param {string} id @param {Partial<import("../models/job.js").Job>} patch */
  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }

  list() {
    return [...this.jobs.values()];
  }

  delete(id) {
    return this.jobs.delete(id);
  }
}
