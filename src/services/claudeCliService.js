import { execFile, spawn } from "node:child_process";
import { MODEL_FALLBACKS } from "../config/index.js";
import { EVENT_TYPES } from "../models/runtimeEvent.js";
import { parseStreamJsonChunk, classifyStreamJsonEvent } from "./streamJsonParser.js";
import { invokeInDebugMode } from "./debugInvoke.js";

/**
 * Builds the argv array for `claude -p ...`. Pure function — no I/O — so it's unit-testable
 * without spawning a real process.
 *
 * `--output-format stream-json` (requires `--verbose`, confirmed via a real CLI invocation —
 * omitting it errors with "requires --verbose") activated in ADR-0002 Phase 4 after real
 * protocol capture confirmed the terminal `type:"result"` line is field-for-field identical
 * to the previous non-streaming `--output-format json`'s single output — see the ADR's
 * "Observed protocol" section for the full evidence.
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
    "stream-json",
    "--verbose",
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

/**
 * Exported (in addition to being used by `invoke()`) so the debug-mode runner can produce the
 * exact same result shape from within its own process — see `src/debug/debugRunner.js`. Pure,
 * no behavior change.
 */
export function parseResult(raw, exitCode, stderr) {
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
 * @param {{bus?: object, jobId?: string, onSpawn?: () => void, maxBufferBytes: number, onStdout?: (chunk: Buffer) => void, onStderr?: (chunk: Buffer) => void}} opts
 *   `onStdout`/`onStderr`, if given, are called with each raw chunk in addition to (not instead
 *   of) OutputChunk publishing — used by `invoke()` to layer claude-specific stream-json
 *   parsing on top, and by the debug-mode runner (`src/debug/debugRunner.js`) to tee both
 *   streams to log files, without this function knowing anything about JSON or files.
 * @returns {Promise<{raw: string, exitCode: number, stderr: string}>}
 */
export function spawnAndCollect(bin, args, spawnOptions, { bus, jobId, onSpawn, maxBufferBytes, onStdout, onStderr }) {
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
      onStdout?.(chunk);
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
      onStderr?.(chunk);
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
 * Incrementally parses claude's `stream-json` stdout and publishes JobProgress for the two
 * event categories confirmed useful by a real successful-task capture (ADR-0002 Phase 1–2):
 * `system/thinking_tokens` (live token-count ticks during extended thinking) and `assistant`
 * events carrying a `text` content block. Deliberately does NOT surface: hook/session
 * bookkeeping (`system/hook_started`, `system/init`), rate-limit telemetry
 * (`rate_limit_event`), or the model's raw `thinking` content itself (verbose, arguably
 * private reasoning — `thinking_tokens` already gives a real progress signal for that phase
 * without exposing the content). Nothing here is synthesized; every branch corresponds to a
 * `type`/`subtype` actually observed in a real capture.
 *
 * A single logical turn can span multiple `assistant` lines (one per content block, sharing
 * `message.id`) — this doesn't try to reassemble them into a full message; each is treated as
 * an independent progress tick, since the complete final answer is always available via the
 * terminal `result` line regardless. The type/subtype classification itself lives in
 * `classifyStreamJsonEvent()` (streamJsonParser.js) so debug mode's file-tail consumer can
 * reuse the exact same decision without duplicating it.
 */
export function createStreamJsonTracker({ bus, jobId }) {
  let remainder = "";
  let resultLine = null;

  function publishProgress(payload) {
    bus?.publish({ type: EVENT_TYPES.JOB_PROGRESS, jobId, payload });
  }

  function onChunk(chunk) {
    const parsed = parseStreamJsonChunk(remainder, chunk.toString());
    remainder = parsed.remainder;

    for (const obj of parsed.objects) {
      if (obj.type === "result") {
        resultLine = obj;
        continue;
      }
      const progress = classifyStreamJsonEvent(obj);
      if (progress) publishProgress(progress);
      // malformed lines (parsed.malformedLines) and any other type are silently skipped —
      // graceful recovery, per ADR-0002 Phase 4.
    }
  }

  /** @returns {string|null} the terminal result line's original JSON text, or null if none was seen */
  function getResultRaw() {
    return resultLine ? JSON.stringify(resultLine) : null;
  }

  return { onChunk, getResultRaw };
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
 * @param {{signal?: AbortSignal, onSpawn?: () => void, bus?: object, jobId?: string, debugLaunchFn?: Function}} [opts]
 *   onSpawn fires once the OS has actually started the subprocess (Node's 'spawn' event) —
 *   used to mark a job "running" rather than merely "starting". `bus`/`jobId`, if given,
 *   publish OutputChunk and JobProgress events (ADR-0002) as stdout/stderr arrive — both
 *   optional so invoke() remains usable standalone (e.g. in tests) without a JobManager/bus.
 *   `debugLaunchFn` is test-only dependency injection for Debug Mode's terminal-launch step
 *   (see debugTerminalLauncher.js's `launchDebugTerminal`) — never used in production, where
 *   `config.debugMode` is false by default.
 * @returns {Promise<{raw: string, parsed: import("../models/schemas.js").ClaudeCliResult | null, exitCode: number, stderr: string}>}
 */
export async function invoke(prompt, context, config, { signal, onSpawn, bus, jobId, debugLaunchFn } = {}) {
  // Development-only, opt-in (DELEGATE_DEBUG=true) and additive: everything below this branch
  // — the normal hidden-pipe spawn, its event publishing, cancellation, buffer limits — is
  // completely unchanged and still runs when config.debugMode is false/absent, which is the
  // default. A jobId is required (debug artifacts live under workspace/jobs/<job-id>/logs/);
  // without one (e.g. invoke() called standalone in a test) this falls through to production
  // behavior same as always.
  if (config.debugMode && jobId) {
    return invokeInDebugMode(prompt, context, config, { onSpawn, bus, jobId, launchFn: debugLaunchFn });
  }

  const args = buildArgs(prompt, context);
  const { cwd, env, timeout } = buildExecOptions(context, config);
  const tracker = createStreamJsonTracker({ bus, jobId });

  const { raw, exitCode, stderr } = await spawnAndCollect(
    config.claudeBin,
    args,
    { cwd, env, timeout, signal },
    { bus, jobId, onSpawn, maxBufferBytes: config.maxBufferBytes, onStdout: tracker.onChunk }
  );
  // The terminal result line (field-for-field identical to the old non-streaming
  // --output-format json output — confirmed via real capture) is what parseResult() expects,
  // not the full multi-line stream. Falls back to the raw accumulated stdout if no result
  // line was ever captured (e.g. a crash mid-stream) — parseResult()'s existing try/catch
  // already handles that gracefully (parsed: null), no special-casing needed.
  return parseResult(tracker.getResultRaw() ?? raw, exitCode, stderr);
}
