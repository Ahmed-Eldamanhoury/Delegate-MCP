import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

/**
 * Development-only (ADR: none — gated entirely behind `config.debugMode`/`DELEGATE_DEBUG`,
 * additive, does not touch the production spawn path in `claudeCliService.js`).
 *
 * Security invariant this file exists to preserve: the actual prompt text must NEVER appear as
 * part of any command line a shell (cmd.exe, sh, AppleScript's `do script`, ...) re-parses.
 * Every `buildLaunchInvocation()` result below only ever contains: a fixed terminal-launcher
 * flag, a job id (a `randomUUID()` string, never user content), and filesystem paths this
 * process itself constructed (never derived from the prompt). The prompt reaches the actual
 * `claude` invocation only via `invocation.json`, read by `src/debug/debugRunner.js` — which
 * then spawns `claude.exe` the same shell-free way `claudeCliService.spawnAndCollect()` always
 * has. No terminal-launch argv element is ever built from arbitrary/caller-controlled text.
 */

/** @returns {boolean} whether `command` is found on PATH, without spawning anything */
function existsOnPath(command) {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, command)));
}

/**
 * Pure OS/PATH detection — no I/O beyond existsSync checks, no process spawned. Unit-testable
 * by injecting `platform`/`pathExists`.
 * @param {NodeJS.Platform} [platform]
 * @param {(command: string) => boolean} [pathExists]
 * @returns {{kind: "windows-terminal"|"cmd"|"macos-terminal"|"linux-terminal", command?: string}}
 */
export function detectTerminal(platform = process.platform, pathExists = existsOnPath) {
  if (platform === "win32") {
    // Windows Terminal registers via the App Execution Alias mechanism, which is normally on
    // PATH for any machine with it installed (Store or winget) — falls back to cmd.exe only
    // if genuinely absent, per this wave's explicit requirement.
    if (pathExists("wt.exe")) return { kind: "windows-terminal" };
    return { kind: "cmd" };
  }
  if (platform === "darwin") return { kind: "macos-terminal" };

  // Linux: no single universal terminal binary — check common ones in a reasonable preference
  // order, falling back to xterm (present on nearly every X11-capable distro) if none are found.
  const LINUX_CANDIDATES = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"];
  const found = LINUX_CANDIDATES.find((candidate) => pathExists(candidate));
  return { kind: "linux-terminal", command: found ?? "xterm" };
}

/**
 * Pure argv-builder — never touches the prompt, only paths/jobId this process already
 * constructed. `nodeExe` is `process.execPath` (the real node.exe running this server, so no
 * PATH-resolution ambiguity for the debug runner itself).
 * @param {ReturnType<typeof detectTerminal>} terminal
 * @param {{nodeExe: string, runnerScriptPath: string, invocationJsonPath: string, jobId: string}} paths
 * @returns {{command: string, args: string[]}}
 */
export function buildLaunchInvocation(terminal, { nodeExe, runnerScriptPath, invocationJsonPath, jobId }) {
  switch (terminal.kind) {
    case "windows-terminal":
      // `--` marks the end of wt's own flags; everything after is the command to run,
      // passed as an argv array (no shell re-parsing on either wt's or Node's side).
      return { command: "wt.exe", args: ["new-tab", "--title", `delegate-debug-${jobId}`, "--", nodeExe, runnerScriptPath, invocationJsonPath] };

    case "cmd":
      // `start ""` — the empty title is required here, not decorative: `start`'s first
      // quoted argument is taken as the window title, and since `nodeExe` (a real Windows
      // path) will itself need quoting once it contains spaces, an explicit empty title is
      // the standard, documented way to avoid `start` mistaking the program path for one.
      return { command: "cmd.exe", args: ["/c", "start", "", nodeExe, runnerScriptPath, invocationJsonPath] };

    case "macos-terminal":
      // `open -a Terminal` on a real argv array — no AppleScript string re-interpretation.
      return { command: "open", args: ["-a", "Terminal", "--args", nodeExe, runnerScriptPath, invocationJsonPath] };

    case "linux-terminal":
      // `--`/`-e` conventions vary slightly, but every one of these accepts the trailing
      // command as a literal argv, not a shell string.
      return { command: terminal.command, args: ["-e", nodeExe, runnerScriptPath, invocationJsonPath] };

    default:
      throw new Error(`Unknown terminal kind: ${terminal.kind}`);
  }
}

/**
 * Launches the debug runner in a new, visible terminal window. Detached + unref'd: the visible
 * window's lifetime is independent of this MCP server process (closing the server shouldn't
 * yank the debug window away mid-session, and the server shouldn't wait on the window's own
 * process, which for cmd/wt/open exits almost immediately after requesting the new window).
 * @param {{nodeExe?: string, runnerScriptPath: string, invocationJsonPath: string, jobId: string, spawnFn?: typeof spawn, platform?: NodeJS.Platform, pathExists?: (command: string) => boolean}} opts
 * @returns {{terminalKind: string, command: string, args: string[]}}
 */
export function launchDebugTerminal({
  nodeExe = process.execPath,
  runnerScriptPath,
  invocationJsonPath,
  jobId,
  spawnFn = spawn,
  platform = process.platform,
  pathExists = existsOnPath,
}) {
  const terminal = detectTerminal(platform, pathExists);
  const { command, args } = buildLaunchInvocation(terminal, { nodeExe, runnerScriptPath, invocationJsonPath, jobId });
  const child = spawnFn(command, args, { shell: false, detached: true, stdio: "ignore" });
  // A terminal-launch spawn failure (stale/broken binary, permissions, AV interference) fires
  // asynchronously as an "error" event on the child. With no listener, Node treats an
  // unhandled "error" event as an uncaught exception -- crashing the whole MCP server
  // process, including every other in-flight job, not just this debug job. Swallow it here
  // instead; invokeInDebugMode()'s existing response.json poll loop already times this job
  // out safely (DEBUG_TIMEOUT) if the terminal never actually opens.
  child.once("error", () => {});
  child.unref();
  return { terminalKind: terminal.kind, command, args };
}
