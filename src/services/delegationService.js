import { createExecutionContext } from "../models/executionContext.js";
import * as defaultClaudeCliService from "./claudeCliService.js";
import * as defaultWorkspaceManager from "./workspaceManager.js";

/**
 * Builds an ExecutionContext and submits the CLI invocation as a job. This is the single
 * path both delegate_task (which then awaits the job) and delegate_submit (which doesn't)
 * go through — JobManager is the only place execution state lives.
 *
 * `createJobWorkspace()` is called directly here (not via the RuntimeEventBus, unlike
 * terminal-side persistence — see workspaceEventBridge.js) because it needs the full
 * ExecutionContext, including `environment` (`process.env`). That must never be duplicated
 * into JobManager's job record: `job.metadata` is returned verbatim in `delegate_status`'s
 * MCP response, so storing raw env vars there would leak secrets through the protocol — the
 * exact leak ADR-0001's `context.json` redaction exists to prevent at the disk layer. This is
 * the one place in the pipeline that legitimately holds the unredacted context, so it's the
 * one place workspace creation is called directly rather than reconstructed from a
 * (deliberately lean) event payload or the job record.
 *
 * OutputChunk events (ADR-0002) are published through `jobManager.bus` — the same shared bus
 * JobManager itself publishes lifecycle events on — so `claudeCliService.invoke()` doesn't
 * need its own separately-wired bus reference.
 * @param {{input: object, config: object, jobManager: import("./jobManager.js").JobManager, toolName: string, logger?: object, service?: typeof defaultClaudeCliService, workspace?: typeof defaultWorkspaceManager}} args
 * @returns {string} job id
 */
export function submitDelegation({
  input,
  config,
  jobManager,
  toolName,
  logger,
  service = defaultClaudeCliService,
  workspace = defaultWorkspaceManager,
}) {
  const context = createExecutionContext(input, config);

  const jobId = jobManager.submit(
    (signal, markRunning, jobId) =>
      service.invoke(input.prompt, context, config, { signal, onSpawn: markRunning, bus: jobManager.bus, jobId }),
    { tool: toolName, ...context.metadata }
  );

  workspace.createJobWorkspace(jobId, context, config, logger);

  return jobId;
}
