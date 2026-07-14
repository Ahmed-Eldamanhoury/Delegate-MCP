import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "../src/services/claudeCliService.js";
import { getWorkspaceRoot } from "../src/services/workspaceManager.js";

const BASE_CONTEXT = {
  model: "haiku",
  effort: "low",
  workingDirectory: "C:\\cwd",
  allowedTools: "Read",
  trustAll: false,
  maxBudgetUsd: 1,
  timeoutMs: 2000,
  environment: {},
};

test("Debug OFF (config.debugMode absent): invoke() never creates a logs/ directory or touches the debug launcher", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-branch-off-"));
  try {
    const config = { claudeBin: process.execPath, maxBufferBytes: 1024, workspaceRoot }; // debugMode intentionally absent
    let debugLaunchFnCalled = false;
    const debugLaunchFn = () => {
      debugLaunchFnCalled = true;
      return { terminalKind: "cmd" };
    };

    // A real invoke() call would spawn `process.execPath` with claude-shaped args and fail
    // (node isn't claude) — that's fine, this test only cares that the DEBUG branch was never
    // taken, not that the production call itself succeeds.
    await invoke("hello", BASE_CONTEXT, config, { jobId: "job-off", debugLaunchFn }).catch(() => {});

    assert.equal(debugLaunchFnCalled, false, "debug launcher must never be invoked when debugMode is falsy");
    assert.equal(existsSync(join(getWorkspaceRoot(config), "job-off", "logs")), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("Debug OFF (config.debugMode explicitly false): identical to absent", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-branch-off2-"));
  try {
    const config = { claudeBin: process.execPath, maxBufferBytes: 1024, workspaceRoot, debugMode: false };
    let debugLaunchFnCalled = false;
    const debugLaunchFn = () => {
      debugLaunchFnCalled = true;
      return { terminalKind: "cmd" };
    };

    await invoke("hello", BASE_CONTEXT, config, { jobId: "job-off2", debugLaunchFn }).catch(() => {});

    assert.equal(debugLaunchFnCalled, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("Debug ON (config.debugMode true + jobId present): invoke() routes to the debug path", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-branch-on-"));
  try {
    const jobId = "job-on";
    const config = { claudeBin: "irrelevant.exe", maxBufferBytes: 1024, workspaceRoot, debugMode: true };
    let debugLaunchFnCalled = false;

    const debugLaunchFn = () => {
      debugLaunchFnCalled = true;
      const logsDir = join(getWorkspaceRoot(config), jobId, "logs");
      writeFileSync(join(logsDir, "response.json"), JSON.stringify({ raw: "{}", parsed: {}, exitCode: 0, stderr: "" }));
      return { terminalKind: "cmd" };
    };

    const result = await invoke("hello", BASE_CONTEXT, config, { jobId, debugLaunchFn });

    assert.equal(debugLaunchFnCalled, true, "debug launcher must be invoked when debugMode is true and a jobId is given");
    assert.deepEqual(result, { raw: "{}", parsed: {}, exitCode: 0, stderr: "" });
    assert.ok(existsSync(join(getWorkspaceRoot(config), jobId, "logs", "prompt.txt")));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("Debug ON but no jobId given: falls through to production behavior (no jobId means nowhere to log)", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "debug-branch-nojob-"));
  try {
    const config = { claudeBin: process.execPath, maxBufferBytes: 1024, workspaceRoot, debugMode: true };
    let debugLaunchFnCalled = false;
    const debugLaunchFn = () => {
      debugLaunchFnCalled = true;
      return { terminalKind: "cmd" };
    };

    await invoke("hello", BASE_CONTEXT, config, { debugLaunchFn }).catch(() => {}); // no jobId

    assert.equal(debugLaunchFnCalled, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
