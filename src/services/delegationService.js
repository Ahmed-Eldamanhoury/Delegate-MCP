import { createExecutionContext } from "../models/executionContext.js";
import * as defaultClaudeCliService from "./claudeCliService.js";

/**
 * Builds an ExecutionContext and submits the CLI invocation as a job. This is the single
 * path both delegate_task (which then awaits the job) and delegate_submit (which doesn't)
 * go through — JobManager is the only place execution state lives.
 * @param {{input: object, config: object, jobManager: import("./jobManager.js").JobManager, toolName: string, service?: typeof defaultClaudeCliService}} args
 * @returns {string} job id
 */
export function submitDelegation({ input, config, jobManager, toolName, service = defaultClaudeCliService }) {
  const context = createExecutionContext(input, config);

  return jobManager.submit(
    (signal, markRunning) => service.invoke(input.prompt, context, config, { signal, onSpawn: markRunning }),
    { tool: toolName, ...context.metadata }
  );
}
