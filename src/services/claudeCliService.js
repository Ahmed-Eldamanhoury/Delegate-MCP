import { execFile, spawn } from "node:child_process";
import { MODEL_FALLBACKS } from "../config/index.js";
import { EVENT_TYPES } from "../models/runtimeEvent.js";

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

function parseResult(raw, exitCode, stderr) {
  try {
    return { raw, parsed: JSON.parse(raw), exitCode, stderr };
  } catch {
    return { raw, parsed: null, exitCode, stderr };
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
 * Transport-level spawn+stream mechanics, decoupled from `buildArgs`'s claude-specific argv
 * (ADR-0002 explicitly frames these as separate layers) — this is what makes it possible to
 * unit-test real `spawn()` behavior (abort, timeout, maxBuffer, ENOENT, ...) against an
 * arbitrary executable, not just `claude.exe`. Migrated from `execFile` to `spawn` (ADR-0002
 * Phase 3) for incremental stdout/stderr access; error semantics preserved exactly — see
 * tests/claudeCliService.test.js and tests/claudeCliServiceSpawn.test.js for the behavioral
 * pins this migration must not break.
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?: string, env?: object, timeout?: number, signal?: AbortSignal}} spawnOptions
 * @param {{bus?: object, jobId?: string, onSpawn?: () => void, maxBufferBytes: number}} opts
 * @returns {Promise<{raw: string, exitCode: number, stderr: string}>}
 */
export function spawnAndCollect(bin, args, spawnOptions, { bus, jobId, onSpawn, maxBufferBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, spawnOptions);

    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let bufferExceeded = false;
    let capturedError = null;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const publishChunk = (stream, chunk) => {
      if (!bus) return;
      bus.publish({
        type: EVENT_TYPES.OUTPUT_CHUNK,
        jobId,
        payload: { stream, chunk: chunk.toString(), timestamp: new Date().toISOString() },
      });
    };

    const onStdoutData = (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        bufferExceeded = true;
        child.kill();
        return;
      }
      stdout += chunk;
      publishChunk("stdout", chunk);
    };
    const onStderrData = (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) {
        bufferExceeded = true;
        child.kill();
        return;
      }
      stderr += chunk;
      publishChunk("stderr", chunk);
    };
    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);

    const detachStreams = () => {
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
    };

    // Node emits 'error' for abort/spawn-failure (ENOENT, EACCES, ...) and *always* still
    // emits 'close' afterwards — settle once, in whichever handler has enough information.
    child.once("error", (err) => {
      capturedError = err;
      if (err.name !== "AbortError") return; // ENOENT etc: settle in 'close', once exitCode/signal are known too
      if (shouldCleanupProcessTree(process.platform, err)) killWindowsProcessTree(child.pid);
      detachStreams();
      settleReject(err);
    });

    child.once("close", (code, signal_) => {
      detachStreams();
      if (settled) return; // already handled by the AbortError branch above

      if (capturedError) {
        if (shouldCleanupProcessTree(process.platform, capturedError)) killWindowsProcessTree(child.pid);
        return settleReject(capturedError);
      }

      const killed = bufferExceeded || signal_ !== null;
      if (killed && shouldCleanupProcessTree(process.platform, { killed: true })) {
        killWindowsProcessTree(child.pid);
      }

      if (code === 0 && !killed) {
        return settleResolve({ raw: stdout, exitCode: 0, stderr });
      }

      // claude -p exits non-zero on task failure but still prints JSON on stdout — same as a
      // timeout/maxBuffer kill mid-way through a run that had already produced output.
      if (!stdout) {
        const message = bufferExceeded
          ? "claude CLI output exceeded maxBufferBytes"
          : `claude CLI exited with code ${code}${signal_ ? ` (signal ${signal_})` : ""}`;
        return settleReject(Object.assign(new Error(message), { code: code ?? 1, signal: signal_ }));
      }
      return settleResolve({ raw: stdout, exitCode: typeof code === "number" ? code : 1, stderr });
    });

    if (onSpawn) child.once("spawn", onSpawn);
  });
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
 * @param {{signal?: AbortSignal, onSpawn?: () => void, bus?: object, jobId?: string}} [opts]
 *   onSpawn fires once the OS has actually started the subprocess (Node's 'spawn' event) —
 *   used to mark a job "running" rather than merely "starting". `bus`/`jobId`, if given,
 *   publish OutputChunk events (ADR-0002) as stdout/stderr arrive — both optional so invoke()
 *   remains usable standalone (e.g. in tests) without a JobManager/bus in the picture.
 * @returns {Promise<{raw: string, parsed: import("../models/schemas.js").ClaudeCliResult | null, exitCode: number, stderr: string}>}
 */
export async function invoke(prompt, context, config, { signal, onSpawn, bus, jobId } = {}) {
  const args = buildArgs(prompt, context);
  const { cwd, env, timeout } = buildExecOptions(context, config);

  const { raw, exitCode, stderr } = await spawnAndCollect(
    config.claudeBin,
    args,
    { cwd, env, timeout, signal },
    { bus, jobId, onSpawn, maxBufferBytes: config.maxBufferBytes }
  );
  return parseResult(raw, exitCode, stderr);
}
