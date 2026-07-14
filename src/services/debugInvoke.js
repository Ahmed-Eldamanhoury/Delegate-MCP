/**
 * Development-only execution path for `claudeCliService.invoke()`, active only when
 * `config.debugMode` is true (`DELEGATE_DEBUG=true`) — see docs/ARCHITECTURE.md's Debug Mode
 * section. Runs the real CLI invocation inside a visible terminal window
 * (`debugTerminalLauncher.js` + `src/debug/debugRunner.js`) instead of a hidden pipe-captured
 * subprocess, and writes a full log set to `workspace/jobs/<job-id>/logs/`.
 *
 * Known limitation, documented rather than silently glossed over: because the actual `claude`
 * subprocess is owned by a detached runner process (so the debug session survives if the MCP
 * server restarts mid-run), `delegate_cancel` cannot forcibly kill it the way production's
 * AbortController does — cancelling here only stops this function from waiting, it does not
 * close the visible terminal or its subprocess.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceRoot } from "./workspaceManager.js";
import { launchDebugTerminal } from "./debugTerminalLauncher.js";
import { classifyStreamJsonEvent } from "./streamJsonParser.js";
import { EVENT_TYPES } from "../models/runtimeEvent.js";

const RUNNER_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "debug", "debugRunner.js");
const POLL_INTERVAL_MS = 200;

/**
 * @param {string} prompt
 * @param {import("../models/executionContext.js").ExecutionContext} context
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{onSpawn?: () => void, bus?: object, jobId: string, launchFn?: typeof launchDebugTerminal}} opts
 * @returns {Promise<{raw: string, parsed: object|null, exitCode: number, stderr: string}>}
 */
export async function invokeInDebugMode(prompt, context, config, { onSpawn, bus, jobId, launchFn = launchDebugTerminal } = {}) {
  const logsDir = join(getWorkspaceRoot(config), jobId, "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, "prompt.txt"), prompt);

  const invocation = {
    jobId,
    prompt,
    model: context.model,
    effort: context.effort,
    workingDirectory: context.workingDirectory,
    allowedTools: context.allowedTools,
    trustAll: context.trustAll,
    maxBudgetUsd: context.maxBudgetUsd,
    claudeBin: config.claudeBin,
    maxBufferBytes: config.maxBufferBytes,
    timeoutMs: context.timeoutMs,
    logsDir,
  };
  const invocationJsonPath = join(logsDir, "invocation.json");
  writeFileSync(invocationJsonPath, JSON.stringify(invocation, null, 2));

  launchFn({ runnerScriptPath: RUNNER_SCRIPT_PATH, invocationJsonPath, jobId });
  // The terminal-open request has been dispatched — this is debug mode's analogue of
  // production's real 'spawn' event (there is no direct child-process handle to confirm the
  // CLI itself has started, since it runs inside a separately-launched, detached window).
  onSpawn?.();

  const responsePath = join(logsDir, "response.json");
  const streamJsonlPath = join(logsDir, "stream.jsonl");
  const deadline = Date.now() + (context.timeoutMs ?? 10 * 60 * 1000);
  let streamBytesRead = 0;
  let streamLineRemainder = "";

  function tailStreamJsonl() {
    if (!bus || !existsSync(streamJsonlPath)) return;
    const content = readFileSync(streamJsonlPath, "utf8");
    if (content.length <= streamBytesRead) return;
    const newText = streamLineRemainder + content.slice(streamBytesRead);
    streamBytesRead = content.length;
    const lines = newText.split("\n");
    streamLineRemainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // malformed line — same graceful skip as production
      }
      const progress = classifyStreamJsonEvent(entry.event ?? {});
      if (progress) bus.publish({ type: EVENT_TYPES.JOB_PROGRESS, jobId, payload: progress });
    }
  }

  while (Date.now() < deadline) {
    tailStreamJsonl();
    if (existsSync(responsePath)) {
      tailStreamJsonl(); // catch anything written between the last tail and completion
      return JSON.parse(readFileSync(responsePath, "utf8"));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const err = new Error(
    `Debug Mode job ${jobId} timed out waiting for the visible terminal to finish (no response.json after ${context.timeoutMs}ms). ` +
      "The claude process may still be running in its terminal window — Debug Mode cannot close it remotely."
  );
  err.code = "DEBUG_TIMEOUT";
  throw err;
}
