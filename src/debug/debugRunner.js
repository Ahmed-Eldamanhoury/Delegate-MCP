/**
 * Runs INSIDE the visible terminal window Debug Mode opens (see
 * src/services/debugTerminalLauncher.js). Invoked as:
 *   node debugRunner.js <path-to-invocation.json>
 *
 * Deliberately takes only a file path as its argv — never the prompt itself — so nothing here
 * ever appears on a command line a shell could re-parse (see debugTerminalLauncher.js's own
 * header comment for the full reasoning). The prompt is read from `invocation.json`, written by
 * claudeCliService.js's debug branch before this process is launched.
 *
 * Reuses the exact same production building blocks (`buildArgs`, `buildExecOptions`,
 * `spawnAndCollect`, `parseResult`) — this file adds only: visible banner output, tee-ing
 * stdout/stderr to log files, and writing stream.jsonl/response.json/metadata.json. It is not
 * a second implementation of CLI invocation, only a differently-observed one.
 *
 * `runDebugJob()` is exported (with injectable `spawnAndCollectFn`) purely so its logic is
 * unit-testable without a real subprocess — a real `claude`-shaped executable can't be stood in
 * for by a plain `node.exe` in tests, since `buildArgs()`'s output always starts with `"-p"`,
 * which node.exe would immediately interpret as its own `--print` flag. `main()` below is the
 * only thing that actually runs when this file is launched for real.
 */
import { readFileSync, writeFileSync, appendFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildArgs, buildExecOptions, spawnAndCollect, parseResult } from "../services/claudeCliService.js";
import { parseStreamJsonChunk } from "../services/streamJsonParser.js";

/**
 * @param {object} invocation parsed invocation.json content
 * @param {{spawnAndCollectFn?: typeof spawnAndCollect, now?: () => string}} [deps]
 * @returns {Promise<{outcome: object, banner: string, commandDisplay: string}>}
 */
export async function runDebugJob(invocation, { spawnAndCollectFn = spawnAndCollect, now = () => new Date().toISOString() } = {}) {
  const {
    jobId,
    prompt,
    model,
    effort,
    workingDirectory,
    allowedTools,
    trustAll,
    maxBudgetUsd,
    claudeBin,
    maxBufferBytes,
    timeoutMs,
    logsDir,
  } = invocation;

  // `environment` was never written to invocation.json (matches context.json's redaction
  // principle) — this process inherits the real environment naturally, since it was itself
  // spawned (via the visible terminal) from the MCP server process, which spawns with env
  // inherited by default, exactly mirroring createExecutionContext()'s `environment: process.env`.
  const context = {
    model,
    effort,
    workingDirectory,
    allowedTools,
    trustAll,
    maxBudgetUsd,
    timeoutMs,
    environment: process.env,
  };
  const config = { claudeBin, maxBufferBytes };
  const args = buildArgs(prompt, context);
  const { cwd, env, timeout } = buildExecOptions(context, config);

  const commandDisplay = [claudeBin, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
  const banner = [
    "==================== Claude Delegate MCP — Debug Mode ====================",
    `job id:            ${jobId}`,
    `command:           ${commandDisplay}`,
    `working directory: ${cwd}`,
    `model:              ${model}`,
    `tools:              ${trustAll ? "(bypassPermissions — trust_all)" : allowedTools}`,
    `budget:            $${maxBudgetUsd}`,
    "============================================================================",
    "",
  ].join("\n");
  process.stdout.write(banner);
  writeFileSync(join(logsDir, "command.txt"), commandDisplay + "\n");

  const stdoutLogStream = createWriteStream(join(logsDir, "stdout.log"));
  const stderrLogStream = createWriteStream(join(logsDir, "stderr.log"));
  const streamJsonlPath = join(logsDir, "stream.jsonl");
  let streamRemainder = "";
  let resultLine = null;

  function onStdout(chunk) {
    process.stdout.write(chunk);
    stdoutLogStream.write(chunk);
    const parsed = parseStreamJsonChunk(streamRemainder, chunk.toString());
    streamRemainder = parsed.remainder;
    for (const obj of parsed.objects) {
      appendFileSync(streamJsonlPath, JSON.stringify({ timestamp: now(), event: obj }) + "\n");
      if (obj.type === "result") resultLine = obj;
    }
    // malformed lines are silently skipped here too, same as production's tracker.
  }

  function onStderr(chunk) {
    process.stderr.write(chunk);
    stderrLogStream.write(chunk);
  }

  const startedAt = now();
  let outcome;
  try {
    const { raw, exitCode, stderr } = await spawnAndCollectFn(
      claudeBin,
      args,
      { cwd, env, timeout },
      { maxBufferBytes, onStdout, onStderr }
    );
    outcome = parseResult(resultLine ? JSON.stringify(resultLine) : raw, exitCode, stderr);
  } catch (err) {
    outcome = parseResult("", typeof err?.code === "number" ? err.code : 1, err?.message ?? String(err));
    outcome.error = err?.message ?? String(err);
  }
  const finishedAt = now();

  // createWriteStream()'s writes are buffered/async — without waiting for both streams to
  // actually finish, stdout.log/stderr.log could be truncated or not yet exist on disk by the
  // time this process exits (a real risk, not just a test-timing artifact).
  await Promise.all(
    [stdoutLogStream, stderrLogStream].map(
      (stream) =>
        new Promise((resolve, reject) => {
          stream.end((err) => (err ? reject(err) : resolve()));
        })
    )
  );

  writeFileSync(join(logsDir, "response.json"), JSON.stringify(outcome, null, 2));
  writeFileSync(join(logsDir, "metadata.json"), JSON.stringify({ jobId, startedAt, finishedAt, exitCode: outcome.exitCode }, null, 2));

  process.stdout.write(`\n==================== job ${jobId} finished (exit ${outcome.exitCode}) ====================\n`);
  return { outcome, banner, commandDisplay };
}

async function main() {
  const invocationPath = process.argv[2];
  if (!invocationPath) {
    process.stderr.write("debugRunner: missing invocation.json path argument\n");
    process.exit(1);
  }
  const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
  await runDebugJob(invocation);

  // The terminal host (cmd's `start`, wt's new-tab, ...) closes this window the instant this
  // process exits — verified live: a fast-failing job's output otherwise vanishes before it
  // can be read. Only in the real script path (never in runDebugJob() itself, so tests stay
  // non-interactive) and only when actually attached to a real terminal.
  if (process.stdin.isTTY) {
    process.stdout.write("\nPress Enter to close this window...\n");
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", resolve);
    });
  }
}

// Only run for real when this file is executed directly (`node debugRunner.js ...`), not when
// imported by tests. pathToFileURL() handles Windows drive-letter/slash conventions correctly,
// unlike a manual string comparison would.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`debugRunner: fatal error: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
