import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DelegateTaskInputShape } from "../models/schemas.js";
import { JOB_STATUS } from "../models/job.js";
import { JobManager } from "../services/jobManager.js";
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

const JOB_ID_FIELD = z.string().describe("Job id, as returned by delegate_task or delegate_history.");

/**
 * @param {{config: import("../config/index.js").DelegateConfig, logger: ReturnType<import("../logging/logger.js").createLogger>, version: string}} deps
 */
export function createMcpServer({ config, logger, version }) {
  const server = new McpServer({ name: "claude-delegate", version });
  const jobManager = new JobManager({
    maxConcurrent: config.maxConcurrentJobs,
    maxHistory: config.maxJobHistory,
    logger,
  });

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
        "Looks up a delegate_task job by id: current status, timestamps, runtime, cost, and the " +
        "full result once it has finished.",
      inputSchema: { job_id: JOB_ID_FIELD },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateStatusHandler({ jobManager })
  );

  server.registerTool(
    "delegate_history",
    {
      title: "List recent delegated jobs",
      description: "Lists recent delegate_task jobs, most recent first, with status/cost summaries.",
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
        "Cancels a queued or running delegate_task job by id. Running jobs are aborted (their " +
        "subprocess is killed); already-finished jobs cannot be cancelled.",
      inputSchema: { job_id: JOB_ID_FIELD },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    createDelegateCancelHandler({ jobManager })
  );

  return server;
}
