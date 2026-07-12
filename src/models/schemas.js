import { z } from "zod";
import { READONLY_TOOLS, DEFAULT_MAX_BUDGET_USD } from "../config/index.js";

/**
 * Raw zod shape for the `delegate_task` tool input. Kept byte-for-byte identical to the
 * pre-refactor inline schema — the public MCP tool interface must not change.
 */
export const DelegateTaskInputShape = {
  prompt: z.string().describe("The task for the subagent to perform."),
  model: z
    .enum(["haiku", "sonnet", "opus", "fable"])
    .default("sonnet")
    .describe("Which model tier runs this task. Default sonnet (cheap worker)."),
  effort: z
    .enum(["low", "medium", "high", "xhigh", "max"])
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
