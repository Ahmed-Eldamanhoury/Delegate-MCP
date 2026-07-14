import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDebugJob } from "../src/debug/debugRunner.js";

function baseInvocation(logsDir) {
  return {
    jobId: "job-runner-test",
    prompt: "the real prompt",
    model: "haiku",
    effort: "low",
    workingDirectory: "C:\\cwd",
    allowedTools: "Read Grep",
    trustAll: false,
    maxBudgetUsd: 1,
    claudeBin: "C:\\fake\\claude.exe",
    maxBufferBytes: 1024,
    timeoutMs: 5000,
    logsDir,
  };
}

/** Simulates a real claude-shaped stream-json subprocess: emits chunks via the same onStdout/onStderr hooks spawnAndCollect would. */
function fakeSpawnAndCollectFn({ chunks = [], stderrChunks = [], exitCode = 0 } = {}) {
  return async (bin, args, spawnOptions, { onStdout, onStderr }) => {
    let stdout = "";
    for (const chunk of chunks) {
      onStdout(Buffer.from(chunk));
      stdout += chunk;
    }
    let stderr = "";
    for (const chunk of stderrChunks) {
      onStderr(Buffer.from(chunk));
      stderr += chunk;
    }
    return { raw: stdout, exitCode, stderr };
  };
}

test("creates all 7 documented log files with correct content", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    let tick = 0;
    const now = () => `2026-01-01T00:00:0${tick++}.000Z`;
    const streamLines = [
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 5 }) + "\n",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }) + "\n",
      JSON.stringify({ type: "result", result: "hi there", total_cost_usd: 0.02 }) + "\n",
    ];

    const { outcome } = await runDebugJob(baseInvocation(logsDir), {
      spawnAndCollectFn: fakeSpawnAndCollectFn({ chunks: streamLines }),
      now,
    });

    for (const file of ["command.txt", "stdout.log", "stderr.log", "stream.jsonl", "response.json", "metadata.json"]) {
      assert.ok(existsSync(join(logsDir, file)), `${file} must exist`);
    }
    // prompt.txt is written by the parent (debugInvoke.js) before launching, not by the runner —
    // verified separately in debugInvoke.test.js.

    assert.equal(outcome.parsed.result, "hi there");
    assert.equal(outcome.exitCode, 0);

    const commandTxt = readFileSync(join(logsDir, "command.txt"), "utf8");
    assert.match(commandTxt, /claude\.exe/);
    assert.match(commandTxt, /--model/);

    const stdoutLog = readFileSync(join(logsDir, "stdout.log"), "utf8");
    assert.equal(stdoutLog, streamLines.join(""));

    const metadata = JSON.parse(readFileSync(join(logsDir, "metadata.json"), "utf8"));
    assert.equal(metadata.jobId, "job-runner-test");
    assert.equal(metadata.exitCode, 0);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("stream.jsonl preserves ordering and adds a timestamp to every event", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    let tick = 0;
    const now = () => `T${tick++}`;
    const streamLines = [
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1 }) + "\n",
      JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 2 }) + "\n",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }) + "\n",
      JSON.stringify({ type: "result", result: "a" }) + "\n",
    ];

    await runDebugJob(baseInvocation(logsDir), { spawnAndCollectFn: fakeSpawnAndCollectFn({ chunks: streamLines }), now });

    const entries = readFileSync(join(logsDir, "stream.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(entries.length, 4);
    // T0 is consumed by startedAt (called before the stream begins) — the 4 stream events get
    // T1-T4, in the order they arrived.
    assert.deepEqual(
      entries.map((e) => e.timestamp),
      ["T1", "T2", "T3", "T4"]
    );
    assert.deepEqual(
      entries.map((e) => e.event.type),
      ["system", "system", "assistant", "result"]
    );
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("a chunk boundary splitting a stream-json line mid-object still reassembles correctly", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    const fullLine = JSON.stringify({ type: "result", result: "split works" }) + "\n";
    const splitPoint = 10;
    const spawnFn = fakeSpawnAndCollectFn({ chunks: [fullLine.slice(0, splitPoint), fullLine.slice(splitPoint)] });

    const { outcome } = await runDebugJob(baseInvocation(logsDir), { spawnAndCollectFn: spawnFn });

    assert.equal(outcome.parsed.result, "split works");
    const entries = readFileSync(join(logsDir, "stream.jsonl"), "utf8").trim().split("\n");
    assert.equal(entries.length, 1);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("stderr is written to stderr.log", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    await runDebugJob(baseInvocation(logsDir), {
      spawnAndCollectFn: fakeSpawnAndCollectFn({
        chunks: [JSON.stringify({ type: "result", result: "ok" }) + "\n"],
        stderrChunks: ["a warning from claude\n"],
      }),
    });
    assert.equal(readFileSync(join(logsDir, "stderr.log"), "utf8"), "a warning from claude\n");
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("a subprocess failure still writes response.json/metadata.json (never hangs the poller)", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    const spawnFn = async () => {
      throw Object.assign(new Error("claude CLI exited with code 1"), { code: 1 });
    };
    const { outcome } = await runDebugJob(baseInvocation(logsDir), { spawnAndCollectFn: spawnFn });

    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.error, /exited with code 1/);
    assert.ok(existsSync(join(logsDir, "response.json")));
    assert.ok(existsSync(join(logsDir, "metadata.json")));
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("detects the cancel.request sentinel mid-run and aborts its spawned child (kill path), without spawning a real process", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    // Long-running fake: stays pending until its AbortSignal fires — the same signal-based
    // cancellation the real spawnAndCollect turns into a Windows process-tree kill. The abort
    // listener stands in for the fake "kill function" the test asserts was invoked.
    let killed = false;
    const spawnFn = (bin, args, spawnOptions, _opts) =>
      new Promise((_resolve, reject) => {
        spawnOptions.signal.addEventListener(
          "abort",
          () => {
            killed = true;
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true }
        );
      });

    // Simulate the sentinel appearing after the first existence check.
    let checks = 0;
    const existsFn = () => ++checks > 1;

    const { outcome } = await runDebugJob(baseInvocation(logsDir), {
      spawnAndCollectFn: spawnFn,
      existsFn,
      cancelPollMs: 20,
    });

    assert.equal(killed, true, "runDebugJob must invoke its child-kill path when the sentinel appears");
    assert.match(outcome.error, /abort/i);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});

test("banner includes exact command, working directory, model, tools, budget, and job id", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), "debug-runner-"));
  try {
    const { banner } = await runDebugJob(baseInvocation(logsDir), {
      spawnAndCollectFn: fakeSpawnAndCollectFn({ chunks: [JSON.stringify({ type: "result", result: "ok" }) + "\n"] }),
    });

    assert.match(banner, /job id:\s+job-runner-test/);
    assert.match(banner, /command:\s+.*claude\.exe/);
    assert.match(banner, /working directory:\s+C:\\cwd/);
    assert.match(banner, /model:\s+haiku/);
    assert.match(banner, /tools:\s+Read Grep/);
    assert.match(banner, /budget:\s+\$1/);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});
