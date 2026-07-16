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
import { createDelegateReplayHandler } from "../handlers/delegateReplayHandler.js";

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
 * Constructs the single, shared `EventHistoryStore` per `config.eventHistory` (ADR-0006),
 * mirroring `selectJobStore`'s shape: extracted as its own exported function so it's
 * unit-testable without constructing a full McpServer. This is the ONE construction point for
 * this stateless store (ponytail-audit finding: it used to be built twice -- once here, once
 * again inside `createObservabilityService` -- both gated on the identical condition and
 * pointed at the identical directory). `createMcpServer` calls this once and threads the single
 * resulting instance into both `wireEventHistoryIfEnabled` (the write-side bridge) and
 * `createObservabilityService` (ReplayEngine's durable read tier). When `config.eventHistory`
 * is unset or `"memory"` this returns `undefined` -- default behavior stays byte-identical to
 * before this feature existed.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{warn: Function}} [logger]
 * @returns {ReturnType<typeof createEventHistoryStore>|undefined}
 */
export function selectEventHistoryStore(config, logger) {
  if (config.eventHistory !== "file") return undefined;
  return createEventHistoryStore({ dir: config.eventHistoryDir, logger });
}

/**
 * Wires an already-constructed `EventHistoryStore` into the write-side bus bridge (ADR-0006).
 * Gating now happens exactly once, in `createMcpServer`, when deciding whether to construct the
 * store at all (`selectEventHistoryStore`) -- this function no longer checks
 * `config.eventHistory` or builds its own store; it only uses whatever `eventHistoryStore` it's
 * given, so passing `undefined` (the default-config case) is a no-op.
 * @param {{bus: object, eventHistoryStore?: ReturnType<typeof createEventHistoryStore>, config: import("../config/index.js").DelegateConfig}} deps
 * @returns {(() => void)|undefined} unsubscribe, or undefined when eventHistoryStore is undefined
 */
export function wireEventHistoryIfEnabled({ bus, eventHistoryStore, config }) {
  if (!eventHistoryStore) return undefined;
  return wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: config.maxEventHistoryFiles });
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
  //
  // Task 5: the instance itself IS kept (returned below, alongside `server`) so its close()
  // (unsubscribe from the bus) is reachable during graceful shutdown -- previously constructed
  // here and immediately discarded, so close() was never callable from anywhere.

  // ADR-0006: EventHistoryStore is stateless and constructed exactly ONCE here, opt-in via
  // config.eventHistory (default "memory" = off, byte-identical to before this feature existed).
  // The single resulting instance is shared by both ObservabilityService's ReplayEngine durable
  // tier (below) and the write-side bridge (wireEventHistoryIfEnabled, further below) -- fixing
  // a ponytail-audit finding where each independently built its own instance over the identical
  // directory, under the identical gate.
  const eventHistoryStore = selectEventHistoryStore(config, logger);

  const observabilityService = createObservabilityService({
    bus,
    config,
    logger,
    maxTimelineHistory: config.maxJobHistory,
    eventHistoryStore,
  });

  wireEventHistoryIfEnabled({ bus, eventHistoryStore, config });

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

  // `eventHistoryStore` is exposed alongside `server`/`observabilityService` so it's reachable
  // for callers/tests that need it (e.g. proving it's the same instance the bridge and the
  // replay engine both use) -- undefined when config.eventHistory isn't "file", same as today.
  return { server, observabilityService, eventHistoryStore };
}
