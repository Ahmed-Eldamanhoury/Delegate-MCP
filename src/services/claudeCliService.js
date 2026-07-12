import { execFile } from "node:child_process";
import { MODEL_FALLBACKS } from "../config/index.js";

/**
 * Builds the argv array for `claude -p ...`. Pure function — no I/O — so it's unit-testable
 * without spawning a real process.
 * @param {string} prompt
 * @param {import("../models/executionContext.js").ExecutionContext} context
 * @returns {string[]}
 */
export function buildArgs(prompt, context) {
  const args = [
    "-p",
    prompt,
    "--model",
    context.model,
    "--effort",
    context.effort,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--max-budget-usd",
    String(context.maxBudgetUsd),
  ];

  const fallback = MODEL_FALLBACKS[context.model];
  if (fallback) {
    args.push("--fallback-model", fallback);
  }

  if (context.trustAll) {
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--allowedTools", context.allowedTools);
  }

  return args;
}

function parseResult(raw, exitCode) {
  try {
    return { raw, parsed: JSON.parse(raw), exitCode };
  } catch {
    return { raw, parsed: null, exitCode };
  }
}

/**
 * Windows has no POSIX process groups, so killing `claude.exe` (via AbortSignal or the
 * `timeout` option) does not kill any child process *it* spawned (e.g. a Bash tool call
 * still running) — that would be an orphaned, leaked process. Pure predicate so the decision
 * is unit-testable without actually spawning/killing anything.
 * @param {NodeJS.Platform} platform
 * @param {{name?: string, killed?: boolean}|null|undefined} err
 */
export function shouldCleanupProcessTree(platform, err) {
  return platform === "win32" && Boolean(err) && (err.name === "AbortError" || err.killed === true);
}

/** Best-effort: kill the whole process tree rooted at pid. Errors are ignored — this is cleanup, not the primary result. */
function killWindowsProcessTree(pid) {
  if (!pid) return;
  execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {});
}

/**
 * Pure so config.maxBufferBytes actually flowing through is unit-testable without spawning
 * a real process (this was previously duplicated as a hardcoded local constant, silently
 * ignoring config.maxBufferBytes entirely).
 * @param {import("../models/executionContext.js").ExecutionContext} context
 * @param {import("../config/index.js").DelegateConfig} config
 */
export function buildExecOptions(context, config) {
  return {
    cwd: context.workingDirectory,
    env: context.environment,
    maxBuffer: config.maxBufferBytes,
    timeout: context.timeoutMs,
  };
}

/**
 * Spawns `claude -p` and resolves with the parsed JSON result.
 *
 * `config.claudeBin` must point at the real executable (e.g. claude.exe), not the .cmd/.bat
 * shim — spawning without a shell means `prompt` (arbitrary, caller-controlled text) is
 * passed as a literal argv entry and never interpreted by cmd.exe/sh, so it can't be used
 * for command injection regardless of what characters it contains.
 * @param {string} prompt
 * @param {import("../models/executionContext.js").ExecutionContext} context
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{signal?: AbortSignal, onSpawn?: () => void}} [opts] onSpawn fires once the OS has
 *   actually started the subprocess (Node's 'spawn' event) — used to mark a job "running"
 *   rather than merely "starting".
 * @returns {Promise<{raw: string, parsed: import("../models/schemas.js").ClaudeCliResult | null, exitCode: number}>}
 */
export function invoke(prompt, context, config, { signal, onSpawn } = {}) {
  const args = buildArgs(prompt, context);

  return new Promise((resolve, reject) => {
    const child = execFile(
      config.claudeBin,
      args,
      { ...buildExecOptions(context, config), signal },
      (err, stdout) => {
        if (err) {
          if (shouldCleanupProcessTree(process.platform, err)) {
            killWindowsProcessTree(child.pid);
          }
          if (err.name === "AbortError") return reject(err);
          // claude -p exits non-zero on task failure but still prints JSON on stdout.
          if (!stdout) return reject(err);
          return resolve(parseResult(stdout, typeof err.code === "number" ? err.code : 1));
        }
        resolve(parseResult(stdout, 0));
      }
    );
    if (onSpawn) child.once("spawn", onSpawn);
  });
}
