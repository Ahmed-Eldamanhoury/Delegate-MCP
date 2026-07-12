/**
 * @typedef {Object} ExecutionContext
 * @property {string} model
 * @property {string} effort
 * @property {number} timeoutMs
 * @property {string} workingDirectory
 * @property {string} allowedTools
 * @property {boolean} trustAll
 * @property {number} maxBudgetUsd
 * @property {Record<string, unknown>} metadata
 * @property {NodeJS.ProcessEnv} environment
 */

/**
 * Built once per delegated call from tool input + server config. Both delegate_task and
 * delegate_submit build one of these and hand it to claudeCliService — the CLI service never
 * sees raw tool-input field names, only this. Future execution-related features (retry
 * policy, per-call env overrides, etc.) should be added here, not threaded through handlers.
 * @param {{prompt: string, model: string, effort: string, allowed_tools: string, trust_all: boolean, max_budget_usd: number, cwd?: string}} input
 * @param {import("../config/index.js").DelegateConfig} config
 * @returns {ExecutionContext}
 */
export function createExecutionContext(input, config) {
  return Object.freeze({
    model: input.model,
    effort: input.effort,
    timeoutMs: config.spawnTimeoutMs,
    workingDirectory: input.cwd || config.baseCwd,
    allowedTools: input.allowed_tools,
    trustAll: input.trust_all,
    maxBudgetUsd: input.max_budget_usd,
    metadata: {
      model: input.model,
      effort: input.effort,
      promptPreview: input.prompt.slice(0, 120),
    },
    environment: process.env,
  });
}
