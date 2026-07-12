// MCP stdio transport owns stdout for JSON-RPC framing — logs MUST go to stderr only,
// or a stray console.log() here would corrupt the protocol stream and hang the client.

const LEVELS = ["debug", "info", "warn", "error"];

/** @param {string} name @param {{stream?: NodeJS.WritableStream}} [opts] */
export function createLogger(name, { stream = process.stderr } = {}) {
  const log = (level, msg, meta = {}) => {
    stream.write(
      JSON.stringify({ ts: new Date().toISOString(), level, name, msg, ...meta }) + "\n"
    );
  };

  return Object.fromEntries(LEVELS.map((level) => [level, (msg, meta) => log(level, msg, meta)]));
}
