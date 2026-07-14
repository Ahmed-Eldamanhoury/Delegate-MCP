import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { invokeInDebugMode } from "../src/services/debugInvoke.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function baseArgs(workspaceRoot, jobId) {
  const config = { workspaceRoot, claudeBin: "irrelevant.exe", maxBufferBytes: 1024 };
  const context = {
    model: "haiku",
    effort: "low",
    workingDirectory: "C:\\some\\cwd",
    allowedTools: "Read Grep",
    trustAll: false,
    maxBudgetUsd: 1,
    timeoutMs: 2000,
  };
  return { config, context };
}

test("creates workspace/jobs/<job-id>/logs/ with prompt.txt and invocation.json before launching", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-logs-created";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    let launchCalled = false;

    const launchFn = ({ invocationJsonPath }) => {
      launchCalled = true;
      // Simulate the runner writing a response almost immediately.
      const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
      writeFileSync(join(logsDir, "response.json"), JSON.stringify({ raw: "{}", parsed: {}, exitCode: 0, stderr: "" }));
      return { terminalKind: "cmd" };
    };

    await invokeInDebugMode("the real prompt text", context, config, { jobId, launchFn });

    assert.ok(launchCalled);
    const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
    assert.ok(existsSync(join(logsDir, "prompt.txt")));
    assert.equal(readFileSync(join(logsDir, "prompt.txt"), "utf8"), "the real prompt text");
    const invocation = JSON.parse(readFileSync(join(logsDir, "invocation.json"), "utf8"));
    assert.equal(invocation.jobId, jobId);
    assert.equal(invocation.prompt, "the real prompt text");
    assert.equal(invocation.model, "haiku");
    assert.equal(invocation.environment, undefined, "environment must never be written to disk");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("the launcher is never given the prompt text as part of its own arguments", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-no-prompt-leak";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    let capturedLaunchArgs = null;

    const launchFn = (launchArgs) => {
      capturedLaunchArgs = launchArgs;
      const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
      writeFileSync(join(logsDir, "response.json"), JSON.stringify({ raw: "{}", parsed: {}, exitCode: 0, stderr: "" }));
      return { terminalKind: "cmd" };
    };

    const SECRET = "SECRET_PROMPT_MARKER_MUST_NOT_LEAK";
    await invokeInDebugMode(SECRET, context, config, { jobId, launchFn });

    assert.equal(capturedLaunchArgs.jobId, jobId);
    assert.ok(!JSON.stringify(capturedLaunchArgs).includes(SECRET));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("onSpawn fires once the terminal-open request has been dispatched", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-onspawn";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    let onSpawnCalled = false;

    const launchFn = () => {
      const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
      writeFileSync(join(logsDir, "response.json"), JSON.stringify({ raw: "{}", parsed: {}, exitCode: 0, stderr: "" }));
      return { terminalKind: "cmd" };
    };

    await invokeInDebugMode("p", context, config, { jobId, launchFn, onSpawn: () => (onSpawnCalled = true) });
    assert.equal(onSpawnCalled, true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("returns response.json's content verbatim once it appears", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-response-shape";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    const expected = { raw: '{"result":"ok"}', parsed: { result: "ok" }, exitCode: 0, stderr: "" };

    const launchFn = () => {
      const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
      writeFileSync(join(logsDir, "response.json"), JSON.stringify(expected));
      return { terminalKind: "cmd" };
    };

    const result = await invokeInDebugMode("p", context, config, { jobId, launchFn });
    assert.deepEqual(result, expected);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("tails stream.jsonl and publishes JobProgress on the bus as new lines appear", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-stream-tail";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    const bus = createRuntimeEventBus();
    const progressEvents = [];
    bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progressEvents.push(e));

    const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
    const launchFn = () => {
      mkdirSync(logsDir, { recursive: true });
      // Simulate the runner writing stream.jsonl entries, then finishing shortly after.
      appendFileSync(
        join(logsDir, "stream.jsonl"),
        JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", event: { type: "system", subtype: "thinking_tokens", estimated_tokens: 10 } }) + "\n"
      );
      setTimeout(() => {
        appendFileSync(
          join(logsDir, "stream.jsonl"),
          JSON.stringify({
            timestamp: "2026-01-01T00:00:01.000Z",
            event: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
          }) + "\n"
        );
        writeFileSync(join(logsDir, "response.json"), JSON.stringify({ raw: "{}", parsed: {}, exitCode: 0, stderr: "" }));
      }, 250);
      return { terminalKind: "cmd" };
    };

    await invokeInDebugMode("p", context, config, { jobId, launchFn, bus });

    assert.equal(progressEvents.length, 2);
    assert.equal(progressEvents[0].payload.phase, "thinking");
    assert.equal(progressEvents[1].payload.phase, "responding");
    assert.equal(progressEvents[1].payload.progressMessage, "hello");
    assert.ok(progressEvents.every((e) => e.jobId === jobId));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("aborting an in-flight call rejects promptly with an AbortError-shaped error and writes the cancel.request sentinel", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-abort";
    const { config, context } = baseArgs(workspaceRoot, jobId); // timeoutMs: 2000
    const controller = new AbortController();

    const launchFn = () => ({ terminalKind: "cmd" }); // never writes response.json

    const start = Date.now();
    setTimeout(() => controller.abort(), 100);

    await assert.rejects(
      () => invokeInDebugMode("p", context, config, { jobId, launchFn, signal: controller.signal }),
      (err) => {
        assert.equal(err.name, "AbortError", "must reject with an AbortError-named error, matching production's err.name check");
        return true;
      }
    );

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1500, `must reject well before the 2000ms timeout budget, took ${elapsed}ms`);

    const logsDir = join(workspaceRoot, "jobs", jobId, "logs");
    assert.ok(
      existsSync(join(logsDir, "cancel.request")),
      "cancel.request sentinel must be written on abort so the detached runner can kill its child"
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("does not accumulate abort listeners on the signal across poll iterations when never aborted", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-listener-leak";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    // Several 200ms poll intervals will elapse before this budget is exhausted, and the signal
    // is never aborted — each iteration must clean up its own listener rather than piling them up.
    const shortContext = { ...context, timeoutMs: 700 };
    const controller = new AbortController();

    const launchFn = () => ({ terminalKind: "cmd" }); // never writes response.json

    await assert.rejects(
      () => invokeInDebugMode("p", shortContext, config, { jobId, launchFn, signal: controller.signal }),
      (err) => {
        assert.equal(err.code, "DEBUG_TIMEOUT");
        return true;
      }
    );

    const remaining = getEventListeners(controller.signal, "abort").length;
    assert.ok(remaining <= 1, `abort listeners must not accumulate across poll iterations, found ${remaining}`);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("throws a clear timeout error if response.json never appears within the budget", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-invoke-"));
  try {
    const jobId = "job-timeout";
    const { config, context } = baseArgs(workspaceRoot, jobId);
    const shortContext = { ...context, timeoutMs: 300 };

    const launchFn = () => ({ terminalKind: "cmd" }); // never writes response.json

    await assert.rejects(
      () => invokeInDebugMode("p", shortContext, config, { jobId, launchFn }),
      (err) => {
        assert.equal(err.code, "DEBUG_TIMEOUT");
        assert.match(err.message, /timed out/);
        return true;
      }
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
