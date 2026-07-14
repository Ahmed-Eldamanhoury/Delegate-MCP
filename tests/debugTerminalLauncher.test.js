import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTerminal, buildLaunchInvocation, launchDebugTerminal } from "../src/services/debugTerminalLauncher.js";

const PATHS = {
  nodeExe: "C:\\Program Files\\nodejs\\node.exe",
  runnerScriptPath: "C:\\Users\\Ahmed Eldamanhoury\\claude-delegate-mcp\\src\\debug\\debugRunner.js",
  invocationJsonPath: "C:\\Users\\Ahmed Eldamanhoury\\claude-delegate-mcp\\workspace\\jobs\\abc-123\\logs\\invocation.json",
  jobId: "abc-123",
};

const PROMPT_MARKER = "SECRET_PROMPT_CONTENT_MUST_NEVER_APPEAR_HERE";

test("detectTerminal prefers Windows Terminal when wt.exe is on PATH", () => {
  const result = detectTerminal("win32", (cmd) => cmd === "wt.exe");
  assert.deepEqual(result, { kind: "windows-terminal" });
});

test("detectTerminal falls back to cmd.exe when wt.exe is absent", () => {
  const result = detectTerminal("win32", () => false);
  assert.deepEqual(result, { kind: "cmd" });
});

test("detectTerminal picks macos-terminal on darwin regardless of PATH", () => {
  const result = detectTerminal("darwin", () => false);
  assert.deepEqual(result, { kind: "macos-terminal" });
});

test("detectTerminal picks the first available Linux terminal emulator in preference order", () => {
  const result = detectTerminal("linux", (cmd) => cmd === "konsole");
  assert.deepEqual(result, { kind: "linux-terminal", command: "konsole" });
});

test("detectTerminal falls back to xterm on Linux when nothing else is found", () => {
  const result = detectTerminal("linux", () => false);
  assert.deepEqual(result, { kind: "linux-terminal", command: "xterm" });
});

for (const kind of ["windows-terminal", "cmd", "macos-terminal", "linux-terminal"]) {
  test(`buildLaunchInvocation(${kind}) never embeds the prompt — argv only contains paths/jobId/fixed flags`, () => {
    const terminal = kind === "linux-terminal" ? { kind, command: "xterm" } : { kind };
    const { command, args } = buildLaunchInvocation(terminal, PATHS);

    assert.ok(command.length > 0);
    assert.ok(args.length > 0);
    const allText = [command, ...args].join(" ");
    assert.ok(!allText.includes(PROMPT_MARKER));
    // every arg is either a fixed literal or one of the paths/jobId this test supplied —
    // nothing else could have been injected.
    for (const arg of args) {
      const isKnownPath = [PATHS.nodeExe, PATHS.runnerScriptPath, PATHS.invocationJsonPath].includes(arg);
      const isJobIdDerived = arg.includes(PATHS.jobId);
      const isFixedFlag = /^[-/\w]*$/.test(arg) || arg === "";
      assert.ok(
        isKnownPath || isJobIdDerived || isFixedFlag,
        `unexpected arg "${arg}" — should only ever be a known path, jobId-derived, or a fixed flag`
      );
    }
  });
}

test("launchDebugTerminal spawns with shell:false and detached:true, and unrefs the child", () => {
  let capturedCall = null;
  const fakeChild = { unref: () => {}, unrefCalled: false };
  fakeChild.unref = () => {
    fakeChild.unrefCalled = true;
  };
  const spawnFn = (command, args, options) => {
    capturedCall = { command, args, options };
    return fakeChild;
  };

  const result = launchDebugTerminal({ ...PATHS, spawnFn, platform: "win32", pathExists: () => false });

  assert.equal(capturedCall.options.shell, false);
  assert.equal(capturedCall.options.detached, true);
  assert.equal(fakeChild.unrefCalled, true);
  assert.equal(result.terminalKind, "cmd"); // pathExists stubbed to report wt.exe absent
});
