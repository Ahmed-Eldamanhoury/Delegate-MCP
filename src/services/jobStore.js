/**
 * @typedef {Object} JobStore
 * @property {(job: import("../models/job.js").Job) => import("../models/job.js").Job} create
 * @property {(id: string) => import("../models/job.js").Job | undefined} get
 * @property {(id: string, patch: Partial<import("../models/job.js").Job>) => import("../models/job.js").Job | undefined} update
 * @property {() => import("../models/job.js").Job[]} list
 * @property {(id: string) => boolean} delete
 */

/**
 * In-memory implementation of {@link JobStore}. See
 * docs/adr/ADR-0005-persistent-job-store.md for `FileJobStore`, a restart-durable
 * alternative implementing the same interface — swapped in via `JobManager`'s `store`
 * dependency, no changes needed elsewhere.
 * @implements {JobStore}
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
