import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// The real executable, not the claude.cmd shim — spawning it directly needs no shell,
// which is what keeps arbitrary `prompt` text from ever being interpreted by cmd.exe.
// Derived from %APPDATA% (npm's default global install root on Windows) rather than a
// hardcoded path, so this resolves correctly for whichever machine/user runs it. %APPDATA%
// only exists on Windows — elsewhere, fall back to the bare command name (PATH-resolved).
// The .cmd-shim/shell risk this whole file exists to avoid is Windows-specific: non-Windows
// npm global shims are plain executable scripts, so spawning "claude" via PATH lookup here
// never needs shell:true the way a Windows .cmd shim would.
const DEFAULT_BIN = process.env.APPDATA
  ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
  : "claude";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_ROOT, "workspace");
const DEFAULT_JOB_STORE_DIR = join(PROJECT_ROOT, "job-store");

export const READONLY_TOOLS = "Read Grep Glob WebSearch WebFetch";

export const MODEL_FALLBACKS = {
  fable: "opus,sonnet",
  opus: "sonnet",
};

export const DEFAULT_MAX_BUDGET_USD = 1;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_MAX_JOB_HISTORY = 500;
export const DEFAULT_MAX_WORKSPACE_HISTORY = 100;

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
 * @property {string} workspaceRoot
 * @property {number} maxWorkspaceHistory
 * @property {"memory"|"file"} jobStore
 * @property {string} jobStoreDir
 * @property {boolean} debugMode
 */

/**
 * Development-only: when true, claudeCliService.invoke() additionally opens a visible terminal
 * running the real CLI invocation and writes full stream logs to
 * workspace/jobs/<job-id>/logs/. Off by default; absent/anything-but-"true" leaves production
 * behavior byte-identical to before this existed — see docs/ARCHITECTURE.md's Debug Mode
 * section.
 */
export const DEBUG_MODE_ENV_VAR = "DELEGATE_DEBUG";

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
    workspaceRoot: env.CLAUDE_DELEGATE_WORKSPACE_DIR || DEFAULT_WORKSPACE_ROOT,
    maxWorkspaceHistory:
      Number(env.CLAUDE_DELEGATE_MAX_WORKSPACE_HISTORY) || DEFAULT_MAX_WORKSPACE_HISTORY,
    jobStore: env.CLAUDE_DELEGATE_JOB_STORE || "memory",
    jobStoreDir: env.CLAUDE_DELEGATE_JOB_STORE_DIR || DEFAULT_JOB_STORE_DIR,
    debugMode: env[DEBUG_MODE_ENV_VAR] === "true",
  });
}
