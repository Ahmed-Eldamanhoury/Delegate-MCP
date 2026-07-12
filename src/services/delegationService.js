import { createExecutionContext } from "../models/executionContext.js";
import * as defaultClaudeCliService from "./claudeCliService.js";
import * as defaultWorkspaceManager from "./workspaceManager.js";

/**
 * Builds an ExecutionContext and submits the CLI invocation as a job. This is the single
 * path both delegate_task (which then awaits the job) and delegate_submit (which doesn't)
 * go through — JobManager is the only place execution state lives; the workspace layer is a
 * best-effort mirror taken at submit time and again once the job settles, never a second
 * source of truth.
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
    (signal, markRunning) => service.invoke(input.prompt, context, config, { signal, onSpawn: markRunning }),
    { tool: toolName, ...context.metadata }
  );

  workspace.createJobWorkspace(jobId, context, config, logger);

  // Fire-and-forget: JobManager already supports multiple independent waiters per job id, so
  // this doesn't interfere with delegate_task's own separate waitForCompletion() call below.
  jobManager
    .waitForCompletion(jobId)
    .then((job) => {
      workspace.persistJobArtifacts(jobId, job, config, logger);
      workspace.pruneWorkspaces(config, logger);
    })
    .catch(() => {}); // only rejects for an unknown job id, which can't happen for one we just submitted

  return jobId;
}
