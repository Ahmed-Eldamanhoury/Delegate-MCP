import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DelegateTaskInputShape } from "../models/schemas.js";
import { JOB_STATUS } from "../models/job.js";
import { JobManager } from "../services/jobManager.js";
import { InMemoryJobStore } from "../services/jobStore.js";
import { FileJobStore } from "../services/fileJobStore.js";
import { createRuntimeEventBus } from "../services/runtimeEventBus.js";
import { wireWorkspaceToEventBus } from "../services/workspaceEventBridge.js";
import { createObservabilityService } from "../services/observabilityService.js";
import { createEventHistoryStore } from "../services/eventHistoryStore.js";
import { wireEventHistoryToEventBus } from "../services/eventHistoryBridge.js";
import { createDelegateTaskHandler } from "../handlers/delegateTaskHandler.js";
import { createDelegateSubmitHandler } from "../handlers/delegateSubmitHandler.js";
import { createDelegateStatusHandler } from "../handlers/delegateStatusHandler.js";
import { createDelegateHistoryHandler } from "../handlers/delegateHistoryHandler.js";
import { createDelegateModelsHandler } from "../handlers/delegateModelsHandler.js";
import { createDelegateCancelHandler } from "../handlers/delegateCancelHandler.js";

const TASK_DESCRIPTION =
  "Runs a one-shot Claude Code CLI session (headless) to execute a task, billed against the " +
  "user's existing Claude subscription/session auth — not a separate API key. Use a cheap model " +
  "(sonnet/haiku) for mechanical or recon work, and only escalate to opus/fable for judgment-heavy " +
  "steps. If the requested model is unavailable, it automatically falls back to a cheaper one. " +
  "Blocks until the task finishes — for a long task, use delegate_submit instead and poll with " +
  "delegate_status.";

const SUBMIT_DESCRIPTION =
  "Like delegate_task, but returns immediately with a job_id instead of waiting for the task to " +
  "finish. Poll progress with delegate_status/delegate_history, cancel with delegate_cancel. Same " +
  "model tiers, fallback behavior, and default tool restrictions as delegate_task.";

const JOB_ID_FIELD = z
  .string()
  .describe("Job id, as returned by delegate_task, delegate_submit, or delegate_history.");

/**
 * Picks the JobStore implementation per config.jobStore. Extracted as its own exported
 * function so it's unit-testable without constructing a full McpServer, which returns
 * only the server instance and never exposes its internal JobManager/store.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{warn: Function}} [logger]
 * @returns {import("../services/jobStore.js").JobStore}
 */
export function selectJobStore(config, logger) {
  if (config.jobStore === "file") {
    return new FileJobStore({ dir: config.jobStoreDir, logger });
  }
  return new InMemoryJobStore();
}

/**
 * Constructs an `EventHistoryStore` and wires it into the bus per `config.eventHistory`
 * (ADR-0006), mirroring `selectJobStore`'s shape: extracted as its own exported function so
 * it's unit-testable without constructing a full McpServer. When `config.eventHistory` is
 * unset or `"memory"` this is a no-op -- nothing new runs, default behavior stays byte-identical
 * to before this feature existed.
 * @param {{bus: object, config: import("../config/index.js").DelegateConfig, logger?: {warn: Function}}} deps
 * @returns {(() => void)|undefined} unsubscribe, or undefined when eventHistory is not "file"
 */
export function wireEventHistoryIfEnabled({ bus, config, logger }) {
  if (config.eventHistory !== "file") return undefined;
  const eventHistoryStore = createEventHistoryStore({ dir: config.eventHistoryDir, logger });
  return wireEventHistoryToEventBus({ bus, eventHistoryStore });
}

/**
 * @param {{config: import("../config/index.js").DelegateConfig, logger: ReturnType<import("../logging/logger.js").createLogger>, version: string}} deps
 */
export function createMcpServer({ config, logger, version }) {
  const server = new McpServer({ name: "claude-delegate", version });
  const bus = createRuntimeEventBus({ logger });
  const jobManager = new JobManager({
    store: selectJobStore(config, logger),
    maxConcurrent: config.maxConcurrentJobs,
    maxHistory: config.maxJobHistory,
    logger,
    bus,
  });
  // ADR-0002 Phase 4: Workspace is a bus subscriber, not a direct call from delegationService
  // (except createJobWorkspace — see delegationService.js for why). Extension point for
  // future consumers (History/Dashboard/plugins): subscribe to the same `bus` instance;
  // nothing here needs to change for them to hook in.
  wireWorkspaceToEventBus({ bus, jobManager, config, logger });

  // ADR-0003 Phase 1: Observability is a second, independent bus.subscribeAll() consumer,
  // read-only by construction (Passive Observation Rule) — it holds no reference to
  // jobManager or claudeCliService, only the bus. Its subscription closures live inside the
  // bus itself (same pattern wireWorkspaceToEventBus already uses above), so no local binding
  // is needed here. Not yet exposed via any MCP tool; this wave wires the service itself, not
  // a consumer of it.
  createObservabilityService({ bus, config, logger, maxTimelineHistory: config.maxJobHistory });

  // ADR-0006: EventHistoryStore is a new, independent bus.subscribeAll() consumer, opt-in via
  // config.eventHistory (default "memory" = off, byte-identical to before this feature existed).
  wireEventHistoryIfEnabled({ bus, config, logger });

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate task to a Claude Code subagent",
      description: TASK_DESCRIPTION,
      inputSchema: DelegateTaskInputShape,
    },
    createDelegateTaskHandler({ config, logger, jobManager })
  );

  server.registerTool(
    "delegate_submit",
    {
      title: "Submit a task to a Claude Code subagent (non-blocking)",
      description: SUBMIT_DESCRIPTION,
      inputSchema: DelegateTaskInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    createDelegateSubmitHandler({ config, logger, jobManager })
  );

  server.registerTool(
    "delegate_status",
    {
      title: "Check a delegated job's status",
      description:
        "Looks up a delegate_task/delegate_submit job by id: current status, timestamps, runtime, " +
        "cost, and the full result once it has finished.",
      inputSchema: { job_id: JOB_ID_FIELD },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateStatusHandler({ jobManager })
  );

  server.registerTool(
    "delegate_history",
    {
      title: "List recent delegated jobs",
      description:
        "Lists recent delegate_task/delegate_submit jobs, most recent first, with status/cost summaries.",
      inputSchema: {
        limit: z.number().int().positive().default(20).describe("Maximum number of jobs to return."),
        status: z
          .enum([
            JOB_STATUS.QUEUED,
            JOB_STATUS.STARTING,
            JOB_STATUS.RUNNING,
            JOB_STATUS.COMPLETED,
            JOB_STATUS.FAILED,
            JOB_STATUS.CANCELLED,
          ])
          .optional()
          .describe("Filter to a single status."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateHistoryHandler({ jobManager })
  );

  server.registerTool(
    "delegate_models",
    {
      title: "List available delegate models",
      description:
        "Lists the model tiers delegate_task accepts, their automatic fallback chains, valid effort " +
        "levels, and current defaults.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateModelsHandler({ config })
  );

  server.registerTool(
    "delegate_cancel",
    {
      title: "Cancel a delegated job",
      description:
        "Cancels a queued, starting, or running delegate_task/delegate_submit job by id. " +
        "Starting/running jobs are aborted (their subprocess is killed); already-finished jobs " +
        "cannot be cancelled.",
      inputSchema: { job_id: JOB_ID_FIELD },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    createDelegateCancelHandler({ jobManager })
  );

  return server;
}
