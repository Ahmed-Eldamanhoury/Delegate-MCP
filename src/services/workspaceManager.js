import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Defense in depth: job ids are always randomUUID() output, but never build a path from an unchecked string. */
export function isValidJobId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

export function getWorkspaceRoot(config) {
  return join(config.workspaceRoot, "jobs");
}

/** @throws if jobId isn't a valid UUID — callers are expected to catch (all public functions below do). */
function jobDir(jobId, config) {
  if (!isValidJobId(jobId)) {
    throw new Error(`Refusing to build a workspace path from an invalid job id: ${jobId}`);
  }
  return join(getWorkspaceRoot(config), jobId);
}

/** ExecutionContext.environment is process.env — writing it verbatim to disk would leak secrets. */
function redactContext(context) {
  const { environment, ...rest } = context;
  return { ...rest, environment: "[omitted: process environment, may contain secrets]" };
}

/**
 * Best-effort, synchronous: creates <workspaceRoot>/jobs/<jobId>/ with context.json and an
 * empty artifacts/ dir. Never throws — a failure here must not affect the job outcome.
 * @param {string} jobId
 * @param {import("../models/executionContext.js").ExecutionContext} context
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {object} [logger]
 */
export function createJobWorkspace(jobId, context, config, logger) {
  try {
    const dir = jobDir(jobId, config);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "context.json"), JSON.stringify(redactContext(context), null, 2));
  } catch (err) {
    logger?.warn?.("workspace: failed to create job workspace", { jobId, message: err.message });
  }
}

/**
 * Best-effort, synchronous: writes metadata.json/stdout.log/stderr.log/result.json for a
 * settled (terminal) job. Called once, after JobManager.waitForCompletion() resolves.
 * @param {string} jobId
 * @param {import("../models/job.js").Job} job
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {object} [logger]
 */
export function persistJobArtifacts(jobId, job, config, logger) {
  try {
    const dir = jobDir(jobId, config);
    mkdirSync(dir, { recursive: true }); // in case createJobWorkspace's earlier write failed

    const metadata = {
      id: job.id,
      tool: job.metadata?.tool ?? null,
      model: job.metadata?.model ?? null,
      effort: job.metadata?.effort ?? null,
      status: job.status,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      runtimeMs: job.runtimeMs,
      exitCode: job.exitCode,
      costUsd: job.result?.parsed?.total_cost_usd ?? null,
      error: job.error,
    };

    writeFileSync(join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
    writeFileSync(join(dir, "stdout.log"), job.result?.raw ?? "");
    writeFileSync(join(dir, "stderr.log"), job.result?.stderr ?? "");
    writeFileSync(join(dir, "result.json"), JSON.stringify(job.result?.parsed ?? null, null, 2));
  } catch (err) {
    logger?.warn?.("workspace: failed to persist job artifacts", { jobId, message: err.message });
  }
}

/**
 * Best-effort, synchronous: evicts the oldest workspaces beyond maxWorkspaceHistory. Only
 * ever considers a directory that already has metadata.json — a job still in flight (whose
 * directory has only context.json so far) is never a candidate. Uses `force: true` so a
 * directory removed by a concurrently-running prune call doesn't throw.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {object} [logger]
 */
export function pruneWorkspaces(config, logger) {
  try {
    const root = getWorkspaceRoot(config);
    if (!existsSync(root)) return;

    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidJobId(entry.name))
      .map((entry) => {
        const dir = join(root, entry.name);
        const metadataPath = join(dir, "metadata.json");
        if (!existsSync(metadataPath)) return null; // still in flight or never finished — never touch

        let finishedAtMs;
        try {
          finishedAtMs = new Date(JSON.parse(readFileSync(metadataPath, "utf8")).finishedAt).getTime();
        } catch {
          finishedAtMs = NaN;
        }
        return { dir, sortKey: Number.isFinite(finishedAtMs) ? finishedAtMs : statSync(dir).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => a.sortKey - b.sortKey);

    const excess = candidates.length - config.maxWorkspaceHistory;
    for (let i = 0; i < excess; i++) {
      rmSync(candidates[i].dir, { recursive: true, force: true });
    }
  } catch (err) {
    logger?.warn?.("workspace: prune failed", { message: err.message });
  }
}
