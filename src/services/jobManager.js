import { randomUUID } from "node:crypto";
import { JOB_STATUS, TERMINAL_STATUSES, PHASE_INFO, createJob } from "../models/job.js";
import { InMemoryJobStore } from "./jobStore.js";

/**
 * Runs async tasks in the background with a bounded concurrency queue, tracking each as a
 * Job. Both the synchronous `delegate_task` handler (which awaits completion) and the
 * non-blocking `delegate_submit` handler go through this same submit() — it's the single
 * source of truth for job state either way.
 */
export class JobManager {
  /** @param {{store?: InMemoryJobStore, maxConcurrent?: number, maxHistory?: number, logger?: object}} [opts] */
  constructor({ store = new InMemoryJobStore(), maxConcurrent = 2, maxHistory = 500, logger } = {}) {
    this.store = store;
    this.maxConcurrent = maxConcurrent;
    this.maxHistory = maxHistory;
    this.logger = logger;
    /** @type {{id: string, taskFn: (signal: AbortSignal, markRunning: () => void) => Promise<unknown>}[]} */
    this.pending = [];
    /** @type {Map<string, AbortController>} */
    this.running = new Map();
    /** @type {Map<string, ((job: import("../models/job.js").Job) => void)[]>} */
    this.waiters = new Map();
  }

  /**
   * @param {(signal: AbortSignal, markRunning: () => void) => Promise<unknown>} taskFn
   *   `markRunning` should be called once real execution has actually begun (e.g. the
   *   subprocess spawned) to advance the job from "starting" to "running".
   * @param {Record<string, unknown>} [metadata]
   * @returns {string} job id
   */
  submit(taskFn, metadata = {}) {
    const id = randomUUID();
    this.store.create(createJob(id, metadata));
    this.pending.push({ id, taskFn });
    this._drain();
    return id;
  }

  getJob(id) {
    return this.store.get(id);
  }

  listJobs() {
    return this.store.list();
  }

  /**
   * Resolves once the job reaches a terminal status (completed/failed/cancelled).
   * @param {string} id
   * @returns {Promise<import("../models/job.js").Job>}
   */
  waitForCompletion(id) {
    const job = this.store.get(id);
    if (!job) return Promise.reject(new Error(`Unknown job id: ${id}`));
    if (TERMINAL_STATUSES.has(job.status)) return Promise.resolve(job);

    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? [];
      waiters.push(resolve);
      this.waiters.set(id, waiters);
    });
  }

  /**
   * Cancels a queued job (removed before it ever runs) or a starting/running one (aborts its
   * subprocess). Completed/failed/cancelled jobs are immutable and cannot be cancelled.
   * @returns {boolean} whether a cancellation was actually issued
   */
  cancelJob(id) {
    const job = this.store.get(id);
    if (!job) return false;

    if (job.status === JOB_STATUS.QUEUED) {
      this.pending = this.pending.filter((p) => p.id !== id);
      this._transition(id, JOB_STATUS.CANCELLED, { finishedAt: new Date().toISOString() });
      this._settle(id);
      return true;
    }

    if (job.status === JOB_STATUS.STARTING || job.status === JOB_STATUS.RUNNING) {
      this.running.get(id)?.abort();
      return true;
    }

    return false;
  }

  _drain() {
    while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const next = this.pending.shift();
      this._run(next.id, next.taskFn);
    }
  }

  async _run(id, taskFn) {
    const controller = new AbortController();
    this.running.set(id, controller);
    const startedAt = new Date();
    // Runtime is tracked from this single startedAt through to completion — the
    // starting -> running transition below never resets it.
    this._transition(id, JOB_STATUS.STARTING, { startedAt: startedAt.toISOString() });

    try {
      const result = await taskFn(controller.signal, () => this._transition(id, JOB_STATUS.RUNNING));
      const finishedAt = new Date();
      this._transition(id, JOB_STATUS.COMPLETED, {
        finishedAt: finishedAt.toISOString(),
        runtimeMs: finishedAt - startedAt,
        exitCode: 0,
        result,
      });
    } catch (err) {
      const finishedAt = new Date();
      const cancelled = err?.name === "AbortError";
      this._transition(id, cancelled ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED, {
        finishedAt: finishedAt.toISOString(),
        runtimeMs: finishedAt - startedAt,
        exitCode: typeof err?.code === "number" ? err.code : null,
        error: cancelled ? null : err?.message ?? String(err),
      });
      this.logger?.[cancelled ? "info" : "error"](`job ${cancelled ? "cancelled" : "failed"}`, {
        id,
        message: err?.message,
      });
    } finally {
      this.running.delete(id);
      this._settle(id);
      this._drain();
    }
  }

  /** Applies a status transition plus its static phase/progressMessage metadata. */
  _transition(id, status, extra = {}) {
    this.store.update(id, { status, ...PHASE_INFO[status], ...extra });
  }

  _settle(id) {
    const waiters = this.waiters.get(id);
    if (waiters) {
      const job = this.store.get(id);
      waiters.forEach((resolve) => resolve(job));
      this.waiters.delete(id);
    }
    this._trimHistory();
  }

  /** Evicts the oldest terminal jobs once history exceeds maxHistory; queued/running jobs are never evicted. */
  _trimHistory() {
    const jobs = this.store.list();
    if (jobs.length <= this.maxHistory) return;

    for (const job of jobs) {
      if (this.store.list().length <= this.maxHistory) break;
      if (TERMINAL_STATUSES.has(job.status)) this.store.delete(job.id);
    }
  }
}
