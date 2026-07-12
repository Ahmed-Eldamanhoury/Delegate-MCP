// The real executable, not the claude.cmd shim — spawning it directly needs no shell,
// which is what keeps arbitrary `prompt` text from ever being interpreted by cmd.exe.
const DEFAULT_BIN =
  "C:\\Users\\REDACTED_USER\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

export const READONLY_TOOLS = "Read Grep Glob WebSearch WebFetch";

export const MODEL_FALLBACKS = {
  fable: "opus,sonnet",
  opus: "sonnet",
};

export const DEFAULT_MAX_BUDGET_USD = 1;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_MAX_JOB_HISTORY = 500;

/**
 * @typedef {Object} DelegateConfig
 * @property {string} claudeBin
 * @property {string} baseCwd
 * @property {Record<string,string>} modelFallbacks
 * @property {number} defaultMaxBudgetUsd
 * @property {number} spawnTimeoutMs
 * @property {number} maxBufferBytes
 * @property {number} maxConcurrentJobs
 * @property {number} maxJobHistory
 */

/** @param {NodeJS.ProcessEnv} env @returns {DelegateConfig} */
export function loadConfig(env = process.env) {
  return Object.freeze({
    claudeBin: env.CLAUDE_DELEGATE_BIN || DEFAULT_BIN,
    baseCwd: env.CLAUDE_DELEGATE_BASE_DIR || process.cwd(),
    modelFallbacks: MODEL_FALLBACKS,
    defaultMaxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    spawnTimeoutMs: 10 * 60 * 1000,
    maxBufferBytes: 20 * 1024 * 1024,
    maxConcurrentJobs: Number(env.CLAUDE_DELEGATE_MAX_CONCURRENT_JOBS) || DEFAULT_MAX_CONCURRENT_JOBS,
    maxJobHistory: Number(env.CLAUDE_DELEGATE_MAX_JOB_HISTORY) || DEFAULT_MAX_JOB_HISTORY,
  });
}
