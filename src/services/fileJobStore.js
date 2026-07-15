import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isValidJobId } from "./workspaceManager.js";

const STORE_VERSION = 1;
const JSON_EXT = ".json";

/**
 * File-backed implementation of {@link import("./jobStore.js").JobStore} — one JSON file
 * per job under `dir`, atomic writes (temp file + rename, never a direct write to the
 * final path), an in-memory cache hydrated once at construction so get()/list() never
 * touch disk on the read path. See docs/adr/ADR-0005-persistent-job-store.md for the
 * full design rationale, including why hydration in *this* file is intentionally naive
 * (no corrupted-file handling, no non-terminal-job recovery) -- see
 * docs/services/fileJobStore.js's own Task 3 addendum once that lands.
 * @implements {import("./jobStore.js").JobStore}
 */
export class FileJobStore {
  /** @param {{dir: string, logger?: {warn: Function}}} opts */
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger;
    /** @type {Map<string, import("../models/job.js").Job>} */
    this.cache = new Map();
    this._hydrate();
  }

  /** @param {string} id @returns {string} */
  _pathFor(id) {
    if (!isValidJobId(id)) {
      throw new Error(`Refusing to build a job-store path from an invalid job id: ${id}`);
    }
    return join(this.dir, `${id}${JSON_EXT}`);
  }

  _hydrate() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      return;
    }
    for (const filename of readdirSync(this.dir)) {
      if (!filename.endsWith(JSON_EXT)) continue;
      const id = filename.slice(0, -JSON_EXT.length);
      if (!isValidJobId(id)) continue;
      const raw = JSON.parse(readFileSync(join(this.dir, filename), "utf8"));
      this.cache.set(id, raw.job);
    }
  }

  /** @param {import("../models/job.js").Job} job */
  _write(job) {
    const finalPath = this._pathFor(job.id);
    const tmpPath = `${finalPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify({ storeVersion: STORE_VERSION, job }), "utf8");
      renameSync(tmpPath, finalPath);
    } catch (err) {
      this.logger?.warn("FileJobStore write failed", { jobId: job.id, message: err.message });
    }
  }

  /** @param {import("../models/job.js").Job} job */
  create(job) {
    this._write(job);
    this.cache.set(job.id, job);
    return job;
  }

  /** @param {string} id */
  get(id) {
    return this.cache.get(id);
  }

  /** @param {string} id @param {Partial<import("../models/job.js").Job>} patch */
  update(id, patch) {
    const job = this.cache.get(id);
    if (!job) return undefined;
    const updated = { ...job, ...patch };
    this.cache.set(id, updated);
    this._write(updated);
    return updated;
  }

  list() {
    return [...this.cache.values()];
  }

  /** @param {string} id */
  delete(id) {
    if (!this.cache.has(id)) return false;
    this.cache.delete(id);
    try {
      unlinkSync(this._pathFor(id));
    } catch {
      // already gone -- delete() is idempotent, matching workspaceManager.pruneWorkspaces()'s
      // force-unlink precedent (ADR-0001).
    }
    return true;
  }
}
