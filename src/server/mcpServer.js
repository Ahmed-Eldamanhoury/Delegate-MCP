import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DelegateTaskInputShape } from "../models/schemas.js";
import { JOB_STATUS } from "../models/job.js";
import { createDelegationBackend } from "../services/delegationBackend.js";
import { createDelegateTaskHandler } from "../handlers/delegateTaskHandler.js";
import { createDelegateSubmitHandler } from "../handlers/delegateSubmitHandler.js";
import { createDelegateStatusHandler } from "../handlers/delegateStatusHandler.js";
import { createDelegateHistoryHandler } from "../handlers/delegateHistoryHandler.js";
import { createDelegateModelsHandler } from "../handlers/delegateModelsHandler.js";
import { createDelegateCancelHandler } from "../handlers/delegateCancelHandler.js";
import { createDelegateReplayHandler } from "../handlers/delegateReplayHandler.js";
import { createDelegateMetricsHandler } from "../handlers/delegateMetricsHandler.js";
import { createDelegateSnapshotHandler } from "../handlers/delegateSnapshotHandler.js";

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
 * @param {{config: import("../config/index.js").DelegateConfig, logger: ReturnType<import("../logging/logger.js").createLogger>, version: string}} deps
 */
export function createMcpServer({ config, logger, version }) {
  const server = new McpServer({ name: "claude-delegate", version });

  // WP0 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §4): every construction step that used to be
  // inlined here (bus, jobManager, workspace wiring, eventHistoryStore, observabilityService,
  // eventHistory bridge, delegationService) now lives in the transport-agnostic
  // createDelegationBackend() -- `restEntry.js` calls the exact same function independently.
  // Zero new logic, same relative construction order as before, just wrapped in one call.
  const { jobManager, observabilityService, delegationService, eventHistoryStore } = createDelegationBackend({
    config,
    logger,
  });

  server.registerTool(
    "delegate_task",
    {
      title: "Delegate task to a Claude Code subagent",
      description: TASK_DESCRIPTION,
      inputSchema: DelegateTaskInputShape,
    },
    createDelegateTaskHandler({ logger, jobManager, delegationService })
  );

  server.registerTool(
    "delegate_submit",
    {
      title: "Submit a task to a Claude Code subagent (non-blocking)",
      description: SUBMIT_DESCRIPTION,
      inputSchema: DelegateTaskInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    createDelegateSubmitHandler({ logger, delegationService })
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
    createDelegateStatusHandler({ delegationService })
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
    createDelegateHistoryHandler({ delegationService })
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
    createDelegateCancelHandler({ delegationService })
  );

  server.registerTool(
    "delegate_replay",
    {
      title: "Replay a delegated job's event history",
      description:
        "Reconstructs a delegate_task/delegate_submit job's event history for viewing -- read-only, " +
        "never re-executes anything. Returns the richest available source: 'runtime' (live, in-memory, " +
        "full fidelity), 'durable' (on-disk full fidelity, only if CLAUDE_DELEGATE_EVENT_HISTORY=file " +
        "was enabled), 'workspace' (coarse lifecycle summary), or 'unavailable'.",
      inputSchema: { job_id: JOB_ID_FIELD },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateReplayHandler({ observabilityService })
  );

  server.registerTool(
    "delegate_metrics",
    {
      title: "Get delegation service metrics",
      description:
        "Returns real-time metrics on job execution, queue depth, and workspace usage — read-only, " +
        "no input required.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateMetricsHandler({ observabilityService })
  );

  server.registerTool(
    "delegate_snapshot",
    {
      title: "Get a delegation service snapshot",
      description:
        "Returns a point-in-time snapshot of delegation service state -- metrics plus the list of " +
        "currently active (non-terminal) jobs -- read-only, no input required.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    createDelegateSnapshotHandler({ observabilityService })
  );

  // `eventHistoryStore` is exposed alongside `server`/`observabilityService` so it's reachable
  // for callers/tests that need it (e.g. proving it's the same instance the bridge and the
  // replay engine both use) -- undefined when config.eventHistory isn't "file", same as today.
  return { server, observabilityService, eventHistoryStore };
}
