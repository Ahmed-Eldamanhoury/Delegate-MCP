import { z } from "zod";
import { READONLY_TOOLS, DEFAULT_MAX_BUDGET_USD } from "../config/index.js";

// Single source of truth for the model/effort enums — previously duplicated verbatim in
// delegateModelsHandler.js, which now imports these instead of re-declaring them.
export const MODELS = ["haiku", "sonnet", "opus", "fable"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The structured data both delegate_models (MCP) and GET /v1/models (REST) list -- extracted from
 * delegateModelsHandler.js's former inline body (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §12).
 * Deliberately returns ONLY structured data, no MCP-specific text formatting: delegateModelsHandler.js
 * keeps its own thin text-line-per-model loop, built from this return value; REST's handleModels
 * returns this object as the JSON body directly.
 * @param {import("../config/index.js").DelegateConfig} config
 * @returns {{models: {model: string, fallback: string|null}[], efforts: string[], defaults: {model: string, effort: string, maxBudgetUsd: number}}}
 */
export function buildModelsInfo(config) {
  const models = MODELS.map((model) => ({
    model,
    fallback: config.modelFallbacks[model] ?? null,
  }));
  return {
    models,
    efforts: EFFORTS,
    defaults: { model: "sonnet", effort: "low", maxBudgetUsd: config.defaultMaxBudgetUsd },
  };
}

/**
 * Raw zod shape for the `delegate_task` tool input. Kept byte-for-byte identical to the
 * pre-refactor inline schema — the public MCP tool interface must not change.
 */
export const DelegateTaskInputShape = {
  prompt: z.string().describe("The task for the subagent to perform."),
  model: z
    .enum(MODELS)
    .default("sonnet")
    .describe("Which model tier runs this task. Default sonnet (cheap worker)."),
  effort: z
    .enum(EFFORTS)
    .default("low")
    .describe("Reasoning effort. Default low — raise only for genuinely hard tasks."),
  allowed_tools: z
    .string()
    .default(READONLY_TOOLS)
    .describe(
      'Space-separated tool allowlist pre-approved without prompting (e.g. "Read Grep Bash(git *)"). ' +
        "Defaults to read-only tools. Widen only for tasks that must edit files."
    ),
  trust_all: z
    .boolean()
    .default(false)
    .describe(
      "DANGEROUS: skip all permission checks instead of using allowed_tools. Only for a sandboxed cwd."
    ),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the subagent. Defaults to the MCP server's base directory."),
  max_budget_usd: z
    .number()
    .positive()
    .default(DEFAULT_MAX_BUDGET_USD)
    .describe("Hard spend cap for this single call, in USD. Must be greater than 0."),
};

export const DelegateTaskInputSchema = z.object(DelegateTaskInputShape);

/**
 * @typedef {Object} ClaudeCliResult
 * @property {string} type
 * @property {string} [subtype]
 * @property {boolean} [is_error]
 * @property {string} [result]
 * @property {number} [total_cost_usd]
 * @property {number} [num_turns]
 * @property {string} [session_id]
 */
