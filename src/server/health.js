import { access, constants } from "node:fs/promises";

/**
 * Non-blocking startup diagnostic: is the configured claude binary actually reachable?
 * Never throws — a bad path shouldn't crash the server, just gets logged.
 * @param {import("../config/index.js").DelegateConfig} config
 */
export async function checkClaudeBinary(config) {
  try {
    await access(config.claudeBin, constants.F_OK);
    return { ok: true, path: config.claudeBin };
  } catch {
    return {
      ok: false,
      path: config.claudeBin,
      hint: "Set CLAUDE_DELEGATE_BIN or reinstall Claude Code (`where claude`).",
    };
  }
}
