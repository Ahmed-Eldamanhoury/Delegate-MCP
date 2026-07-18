import { loadConfig } from "../config/index.js";
import { VERSION } from "../config/version.js";
import { validateConfig } from "../validation/configValidation.js";
import { createLogger } from "../logging/logger.js";
import { createDelegationBackend } from "../services/delegationBackend.js";
import { createRestServer } from "../rest/restServer.js";
import { resolveOrGenerateRestToken } from "../rest/auth.js";
import { createObservabilityRoutes } from "../rest/routes/observability.js";
import { createModelsRoute } from "../rest/routes/models.js";
import { createJobRoutes } from "../rest/routes/jobs.js";
import { TERMINAL_STATUSES } from "../models/job.js";

/**
 * The route table -- a plain array literal, assembled once at boot (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md
 * §1: "no separate routeTable.js"; mirrors mcpServer.js's own createMcpServer() inlining all 9
 * registerTool() calls in one place). All 9 routes now present: WP3's read-only observability +
 * models routes, plus WP4's job routes (read and write both live in `createJobRoutes`, per §1's
 * Module Layout grouping all four job methods in one factory/file).
 * @param {{backend: ReturnType<typeof createDelegationBackend>, config: import("../config/index.js").DelegateConfig}} deps
 */
export function buildRouteTable({ backend, config }) {
  const { handleReplay, handleTimeline, handleMetrics, handleSnapshot } = createObservabilityRoutes({
    observabilityService: backend.observabilityService,
  });
  const { handleModels } = createModelsRoute({ config });
  const { handleSubmit, handleGetJob, handleListJobs, handleCancelJob } = createJobRoutes({
    delegationService: backend.delegationService,
  });

  return [
    { method: "POST", path: "/v1/jobs", handler: handleSubmit },
    { method: "GET", path: "/v1/jobs/:id", handler: handleGetJob },
    { method: "GET", path: "/v1/jobs", handler: handleListJobs },
    { method: "DELETE", path: "/v1/jobs/:id", handler: handleCancelJob },
    { method: "GET", path: "/v1/jobs/:id/replay", handler: handleReplay },
    { method: "GET", path: "/v1/jobs/:id/timeline", handler: handleTimeline },
    { method: "GET", path: "/v1/metrics", handler: handleMetrics },
    { method: "GET", path: "/v1/snapshot", handler: handleSnapshot },
    { method: "GET", path: "/v1/models", handler: handleModels },
  ];
}

/**
 * REST's richer shutdown sequence (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §10), a new, separate
 * function alongside `entry.js`'s `registerShutdownHandlers` (untouched, zero edits) -- mirrors
 * its injectable-deps/testable shape. No `stdin`-close listener: REST has no client pipe to
 * watch (a second REST process is unambiguously wrong and caught for free by TCP port-bind,
 * unlike stdio's legitimate-multi-instance model, ADR-0011 Compatibility with existing MCP
 * transport).
 * @param {{close: () => Promise<void>}} restServer
 * @param {import("../services/jobManager.js").JobManager} jobManager
 * @param {{info: Function, warn: Function, error: Function}} logger
 * @param {{exit?: () => void, signalSource?: NodeJS.Process, observabilityService?: {close: () => void}, graceMs?: number, forceExitMs?: number}} [deps]
 * @returns {(trigger: string) => Promise<void>}
 */
export function registerRestShutdownHandlers(
  restServer,
  jobManager,
  logger,
  { exit = () => process.exit(0), signalSource = process, observabilityService, graceMs = 5000, forceExitMs = 2000 } = {}
) {
  let shuttingDown = false; // re-entrancy guard -- a second signal mid-shutdown must be a no-op
  const shutdown = async (trigger) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("REST shutting down", { trigger });

    await restServer.close(); // stop accepting new connections + close idle keep-alives
    await new Promise((r) => setTimeout(r, graceMs)); // let non-terminal jobs finish naturally

    const stillRunning = jobManager.listJobs().filter((j) => !TERMINAL_STATUSES.has(j.status));
    stillRunning.forEach((j) => jobManager.cancelJob(j.id)); // queued->sync, running->abort()+async settle

    await Promise.race([
      Promise.all(stillRunning.map((j) => jobManager.waitForCompletion(j.id))),
      new Promise((r) => setTimeout(r, forceExitMs)),
    ]);

    observabilityService?.close?.();
    exit();
  };

  signalSource.on("SIGINT", () => shutdown("SIGINT"));
  signalSource.on("SIGTERM", () => shutdown("SIGTERM"));

  return shutdown;
}

export async function main() {
  const logger = createLogger("claude-delegate-rest");

  const config = loadConfig(process.env);
  validateConfig(config);

  const token = resolveOrGenerateRestToken({ config, logger });
  const backend = createDelegationBackend({ config, logger });
  const routes = buildRouteTable({ backend, config });
  const restServer = createRestServer({ backend, config, logger, token, routes });

  registerRestShutdownHandlers(restServer, backend.jobManager, logger, {
    observabilityService: backend.observabilityService,
    graceMs: config.restShutdownGraceMs,
    forceExitMs: config.restShutdownForceExitMs,
  });

  await new Promise((resolve) => restServer.server.listen(config.restPort, config.restHost, resolve));
  logger.info("claude-delegate REST listening", { host: config.restHost, port: config.restPort, version: VERSION });
}
